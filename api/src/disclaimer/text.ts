/** Current product disclaimer version — stored with acceptance. */
export const DISCLAIMER_VERSION = "1";

/**
 * Canonical first-run product disclaimer.
 * Shown on Accept and re-readable from settings afterwards.
 */
export const DISCLAIMER_TEXT = `Cadence provides running coaching suggestions only. It is not medical advice, diagnosis, or treatment. If you have pain, injury, illness, or other health concerns, seek a qualified professional.

When you connect your own Anthropic API key, coaching context from this app—including what your coach knows about you, your weekly report, your check-in answers, and messages you send to the coach—may be sent to Anthropic to generate coaching replies. You control billing and key access.

By default, identity PII (such as name, email, and contact identifiers) and GPS / map polylines are not included in model payloads. They stay local to your deploy.

Information you voluntarily tell the coach (for example chronic issues or how a race felt) may be used for coaching decisions. The coach is instructed not to diagnose and to escalate to professionals when something is outside running coaching.`;

const ANTHROPIC_RECIPIENT =
  "When you connect your own Anthropic API key, coaching context from this app—including what your coach knows about you, your weekly report, your check-in answers, and messages you send to the coach—may be sent to Anthropic to generate coaching replies. You control billing and key access.";

const SELF_HOSTED_RECIPIENT =
  "When you use your own model server, coaching context from this app—including what your coach knows about you, your weekly report, your check-in answers, and messages you send to the coach—may be sent to the model server you configured to generate coaching replies. You control the server and who can reach it.";

/**
 * The disclaimer as worded for the provider in use. Only the recipient of coaching
 * context changes; what the athlete agrees to is the same, so the version is not bumped.
 */
export function disclaimerTextFor(provider: "anthropic" | "self_hosted"): string {
  return provider === "self_hosted"
    ? DISCLAIMER_TEXT.replace(ANTHROPIC_RECIPIENT, SELF_HOSTED_RECIPIENT)
    : DISCLAIMER_TEXT;
}
