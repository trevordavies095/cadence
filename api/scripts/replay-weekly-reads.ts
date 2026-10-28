/**
 * Replay gate for the reading-flow work (ticket 09).
 *
 * Re-sends every weekly call in the demo snapshot's call log to the live model
 * with today's prompt and tool schema, through the app's own Anthropic port, and
 * writes the old and new replies side by side with a first-pass coverage report.
 * A person still reads the report: the checks only point at what to look at.
 *
 *   cd api
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/replay-weekly-reads.ts
 *
 * Calls run one at a time, on the model each original call used. A call whose
 * output file already exists is skipped, so an interrupted run can be resumed.
 * Pass --report-only to rebuild the report from the saved replies, or
 * --dry-run to exercise the whole run with the offline stub, at no cost, into a
 * separate folder.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropicLlmPort } from "../src/llm/anthropic.js";
import { createStubLlmPort } from "../src/llm/stub.js";
import type { PrescribedDay, WeeklyReply } from "../src/llm/types.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/types.js";
import type { ModelPacket } from "../src/packet/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.resolve(here, "../../demo/snapshot.sql");
const reportOnly = process.argv.includes("--report-only");
const dryRun = process.argv.includes("--dry-run");
const OUT = path.resolve(here, `../../.scratch/reading-flow/${dryRun ? "replay-dry-run" : "replay"}`);

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

type StoredCall = { createdAt: string; model: string; packet: ModelPacket; old: Record<string, unknown> };

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
    return { createdAt: r.created_at!, model: r.model!, packet, old };
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

async function replay(calls: StoredCall[]): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey && !dryRun) {
    throw new Error("Set ANTHROPIC_API_KEY to run the replay, or pass --dry-run or --report-only.");
  }
  for (const [i, call] of calls.entries()) {
    const file = path.join(OUT, `${String(i + 1).padStart(2, "0")}.json`);
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
    // The port writes its log row, with any repairs and token counts, only for a call with an id.
    const reply = await port.generateWeeklyReply(call.packet, { callId: randomUUID() });
    const row = log.at(-1);
    writeFileSync(
      file,
      JSON.stringify(
        {
          originalCallAt: call.createdAt,
          model: call.model,
          replayedAt: new Date().toISOString(),
          outcome: row?.outcome ?? null,
          repairs: row?.errorMessage ?? null,
          inputTokens: row?.inputTokens ?? null,
          outputTokens: row?.outputTokens ?? null,
          old: call.old,
          new: reply,
        },
        null,
        2,
      ),
    );
    console.log(`${path.basename(file)} done in ${Math.round((Date.now() - started) / 1000)} s`);
  }
}

// ---- The first-pass coverage report -------------------------------------------

type Saved = {
  originalCallAt: string;
  model: string;
  outcome: string | null;
  repairs: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  old: { analysis: string; prescribedWeek: { days: PrescribedDay[] } };
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

function report(): void {
  const files = Array.from({ length: 10 }, (_, i) => path.join(OUT, `${String(i + 1).padStart(2, "0")}.json`)).filter(
    existsSync,
  );
  const out: string[] = [
    "# Replay gate: first-pass report",
    "",
    `Generated ${new Date().toISOString()} from ${files.length} replayed weekly calls.`,
    "",
    "The checks below only point at what to read. A figure listed as missing may be rounded, restated or deliberately dropped; each one is judged by a person before the gate passes.",
    "",
  ];
  for (const file of files) {
    const s = JSON.parse(readFileSync(file, "utf8")) as Saved;
    const n = s.new;
    const newText = [
      n.headline,
      ...(n.flags ?? []).flatMap((f) => [f.title, f.detail]),
      ...(n.answers ?? []).flatMap((a) => [a.question, a.answer]),
      n.analysis,
      dayText(n.prescribedWeek.days),
    ].join("\n");
    const normalized = newText.replace(/[–—]/g, "-");
    const missing = figures(s.old.analysis).filter((f) => !normalized.includes(f));
    const questions = oldQuestions(s.old.analysis);
    const reasons = oldSessionReasons(s.old.analysis);
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

    out.push(
      `## ${path.basename(file, ".json")}: week read on ${s.originalCallAt.slice(0, 10)}`,
      "",
      `Model ${s.model}. Outcome ${s.outcome}${s.repairs ? ` (${s.repairs})` : ""}. Tokens in ${s.inputTokens}, out ${s.outputTokens}.`,
      "",
      "| Check | Old | New |",
      "|---|---|---|",
      `| Read length (characters) | ${s.old.analysis.length} | ${n.analysis.length} |`,
      `| Headline | | ${n.headline.length} chars |`,
      `| Flags | | ${n.flags?.length ?? 0} |`,
      `| Questions answered | ${questions.length} | ${n.answers?.length ?? 0} |`,
      `| Session reasons | ${reasons.length} in the read | ${daysWithNotes} days with notes |`,
      `| Read repeats the headline | | ${repeatsHeadline ? "yes" : "no"} |`,
      `| Read lists the days (as a list or a table) | | ${listsDays ? "yes" : "no"} |`,
      `| A flag or answer points "above" or "below" | | ${pointsAcross ? "yes" : "no"} |`,
      `| Read repeats an answer's table | | ${repeatsAnswerTable ? "yes" : "no"} |`,
      `| Internal words | | ${banned.length ? banned.join(", ") : "none"} |`,
      "",
      `Figures in the old read not found anywhere in the new reply: ${missing.length ? missing.join(", ") : "none"}`,
      "",
      "Old questions:",
      ...(questions.length ? questions.map((q) => `- ${q}`) : ["- none found"]),
      "",
      "New answers to:",
      ...((n.answers ?? []).length ? n.answers!.map((a) => `- ${a.question}`) : ["- none"]),
      "",
      "Verdict: _to be judged_",
      "",
    );
  }
  writeFileSync(path.join(OUT, "report.md"), out.join("\n"));
  console.log(`report written to ${path.join(OUT, "report.md")}`);
}

mkdirSync(OUT, { recursive: true });
if (!reportOnly) await replay(storedWeeklyCalls());
report();
