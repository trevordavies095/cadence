/**
 * Canonical privacy transparency copy (issue #6).
 * Sent vs local categories — matches PRD: identity PII/GPS out; athlete-volunteered coaching context in with disclosure.
 */
export const PRIVACY_COPY = {
  title: "What leaves this machine",
  intro:
    "When you use your own Anthropic API key, Cadence may send coaching context to Anthropic to generate replies. You control the key and billing. This page explains what is sent versus what stays on your deploy.",
  sent: {
    heading: "May be sent to Anthropic",
    items: [
      "What your coach knows about you (the profile you and the coach maintain)",
      "Your weekly report, assembled for coaching",
      "Messages you send to the coach, and the coach's replies for context",
      "Attached-run summaries derived for coaching (no GPS polylines)",
      "Your check-in answers and other coaching context you volunteer (for example how a race felt, or chronic issues you choose to share)",
    ],
  },
  local: {
    heading: "Stays local to your deploy",
    items: [
      "Identity PII such as name, email, and contact identifiers",
      "GPS / map polylines and raw track geometry",
      "Tempo API key and Anthropic API key (encrypted at rest; never echoed in full by the settings API)",
      "Full Tempo export payloads beyond the coaching summaries we attach",
    ],
  },
  disclosure:
    "Information you voluntarily tell the coach may be used for coaching decisions. The coach is instructed not to diagnose and to escalate to professionals when something is outside running coaching. Below, you can see what was last sent to the coach, and open the exact text (identity PII and GPS stay out).",
} as const;
