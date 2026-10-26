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
