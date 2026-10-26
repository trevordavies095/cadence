/**
 * Onboarding interview questionnaire (needs_subjective-style gate shape).
 * Conversational prompts for the coach thread — not a multi-page form wizard.
 */

export type OnboardingFieldKey =
  | "goal"
  | "schedule"
  | "injuries_constraints"
  | "preferences";

export type OnboardingAnswers = {
  goal: string;
  schedule: string;
  injuries_constraints?: string;
  preferences?: string;
};

export type OnboardingQuestionnaire = {
  order: OnboardingFieldKey[];
  fields: Record<OnboardingFieldKey, string>;
  all_fields_optional: false;
  /** Fields that must be non-empty when saving. */
  required: OnboardingFieldKey[];
};

export const ONBOARDING_QUESTIONNAIRE: OnboardingQuestionnaire = {
  order: ["goal", "schedule", "injuries_constraints", "preferences"],
  fields: {
    goal: "What are you training for? Race/event + target date, or general fitness / base building.",
    schedule:
      "Which days can you typically run, and roughly how much time do you have each week?",
    injuries_constraints:
      "Any injuries, chronic niggles, or constraints you want the coach to respect? (optional — only what you volunteer)",
    preferences:
      "Training preferences — terrain, long-run day, intensity appetite, shoes you favor, etc. (optional)",
  },
  all_fields_optional: false,
  required: ["goal", "schedule"],
};

export function parseOnboardingAnswers(
  raw: unknown,
):
  | { ok: true; answers: OnboardingAnswers }
  | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "answers_object_required" };
  }
  const body = raw as Record<string, unknown>;

  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  const schedule =
    typeof body.schedule === "string" ? body.schedule.trim() : "";
  if (!goal) return { ok: false, error: "goal_required" };
  if (!schedule) return { ok: false, error: "schedule_required" };

  const answers: OnboardingAnswers = { goal, schedule };

  if (body.injuries_constraints !== undefined) {
    if (typeof body.injuries_constraints !== "string") {
      return { ok: false, error: "invalid_injuries_constraints" };
    }
    const v = body.injuries_constraints.trim();
    if (v) answers.injuries_constraints = v;
  }

  if (body.preferences !== undefined) {
    if (typeof body.preferences !== "string") {
      return { ok: false, error: "invalid_preferences" };
    }
    const v = body.preferences.trim();
    if (v) answers.preferences = v;
  }

  return { ok: true, answers };
}
