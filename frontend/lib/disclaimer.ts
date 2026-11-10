import { ApiError } from "./errors";
import { goToSignIn, isSignedOut } from "./session";

async function failure(res: Response): Promise<never> {
  const text = await res.text();
  if (isSignedOut(res.status, text)) return goToSignIn();
  throw new ApiError(res.status, text);
}

export type DisclaimerState = {
  accepted: boolean;
  acceptedAt: string | null;
  version: string;
  /** Who coaching context is sent to; the text names that recipient. */
  provider?: "anthropic" | "self_hosted";
  text: string;
};

export async function fetchDisclaimer(): Promise<DisclaimerState> {
  const res = await fetch("/api/disclaimer");
  if (!res.ok) return failure(res);
  return (await res.json()) as DisclaimerState;
}

export async function acceptDisclaimer(): Promise<DisclaimerState> {
  const res = await fetch("/api/disclaimer/accept", { method: "POST" });
  if (!res.ok) return failure(res);
  return (await res.json()) as DisclaimerState;
}

/**
 * The disclaimer is four paragraphs; each gets a plain heading. Other shapes show without
 * headings. The second names who coaching context may be sent to.
 */
function sectionHeadings(provider: DisclaimerState["provider"]): string[] {
  return [
    "What this is",
    provider === "self_hosted"
      ? "What may be sent to the model server you configured"
      : "What may be sent to Anthropic",
    "What stays with you",
    "What you tell your coach",
  ];
}

export function disclaimerSections(
  text: string,
  provider: DisclaimerState["provider"] = "anthropic",
): { heading: string | null; body: string }[] {
  const headings = sectionHeadings(provider);
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const titled = paragraphs.length === headings.length;
  return paragraphs.map((body, i) => ({
    heading: titled ? headings[i]! : null,
    body,
  }));
}
