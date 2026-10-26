import { ApiError } from "./errors";

export type DisclaimerState = {
  accepted: boolean;
  acceptedAt: string | null;
  version: string;
  text: string;
};

export async function fetchDisclaimer(): Promise<DisclaimerState> {
  const res = await fetch("/api/disclaimer");
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return (await res.json()) as DisclaimerState;
}

export async function acceptDisclaimer(): Promise<DisclaimerState> {
  const res = await fetch("/api/disclaimer/accept", { method: "POST" });
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return (await res.json()) as DisclaimerState;
}

/** The disclaimer is four paragraphs; each gets a plain heading. Other shapes show without headings. */
const SECTION_HEADINGS = [
  "What this is",
  "What may be sent to Anthropic",
  "What stays with you",
  "What you tell your coach",
];

export function disclaimerSections(text: string): { heading: string | null; body: string }[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const titled = paragraphs.length === SECTION_HEADINGS.length;
  return paragraphs.map((body, i) => ({
    heading: titled ? SECTION_HEADINGS[i]! : null,
    body,
  }));
}
