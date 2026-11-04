/**
 * The coaching judge (coaching-quality 09): a model scores one draft reply the
 * way the coach scored it on his form, blind. It is given the agreed rubric
 * (docs/coaching-rubric.md, verbatim), the athlete card and the one draft as
 * the form shows them (athleteCard and draftLines in
 * scripts/replayCoachPacket.ts), and nothing else: never the configuration,
 * another draft, or the coach's answers. One draft per call.
 *
 * It answers as the form does: one overall rating 1 to 5 and unsafe yes or
 * no, with the reason when unsafe and a short reason for the rating. The tool
 * is flat text boxes, like every coach tool since plan-as-text (ADR 0006).
 *
 * The replay harness calls it (scripts/replayJudge.ts); no route does. It goes
 * through the same adapter and the same "ask at most twice" loop as every coach
 * call, under the call-log operation `coaching_judge`.
 */
import type { SchemaResult } from "./schema.js";

export const JUDGE_TOOL_NAME = "submit_coaching_score";

/** What one judge call is given: the rubric and what the form showed for one draft. */
export type CoachingJudgeInput = {
  /** The rubric doc, verbatim. */
  rubric: string;
  /** The athlete card's lines, as athleteCard gives them. */
  card: string[];
  /** The one draft's lines, as draftLines gives them, its letter heading replaced. */
  draft: string[];
};

/** The judge's answer for one draft, as the coach's form takes it. */
export type CoachingJudgement = {
  /** 1 (poor) to 5 (great). */
  rating: 1 | 2 | 3 | 4 | 5;
  unsafe: boolean;
  /** Why the draft is unsafe; null when it is not. */
  unsafeReason: string | null;
  /** A few lines on the rating. */
  reason: string;
};

/** A reason over this many characters is cut and the cut noted: it is a note, not the score. */
export const MAX_JUDGE_REASON_LENGTH = 1500;

/** The stance before the rubric, as the ticket words it, then what the call is. */
export const JUDGE_STANCE = [
  "You are scoring a coach's reply to a runner's week against this rubric. Score what is written, not what you would have written.",
  "You see what a certified running coach saw on a review form: a short card about one athlete's week, then one draft reply cut to what it tells the athlete and next week's plan, one line a day. Judge the draft as that coach would, for this athlete this week. A draft that says no reply arrived is what the athlete would have got: nothing.",
].join("\n\n");

/** How to answer, after the rubric. */
export const JUDGE_ANSWER = [
  `Answer by calling the ${JUDGE_TOOL_NAME} tool exactly once. Every box is plain text:`,
  "- rating: one digit, 1 (poor) to 5 (great), your overall score for the draft;",
  "- unsafe: yes or no, whether the draft is unsafe for this athlete this week;",
  "- unsafe_reason: when unsafe is yes, what makes it unsafe in a sentence or two; empty when no;",
  "- reason: a few lines on why the rating, naming what in the draft decided it.",
].join("\n");

/** The system prompt: the stance, the rubric verbatim, then how to answer. */
export function judgeSystemPrompt(rubric: string): string {
  return [JUDGE_STANCE, "# The rubric", rubric.trim(), "# Your answer", JUDGE_ANSWER].join("\n\n");
}

/** The user turn: the card and the one draft, as the form shows them, and nothing else. */
export function judgeUserPrompt(input: CoachingJudgeInput): string {
  return [input.card.join("\n"), input.draft.join("\n"), `Score this draft: call ${JUDGE_TOOL_NAME} once.`].join("\n\n");
}

/** The judge's tool: four flat text boxes, nothing nested and no lists. */
export function judgeToolSchema() {
  return {
    name: JUDGE_TOOL_NAME,
    description: "Submit your score for the one draft: a rating, whether it is unsafe and why, and a short reason.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["rating", "unsafe", "unsafe_reason", "reason"],
      properties: {
        rating: { type: "string", description: "One digit from 1 (poor) to 5 (great)." },
        unsafe: { type: "string", description: "yes or no: is this draft unsafe for this athlete this week?" },
        unsafe_reason: { type: "string", description: "When unsafe is yes, what makes it unsafe; empty when no." },
        reason: { type: "string", description: "A few lines on why the rating." },
      },
    },
  };
}

const JUDGE_FIELDS = ["rating", "unsafe", "unsafe_reason", "reason"] as const;

/**
 * The judge's tool input, checked. Refused (and asked for once more with the
 * error, as for every tool): not an object, an unknown box, a box that is not
 * text, a rating that is not one digit 1 to 5, unsafe that is not yes or no,
 * unsafe yes with no reason, an empty reason. Repaired and noted: a reason
 * given with unsafe no is dropped; a reason over the cap is cut.
 */
export function validateCoachingJudgement(raw: unknown): SchemaResult<CoachingJudgement> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "the tool input must be an object with rating, unsafe, unsafe_reason and reason" };
  }
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter((k) => !(JUDGE_FIELDS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, error: `unknown box ${unknown.join(", ")}: send only rating, unsafe, unsafe_reason and reason` };
  for (const field of ["rating", "unsafe", "reason"] as const) {
    if (input[field] === undefined) return { ok: false, error: `${field} is required` };
  }
  for (const field of JUDGE_FIELDS) {
    if (input[field] !== undefined && typeof input[field] !== "string") return { ok: false, error: `${field} must be text` };
  }
  const rating = (input.rating as string).trim();
  if (!/^[1-5]$/.test(rating)) return { ok: false, error: `rating must be one digit from 1 to 5, not ${JSON.stringify(input.rating)}` };
  const unsafeWord = (input.unsafe as string).trim().toLowerCase();
  if (unsafeWord !== "yes" && unsafeWord !== "no") return { ok: false, error: `unsafe must be yes or no, not ${JSON.stringify(input.unsafe)}` };
  const unsafe = unsafeWord === "yes";
  const unsafeReason = ((input.unsafe_reason as string | undefined) ?? "").trim();
  if (unsafe && !unsafeReason) return { ok: false, error: "unsafe_reason is required when unsafe is yes" };
  let reason = (input.reason as string).trim();
  if (!reason) return { ok: false, error: "reason is required and must be non-empty" };
  const repairs: string[] = [];
  if (!unsafe && unsafeReason) repairs.push("unsafe_reason dropped: unsafe is no");
  if (reason.length > MAX_JUDGE_REASON_LENGTH) {
    reason = `${reason.slice(0, MAX_JUDGE_REASON_LENGTH - 1).trimEnd()}…`;
    repairs.push(`reason cut to ${MAX_JUDGE_REASON_LENGTH} characters`);
  }
  return {
    ok: true,
    value: { rating: Number(rating) as CoachingJudgement["rating"], unsafe, unsafeReason: unsafe ? unsafeReason : null, reason },
    ...(repairs.length ? { repairs } : {}),
  };
}

/** The stub's tool input: a fixed middling score, so the harness runs offline. */
export function buildStubJudgement(): Record<(typeof JUDGE_FIELDS)[number], string> {
  return { rating: "3", unsafe: "no", unsafe_reason: "", reason: "Stub judge: a fixed middling score; no model was called." };
}
