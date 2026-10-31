/**
 * Replay gate for the reading-flow work (ticket 09).
 *
 * Re-sends every weekly call in the demo snapshot's call log to the live model
 * with today's prompt and tool schema, through the app's own Anthropic port, and
 * writes the old and new replies side by side with a first-pass coverage report.
 * A person still reads the report: the checks only point at what to look at.
 *
 *   cd api
 *   ANTHROPIC_API_KEY=sk-ant-... npm run replay
 *
 * Calls run one at a time, on the model each original call used. A call whose
 * output file already exists is skipped, so an interrupted run can be resumed.
 * Pass --report-only to rebuild the report from the saved replies, or
 * --dry-run to exercise the whole run with the offline stub, at no cost, into a
 * separate folder.
 *
 * Pass --packets <dir> to replay a folder of packets instead of the demo
 * snapshot, such as the synthetic seasons that are not marathon blocks:
 *
 *   npm run replay -- --packets tests/fixtures/replay-packets --dry-run
 *
 * The folder holds one JSON file per weekly call, replayed in file-name order.
 * Each file is a model packet as the app builds it, with the athlete's goal in
 * its `goal` field, or `{ "packet": {...}, "model": "..." }` to pin the model
 * (otherwise ANTHROPIC_MODEL or the port's default). A packet has no old reply,
 * so its report shows the new reply only. Replies and the report go to
 * .scratch/replay-packets/<folder name> (with -dry-run on a dry run).
 * Pass --out <dir> to write somewhere else, with either source.
 *
 * A reply refused for its shape is asked for once more, as the app does (ADR
 * 0002). The saved reply lists the refused attempt in `refusedAttempts`, and the
 * report lists retried calls apart from failed ones. On a dry run, a wrapped
 * packet's `stubRefusals` (a count) makes the stub refuse that many attempts
 * first, so the retry can be tested offline; a live run ignores it.
 *
 * Every report opens with three goal checks, each naming the read that failed:
 * a packet with no goal line (no goal, or the rebuilt prompt does not open with
 * "Athlete goal:"); "marathon" in a read whose goal is not a marathon; and a
 * long-run verdict in a read whose goal is stay fit. A refused reply also fails,
 * since it leaves a read unchecked. The checks read every athlete-facing word:
 * headline, flags, answers, the read, the days, safety callouts and About you
 * proposals. The script exits non-zero when any check fails. The dry run over tests/fixtures/replay-packets runs in
 * the API test suite (tests/replay-weekly-reads.test.ts).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TrainingGoal } from "../src/goal/types.js";
import { createAnthropicLlmPort, weeklyUserPromptFor } from "../src/llm/anthropic.js";
import { askOnceMore } from "../src/llm/askOnceMore.js";
import { LlmSchemaError } from "../src/llm/port.js";
import { createStubLlmPort } from "../src/llm/stub.js";
import type { PrescribedDay, WeeklyReply } from "../src/llm/types.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/types.js";
import type { ModelPacket } from "../src/packet/types.js";
import { replayCheckFailures, type ReplayCheckFailure } from "./replayChecks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.resolve(here, "../../demo/snapshot.sql");
const reportOnly = process.argv.includes("--report-only");
const dryRun = process.argv.includes("--dry-run");

/** The value after a flag such as --packets, resolved from the working directory. */
function flagPath(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a folder`);
  return path.resolve(value);
}

const PACKETS = flagPath("--packets");
const OUT =
  flagPath("--out") ??
  (PACKETS
    ? path.resolve(here, `../../.scratch/replay-packets/${path.basename(PACKETS)}${dryRun ? "-dry-run" : ""}`)
    : path.resolve(here, `../../.scratch/reading-flow/${dryRun ? "replay-dry-run" : "replay"}`));

// ---- Reading the snapshot ---------------------------------------------------

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "\\": "\\" };

/** One field of a Postgres COPY text row. */
function unescapeCopy(field: string): string | null {
  if (field === "\\N") return null;
  return field.replace(/\\(?:([ntrbfv\\])|([0-7]{1,3})|(.))/g, (_m, esc, oct, other) =>
    esc ? ESCAPES[esc]! : oct ? String.fromCharCode(parseInt(oct, 8)) : other,
  );
}

function copyTable(sql: string, table: string): Array<Record<string, string | null>> {
  const lines = sql.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`COPY public.${table} `));
  if (start < 0) throw new Error(`No ${table} table in the snapshot`);
  const header = lines[start]!;
  const columns = header.slice(header.indexOf("(") + 1, header.indexOf(")")).split(", ");
  const rows: Array<Record<string, string | null>> = [];
  for (let i = start + 1; lines[i] !== "\\."; i++) {
    const fields = lines[i]!.split("\t").map(unescapeCopy);
    rows.push(Object.fromEntries(columns.map((c, j) => [c, fields[j] ?? null])));
  }
  return rows;
}

type StoredCall = {
  /** Where the call came from: the snapshot's call time, or the packet's file name. */
  source: string;
  createdAt: string | null;
  model: string | undefined;
  packet: ModelPacket;
  old: Record<string, unknown> | null;
  /** Dry run only: how many attempts the stub refuses for their shape first. */
  stubRefusals?: number;
};

function storedWeeklyCalls(): StoredCall[] {
  const rows = copyTable(readFileSync(SNAPSHOT, "utf8"), "llm_call_log")
    .filter((r) => r.operation === "weekly_reply" && r.outcome !== "failed")
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return rows.map((r) => {
    const request = JSON.parse(r.request!) as { messages: Array<{ content: string }> };
    const content = request.messages[0]!.content;
    const marker = content.indexOf("Model packet");
    const packet = JSON.parse(content.slice(content.indexOf("\n", marker) + 1)) as ModelPacket;
    const response = JSON.parse(r.response_raw!) as {
      content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
    };
    const old = response.content.find((b) => b.type === "tool_use" && b.name === "submit_weekly_reply")?.input;
    if (!old) throw new Error(`Call at ${r.created_at} has no weekly reply`);
    return { source: `snapshot call at ${r.created_at}`, createdAt: r.created_at!, model: r.model!, packet, old };
  });
}

// ---- Reading a packet folder ------------------------------------------------

function folderCalls(dir: string): StoredCall[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`No .json packets in ${dir}`);
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
    const wrapped = raw.packet && typeof raw.packet === "object";
    const packet = (wrapped ? raw.packet : raw) as ModelPacket;
    const model = wrapped && typeof raw.model === "string" ? raw.model : process.env.ANTHROPIC_MODEL?.trim() || undefined;
    const stubRefusals = wrapped && typeof raw.stubRefusals === "number" ? raw.stubRefusals : 0;
    return { source: f, createdAt: null, model, packet, old: null, stubRefusals };
  });
}

// ---- Replaying --------------------------------------------------------------

/** Keeps the call's log row in memory, for its repairs and token counts. */
function memoryRecorder(rows: LlmCallRecord[]): LlmCallRecorder {
  return {
    async record(row) {
      rows.push(row);
    },
    async get() {
      return null;
    },
    async list() {
      return [];
    },
    async *exportAll() {},
  };
}

/** One attempt refused for its shape. */
type Refusal = {
  attempt: number;
  error: string;
  outcome: string | null;
  stopReason: string | null;
  outputTokens: number | null;
  responseRaw: unknown;
};

async function replay(calls: StoredCall[]): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey && !dryRun) {
    throw new Error("Set ANTHROPIC_API_KEY to run the replay, or pass --dry-run or --report-only.");
  }
  for (const [i, call] of calls.entries()) {
    const file = path.join(OUT, `${String(i + 1).padStart(2, "0")}.json`);
    const failedFile = file.replace(/\.json$/, ".failed.json");
    if (existsSync(file)) {
      console.log(`${path.basename(file)} exists, skipped`);
      continue;
    }
    const log: LlmCallRecord[] = [];
    const port = dryRun
      ? createStubLlmPort()
      : createAnthropicLlmPort({
          model: call.model,
          readApiKey: async () => apiKey!,
          recorder: memoryRecorder(log),
        });
    const started = Date.now();
    // Each attempt refused for its shape, with what the model sent for it.
    const refusals: Refusal[] = [];
    let stubRefusalsLeft = dryRun ? (call.stubRefusals ?? 0) : 0;
    let reply: WeeklyReply;
    try {
      // Asked once more when refused for its shape, as the app does (ADR 0002).
      const result = await askOnceMore(async (attempt) => {
        const logged = log.length;
        try {
          if (stubRefusalsLeft > 0) {
            stubRefusalsLeft--;
            throw new LlmSchemaError("stub refusal: analysis is required and must be non-empty");
          }
          // The port writes its log row, with any repairs and token counts, only for a call with an id.
          return { ok: true as const, value: await port.generateWeeklyReply(call.packet, { callId: randomUUID() }) };
        } catch (err) {
          if (err instanceof LlmSchemaError) {
            const row = log.length > logged ? log.at(-1) : undefined;
            refusals.push({
              attempt,
              error: err.message,
              outcome: row?.outcome ?? null,
              stopReason: row?.stopReason ?? null,
              outputTokens: row?.outputTokens ?? null,
              responseRaw: row?.responseRaw ?? null,
            });
          }
          throw err;
        }
      });
      if (!result.ok) throw new LlmSchemaError(result.error);
      reply = result.value;
    } catch (err) {
      // A refused reply is a finding, not a reason to stop: keep what the model sent and move on.
      const failed = log.at(-1);
      writeFileSync(
        failedFile,
        JSON.stringify(
          {
            source: call.source,
            originalCallAt: call.createdAt,
            model: call.model ?? null,
            replayedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
            outcome: failed?.outcome ?? null,
            stopReason: failed?.stopReason ?? null,
            outputTokens: failed?.outputTokens ?? null,
            responseRaw: failed?.responseRaw ?? null,
            // Every attempt refused for its shape, the last one included.
            refusedAttempts: refusals,
          },
          null,
          2,
        ),
      );
      console.log(`${path.basename(file)} refused: ${err instanceof Error ? err.message : err}; saved ${path.basename(failedFile)}`);
      continue;
    }
    const row = log.at(-1);
    writeFileSync(
      file,
      JSON.stringify(
        {
          source: call.source,
          originalCallAt: call.createdAt,
          model: call.model ?? null,
          replayedAt: new Date().toISOString(),
          // What the goal checks read: the packet's goal and the rebuilt prompt's first line.
          goal: call.packet.goal ?? null,
          promptHead: weeklyUserPromptFor(call.packet).split("\n", 1)[0],
          outcome: row?.outcome ?? null,
          repairs: row?.errorMessage ?? null,
          inputTokens: row?.inputTokens ?? null,
          outputTokens: row?.outputTokens ?? null,
          // Attempts refused for their shape before this reply came back; empty when none.
          refusedAttempts: refusals,
          old: call.old,
          new: reply,
        },
        null,
        2,
      ),
    );
    const retriedNote = refusals.length ? ` after asking once more (${refusals[0]!.error})` : "";
    console.log(`${path.basename(file)} done in ${Math.round((Date.now() - started) / 1000)} s${retriedNote}`);
  }
}

// ---- The first-pass coverage report -------------------------------------------

type Saved = {
  /** Missing on replies saved before packet folders existed. */
  source?: string;
  originalCallAt: string | null;
  model: string | null;
  goal?: TrainingGoal | null;
  promptHead?: string;
  outcome: string | null;
  repairs: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Missing on replies saved before the replay asked once more. */
  refusedAttempts?: Refusal[];
  /** Null for a packet from a folder: it has no earlier reply. */
  old: { analysis: string; prescribedWeek: { days: PrescribedDay[] } } | null;
  new: WeeklyReply;
};

/** Figures worth tracking: anything with a decimal point or colon, or two or more digits. */
function figures(text: string): string[] {
  const found = text.replace(/[–—]/g, "-").match(/\d+(?:[.:]\d+)*/g) ?? [];
  return [...new Set(found.filter((f) => /[.:]/.test(f) || f.length >= 2))];
}

function dayText(days: PrescribedDay[]): string {
  return days
    .map((d) => [d.notes, d.strength, d.run?.structure, d.run?.paceOrHr, d.run?.shoes].filter(Boolean).join(" "))
    .join("\n");
}

/** Questions the old read answered: bold numbered lines, or "Your question — …" headings. */
function oldQuestions(analysis: string): string[] {
  const bold = [...analysis.matchAll(/^\*\*\d+\.\s*(.+?)\*\*/gm)].map((m) => m[1]!);
  const headed = [...analysis.matchAll(/^##+\s*(?:Your question|Answer to your question)\s*[—–-]?\s*(.*)$/gim)]
    .map((m) => m[1]!.trim())
    .filter(Boolean);
  return [...bold, ...headed];
}

/** Bullets under the old read's per-session heading. */
function oldSessionReasons(analysis: string): string[] {
  const section = /^##+\s*(?:Why (?:each session|these sessions)|How to read this week)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(analysis);
  return section ? [...section[1]!.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((m) => m[1]!) : [];
}

/** Numbered files in the output folder, such as 01.json, in order. */
function numbered(suffix: string): string[] {
  const pattern = new RegExp(`^\\d+${suffix.replace(/\./g, "\\.")}$`);
  return readdirSync(OUT)
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => path.join(OUT, f));
}

/** Builds the report and returns the goal checks that failed. */
function report(): ReplayCheckFailure[] {
  const files = numbered(".json");
  const sections: string[] = [];
  const checkFailures: ReplayCheckFailure[] = [];
  // Replies that came back only when asked once more.
  const retried: string[] = [];
  for (const file of files) {
    const s = JSON.parse(readFileSync(file, "utf8")) as Saved;
    const n = s.new;
    const old = s.old;
    const name = path.basename(file, ".json");
    // Names the packet: its file in a folder, or the original call's date in the snapshot.
    const label = s.originalCallAt
      ? `${name} (week read on ${s.originalCallAt.slice(0, 10)})`
      : `${name} (${s.source ?? "unknown packet"})`;
    const newText = [
      n.headline,
      ...(n.flags ?? []).flatMap((f) => [f.title, f.detail]),
      ...(n.answers ?? []).flatMap((a) => [a.question, a.answer]),
      n.analysis,
      dayText(n.prescribedWeek.days),
      ...(n.safetyCallouts ?? []).map((c) => JSON.stringify(c)),
      ...(n.settingsProposalBullets ?? []),
    ].join("\n");
    const goal = s.goal ?? null;
    const failed = replayCheckFailures({ label, goal, prompt: s.promptHead ?? "", readText: newText });
    checkFailures.push(...failed);
    const refusals = s.refusedAttempts ?? [];
    const retryNote = refusals.length
      ? `Asked once more: ${refusals.map((r) => `attempt ${r.attempt} refused (${r.error}; stop reason ${r.stopReason})`).join("; ")}.`
      : null;
    if (retryNote) retried.push(`- ${label}: ${retryNote}`);
    const normalized = newText.replace(/[–—]/g, "-");
    const missing = old ? figures(old.analysis).filter((f) => !normalized.includes(f)) : [];
    const questions = old ? oldQuestions(old.analysis) : [];
    const reasons = old ? oldSessionReasons(old.analysis) : [];
    const daysWithNotes = n.prescribedWeek.days.filter((d) => d.notes?.trim()).length;
    const repeatsHeadline = n.analysis.includes(n.headline.slice(0, 60));
    const listsDays =
      /^\s*[-*]\s+\**(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/m.test(n.analysis) ||
      /^\|\s*\**(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/m.test(n.analysis);
    const standAlone = [...(n.flags ?? []).map((f) => f.detail), ...(n.answers ?? []).map((a) => a.answer)];
    // A reference to another part, such as "the table above" or "see below", not "below the 80% target".
    const pointsAcross = standAlone.some((t) =>
      /\b(?:table|list|section|chart|plan|notes?)\s+(?:above|below)\b|\b(?:see|as)\s+(?:above|below)\b|\b(?:above|below)\s*[.,;)]/i.test(t),
    );
    const tableRows = (text: string) =>
      text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|") && !/^\|[\s|:-]+\|$/.test(l) && l.length > 20);
    const analysisRows = new Set(tableRows(n.analysis));
    const repeatsAnswerTable = (n.answers ?? []).some((a) => tableRows(a.answer).some((r) => analysisRows.has(r)));
    const banned = bannedTermsIn(newText);

    const heading = s.originalCallAt
      ? `## ${name}: week read on ${s.originalCallAt.slice(0, 10)}`
      : `## ${label}`;
    sections.push(
      heading,
      "",
      `Model ${s.model ?? "default"}. Outcome ${s.outcome}${s.repairs ? ` (${s.repairs})` : ""}. Tokens in ${s.inputTokens}, out ${s.outputTokens}.`,
      "",
      ...(retryNote ? [retryNote, ""] : []),
      `Goal: ${goal ?`${goal.kind}${goal.distance ? ` (${goal.distance})` : ""}` : "none"}. Goal checks: ${failed.length ? failed.map((f) => f.check).join(", ") : "passed"}.`,
      "",
      "| Check | Old | New |",
      "|---|---|---|",
      `| Read length (characters) | ${old?.analysis.length ?? ""} | ${n.analysis.length} |`,
      `| Headline | | ${n.headline.length} chars |`,
      `| Flags | | ${n.flags?.length ?? 0} |`,
      `| Questions answered | ${old ? questions.length : ""} | ${n.answers?.length ?? 0} |`,
      `| Session reasons | ${old ? `${reasons.length} in the read` : ""} | ${daysWithNotes} days with notes |`,
      `| Read repeats the headline | | ${repeatsHeadline ? "yes" : "no"} |`,
      `| Read lists the days (as a list or a table) | | ${listsDays ? "yes" : "no"} |`,
      `| A flag or answer points "above" or "below" | | ${pointsAcross ? "yes" : "no"} |`,
      `| Read repeats an answer's table | | ${repeatsAnswerTable ? "yes" : "no"} |`,
      `| Internal words | | ${banned.length ? banned.join(", ") : "none"} |`,
      "",
      ...(old
        ? [
            `Figures in the old read not found anywhere in the new reply: ${missing.length ? missing.join(", ") : "none"}`,
            "",
            "Old questions:",
            ...(questions.length ? questions.map((q) => `- ${q}`) : ["- none found"]),
            "",
          ]
        : []),
      "New answers to:",
      ...((n.answers ?? []).length ? n.answers!.map((a) => `- ${a.question}`) : ["- none"]),
      "",
      "Verdict: _to be judged_",
      "",
    );
  }
  const refused = numbered(".failed.json").filter((f) => !existsSync(f.replace(/\.failed\.json$/, ".json")));
  // A refused reply has no read to check, so it cannot pass the gate either.
  for (const f of refused) {
    const d = JSON.parse(readFileSync(f, "utf8")) as { source?: string; originalCallAt: string | null };
    const name = path.basename(f, ".failed.json");
    const label = d.originalCallAt
      ? `${name} (week read on ${d.originalCallAt.slice(0, 10)})`
      : `${name} (${d.source ?? "unknown packet"})`;
    checkFailures.push({ label, check: "refused reply", detail: "no read to check; replay it again" });
  }
  const out: string[] = [
    "# Replay gate: first-pass report",
    "",
    `Generated ${new Date().toISOString()} from ${files.length} replayed weekly calls${PACKETS ? ` in ${PACKETS}` : ""}.`,
    "",
    "The checks below only point at what to read. A figure listed as missing may be rounded, restated or deliberately dropped; each one is judged by a person before the gate passes.",
    "",
    "## Goal checks",
    "",
    ...(checkFailures.length
      ? checkFailures.map((f) => `- ${f.label}: ${f.check}: ${f.detail}`)
      : ["All passed: every packet has a goal line, no non-marathon read says marathon, no stay-fit read gives a long-run verdict, and no reply was refused."]),
    "",
    ...sections,
  ];
  if (retried.length > 0) {
    out.push("## Retried replies", "", "Refused for their shape, then came back when asked once more, as the app does.", "", ...retried, "");
  }
  if (refused.length > 0) {
    out.push("## Refused replies", "");
    for (const f of refused) {
      const d = JSON.parse(readFileSync(f, "utf8")) as {
        source?: string;
        originalCallAt: string | null;
        error: string;
        stopReason: string | null;
        /** Missing on failures saved before the replay asked once more. */
        refusedAttempts?: Refusal[];
      };
      const what = d.originalCallAt ? `week read on ${d.originalCallAt.slice(0, 10)}` : d.source;
      const attempts = d.refusedAttempts?.length ?? 0;
      const tries = attempts > 1 ? ` (refused on all ${attempts} attempts)` : "";
      out.push(`- ${path.basename(f)} (${what}): ${d.error}; stop reason ${d.stopReason}${tries}`);
    }
    out.push("");
  }
  writeFileSync(path.join(OUT, "report.md"), out.join("\n"));
  console.log(`report written to ${path.join(OUT, "report.md")}`);
  return checkFailures;
}

mkdirSync(OUT, { recursive: true });
if (!reportOnly) await replay(PACKETS ? folderCalls(PACKETS) : storedWeeklyCalls());
const checkFailures = report();
if (checkFailures.length > 0) {
  console.error(`${checkFailures.length} goal check${checkFailures.length === 1 ? "" : "s"} failed:`);
  for (const f of checkFailures) console.error(`- ${f.label}: ${f.check}: ${f.detail}`);
  process.exitCode = 1;
}
