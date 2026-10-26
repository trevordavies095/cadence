/**
 * Plays Johnny's season through the real API, following demo/athlete-script.json.
 * Each step pins the clock first (the API reads it once, at startup).
 */
import { api, setClock, sleep } from "./api.mjs";

const REPLY_TIMEOUT_MS = 20 * 60_000;

async function currentWeekSession() {
  const { json } = await api("POST", "/weeks/current");
  return json;
}

async function waitForReply(weekSessionId, label) {
  const started = Date.now();
  for (;;) {
    const { json } = await api("GET", `/weeks/${weekSessionId}/reply-run`);
    const status = json?.run?.status;
    if (status === "ok") return json.run;
    if (status === "failed") throw new Error(`${label}: reply run failed: ${JSON.stringify(json.run)}`);
    if (Date.now() - started > REPLY_TIMEOUT_MS) throw new Error(`${label}: reply run timed out`);
    await sleep(1500);
  }
}

/** Accept every pending note card ("Looks right"). Returns how many were accepted. */
async function acceptPendingNoteCards() {
  const { json } = await api("GET", "/dossier/proposals");
  for (const p of json.proposals) {
    await api("POST", `/dossier/proposals/${p.id}/accept`, {});
  }
  return json.proposals.length;
}

export async function playOnboarding(script) {
  const { onboarding } = script;
  setClock(onboarding.at);
  await api("POST", "/disclaimer/accept");
  const session = await currentWeekSession();
  const { json } = await api("POST", "/onboarding/answers", {
    answers: onboarding.answers,
    weekSessionId: session.id,
  });
  if (onboarding.acceptOnboardingNoteCard) {
    await api("POST", `/dossier/proposals/${json.proposal.id}/accept`, {});
  }
  console.log("onboarding: About you drafted and accepted");
}

/** Check-in, then Coach Cade's read and next week's plan. */
export async function playWeek(script, entry) {
  const { week, isoWeek, checkIn } = entry;
  const label = `week ${week}`;
  const clock = setClock(checkIn.at);
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
  const policy = script.noteCards.weeks1to10;
  const accepted = policy === "accept" ? await acceptPendingNoteCards() : 0;
  console.log(`${label}: check-in saved, reply ok, ${accepted} note card(s) accepted`);
  return clock;
}
