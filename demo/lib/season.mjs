/**
 * Plays Johnny's season through the real API, following demo/athlete-script.json.
 * Each step runs through runStep, which pins the clock first (the API reads it once, at
 * startup) and records the real time it took.
 */
import { api, ApiError, sleep } from "./api.mjs";
import { runStep } from "./steps.mjs";

const REPLY_TIMEOUT_MS = 20 * 60_000;

/**
 * POST that the live model answers. A 502 means the model's output failed validation.
 * Only for routes that leave nothing behind when the reply fails: onboarding upserts its
 * answers, and chat removes the unanswered message (#5).
 */
async function postToModel(route, body, label) {
  for (let attemptNo = 0; ; attemptNo += 1) {
    try {
      return await api("POST", route, body);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 502 || attemptNo >= REPLY_RETRIES) throw err;
      console.log(`${label}: model output rejected (${err.body?.message ?? err.body?.error}), retry ${attemptNo + 1} of ${REPLY_RETRIES}`);
    }
  }
}

async function currentWeekSession() {
  const { json } = await api("POST", "/weeks/current");
  return json;
}

/** How many times a failed weekly reply is retried before the build stops. */
const REPLY_RETRIES = 2;

/**
 * Wait for the weekly reply. The live model sometimes returns output the API rejects
 * (e.g. a safety notice over the length limit); retry those like the athlete would.
 */
async function waitForReply(weekSessionId, label) {
  let retries = 0;
  const started = Date.now();
  for (;;) {
    const { json } = await api("GET", `/weeks/${weekSessionId}/reply-run`);
    const run = json?.run;
    if (run?.status === "ok") return run;
    if (run?.status === "failed") {
      if (retries >= REPLY_RETRIES) {
        throw new Error(`${label}: reply run failed ${retries + 1} times, last: ${run.errorMessage}`);
      }
      retries += 1;
      console.log(`${label}: reply failed (${run.errorMessage}), retry ${retries} of ${REPLY_RETRIES}`);
      await api("POST", `/weeks/${weekSessionId}/reply-run/retry`);
    }
    if (Date.now() - started > REPLY_TIMEOUT_MS * (retries + 1)) throw new Error(`${label}: reply run timed out`);
    await sleep(1500);
  }
}

async function pendingNoteCards() {
  const { json } = await api("GET", "/dossier/proposals");
  return json.proposals;
}

/** Accept every pending note card ("Looks right"). Returns how many were accepted. */
async function acceptPendingNoteCards() {
  const pending = await pendingNoteCards();
  for (const p of pending) {
    await api("POST", `/dossier/proposals/${p.id}/accept`, {});
  }
  return pending.length;
}

export async function playOnboarding(script) {
  const { onboarding } = script;
  return runStep({ week: 0, label: "onboarding", at: onboarding.at }, async () => {
    await api("POST", "/disclaimer/accept");
    if (process.env.LLM_PROVIDER === "anthropic") {
      await api("PUT", "/settings/anthropic", { apiKey: process.env.ANTHROPIC_API_KEY });
    }
    const session = await currentWeekSession();
    const { json } = await postToModel(
      "/onboarding/answers",
      { answers: onboarding.answers, weekSessionId: session.id },
      "onboarding",
    );
    if (onboarding.acceptOnboardingNoteCard) {
      await api("POST", `/dossier/proposals/${json.proposal.id}/accept`, {});
    }
    console.log("onboarding: About you drafted and accepted");
  });
}

/** Check-in, then Coach Cade's read and next week's plan; the athlete opens the plan. */
export async function playWeek(script, entry) {
  const { week, isoWeek, checkIn } = entry;
  const label = `week ${week}`;
  return runStep({ week, label, at: checkIn.at }, async () => {
    const session = await currentWeekSession();
    if (session.isoWeek !== isoWeek) {
      throw new Error(`${label}: expected ${isoWeek} at ${checkIn.at}, the API says ${session.isoWeek}`);
    }
    await api("POST", `/weeks/${session.id}/recap/subjective`, {
      week: isoWeek,
      runs: checkIn.runs,
      weekly: checkIn.weekly,
    });
    await waitForReply(session.id, label);
    await api("POST", `/weeks/${session.id}/reply-run/seen`);
    const accepted = script.noteCards.weeks1to10 === "accept" ? await acceptPendingNoteCards() : 0;
    console.log(`${label}: check-in saved, reply ok, ${accepted} note card(s) accepted`);
  });
}

async function findRun({ date, name }) {
  const { json } = await api(
    "GET",
    `/tempo/workouts?startDate=${date}T00:00:00Z&endDate=${date}T23:59:59Z&pageSize=20`,
  );
  const run = json.items.find((r) => r.name === name);
  if (!run) throw new Error(`no run "${name}" on ${date}`);
  return run.id;
}

async function chat(script, message, { acceptAfter }) {
  return runStep({ week: 11, label: `chat ${message.at}`, at: message.at }, async () => {
    const session = await currentWeekSession();
    if (session.isoWeek !== script.week11.isoWeek) {
      throw new Error(`week 11: expected ${script.week11.isoWeek}, the API says ${session.isoWeek}`);
    }
    const body = { body: message.body };
    if (message.attachRun) body.attachmentWorkoutId = await findRun(message.attachRun);
    await postToModel(`/weeks/${session.id}/chat`, body, `week 11 chat ${message.at.slice(0, 16)}`);
    const accepted = acceptAfter ? await acceptPendingNoteCards() : 0;
    console.log(`week 11 chat ${message.at.slice(0, 16)}: sent${message.attachRun ? " with a run" : ""}, ${accepted} note card(s) accepted`);
  });
}

/**
 * Week 11, Monday to Wednesday evening. Note cards from Monday and Tuesday are accepted so
 * only what Wednesday's reply proposes is left pending (the About you shot).
 */
export async function playWeek11(script) {
  const { messages, fallbackIfNoNoteCard } = script.week11;
  let clock = null;
  for (const [i, message] of messages.entries()) {
    const last = i === messages.length - 1;
    clock = await chat(script, message, { acceptAfter: !last });
  }
  let pending = await pendingNoteCards();
  if (pending.length === 0) {
    console.log("week 11: no note card after Wednesday's message, sending the audit fallback");
    clock = await chat(script, fallbackIfNoNoteCard, { acceptAfter: false });
    pending = await pendingNoteCards();
  }
  if (pending.length !== 1) {
    console.warn(`WARNING: expected exactly 1 pending note card, found ${pending.length}. Review before publishing.`);
  } else {
    console.log("week 11: 1 note card left pending");
  }
  return clock;
}
