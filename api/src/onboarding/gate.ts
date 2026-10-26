import { getCurrentDossier } from "../dossier/store.js";
import type { TempoPort } from "../tempo/port.js";
import {
  ONBOARDING_QUESTIONNAIRE,
  type OnboardingAnswers,
  type OnboardingQuestionnaire,
} from "./questionnaire.js";
import {
  buildOnboardingPrefills,
  type OnboardingPrefills,
} from "./prefills.js";
import { getOnboardingAnswers } from "./store.js";

const GATE_NOTE =
  "Interview the athlete in the coach thread using questionnaire.order. " +
  "Ask one prompt at a time; Tempo prefills are hints only. " +
  "When done, POST /onboarding/answers to draft dossier v1 (soft-gate Accept).";

export type NeedsOnboardingPayload = {
  status: "needs_onboarding";
  note: string;
  questionnaire: OnboardingQuestionnaire;
  prefills: OnboardingPrefills;
};

export type OnboardingReadyPayload = {
  status: "ready";
  note: string;
  answers: OnboardingAnswers;
  questionnaire: OnboardingQuestionnaire;
  prefills: OnboardingPrefills;
  createdAt: string;
  updatedAt: string;
};

export type OnboardingCompletePayload = {
  status: "complete";
  note: string;
  answers: OnboardingAnswers | null;
  dossierVersionId: number;
};

export type OnboardingGate =
  | NeedsOnboardingPayload
  | OnboardingReadyPayload
  | OnboardingCompletePayload;

/**
 * Resolve onboarding gate for a new athlete (no dossier → needs_onboarding).
 * Mirrors the needs_subjective pattern: structured questionnaire + context, no void.
 */
export async function resolveOnboardingGate(
  tempoPort: TempoPort,
): Promise<OnboardingGate> {
  const dossier = await getCurrentDossier();
  const stored = await getOnboardingAnswers();

  if (dossier) {
    return {
      status: "complete",
      note: "Dossier already exists; onboarding interview is complete.",
      answers: stored?.answers ?? null,
      dossierVersionId: dossier.id,
    };
  }

  const prefills = await buildOnboardingPrefills(tempoPort);

  if (stored) {
    return {
      status: "ready",
      note: "Onboarding answers saved — dossier v1 proposal pending Accept.",
      answers: stored.answers,
      questionnaire: ONBOARDING_QUESTIONNAIRE,
      prefills,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  return {
    status: "needs_onboarding",
    note: GATE_NOTE,
    questionnaire: ONBOARDING_QUESTIONNAIRE,
    prefills,
  };
}
