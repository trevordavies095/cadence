"use client";

import { ChipChoice } from "@/components/OnboardingControls";
import { Field, Input, Textarea } from "@/components/ui";
import {
  GOAL_CHOICES,
  RACE_DISTANCE_CHOICES,
  SPEED_DISTANCE_CHOICES,
  type GoalDraft,
} from "@/lib/onboarding";

/**
 * "What are you training for?": the four kinds, then the fields of the one chosen. Onboarding
 * starts it empty; Settings starts it from the stored goal. The caller keeps the draft.
 */
export function GoalFields({
  draft,
  onChange,
}: {
  draft: GoalDraft;
  onChange: (patch: Partial<GoalDraft>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ChipChoice
        label="What you’re training for"
        options={GOAL_CHOICES}
        value={draft.goalKind}
        onChange={(kind) => onChange({ goalKind: kind })}
      />
      {draft.goalKind === "race" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <p className="m-0 text-sm font-semibold text-muted">How far is the race?</p>
            <ChipChoice
              label="Race distance"
              options={RACE_DISTANCE_CHOICES}
              value={draft.raceDistance}
              onChange={(distance) => onChange({ raceDistance: distance })}
            />
          </div>
          <Field label="Which race?">
            <Input
              value={draft.raceName}
              onChange={(e) => onChange({ raceName: e.target.value })}
              placeholder="For example, the Lakeshore Half"
            />
          </Field>
          <Field label="Race date" hint="Optional. Leave blank if you haven’t picked one yet.">
            <Input
              type="date"
              value={draft.raceDate}
              onChange={(e) => onChange({ raceDate: e.target.value })}
            />
          </Field>
          <Field
            label="Target"
            hint="Optional. In your own words, for example under 2 hours or finish feeling strong."
          >
            <Input
              value={draft.raceTarget}
              onChange={(e) => onChange({ raceTarget: e.target.value })}
            />
          </Field>
        </div>
      ) : draft.goalKind === "speed" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <p className="m-0 text-sm font-semibold text-muted">Which distance?</p>
            <ChipChoice
              label="Distance to get faster at"
              options={SPEED_DISTANCE_CHOICES}
              value={draft.speedDistance}
              onChange={(distance) => onChange({ speedDistance: distance })}
            />
          </div>
          <Field label="Target" hint="Optional. In your own words, for example under 45 minutes.">
            <Input
              value={draft.speedTarget}
              onChange={(e) => onChange({ speedTarget: e.target.value })}
            />
          </Field>
          <Field label="Next race date" hint="Optional. Leave blank if there isn’t one yet.">
            <Input
              type="date"
              value={draft.nextRaceDate}
              onChange={(e) => onChange({ nextRaceDate: e.target.value })}
            />
          </Field>
        </div>
      ) : draft.goalKind === "return" ? (
        <div className="flex flex-col gap-3">
          <Field
            label="Where are you now?"
            hint="Optional. In your own words: how long you were off, what you’ve been cleared for, what you’re running now."
          >
            <Textarea
              rows={3}
              value={draft.startingPoint}
              onChange={(e) => onChange({ startingPoint: e.target.value })}
              placeholder="For example, off for six weeks, cleared by my physio, running 15 minutes three times a week"
            />
          </Field>
          <Field label="Running again since" hint="Optional. Leave blank if you haven’t started back yet.">
            <Input
              type="date"
              value={draft.since}
              onChange={(e) => onChange({ since: e.target.value })}
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}
