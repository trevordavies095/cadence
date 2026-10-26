"use client";

import { cx } from "@/components/ui";
import { WEEKDAYS, type Weekday } from "@/lib/onboarding";

const chip = "rounded-tempo border px-4 py-2.5 text-base font-semibold";
const chipOn = "border-ink bg-raised text-ink";
const chipOff = "border-border text-muted hover:text-ink";

/** Weekdays to switch on and off. Any number can be chosen. */
export function DayChips({
  label,
  value,
  onChange,
}: {
  label: string;
  value: readonly Weekday[];
  onChange: (next: Weekday[]) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {WEEKDAYS.map((day) => {
        const on = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            role="checkbox"
            aria-checked={on}
            onClick={() => onChange(on ? value.filter((d) => d !== day) : [...value, day])}
            className={cx(chip, on ? chipOn : chipOff)}
          >
            {day}
          </button>
        );
      })}
    </div>
  );
}

/** One of a few days. */
export function DayChoice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly Weekday[];
  value: Weekday | null;
  onChange: (next: Weekday | null) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {WEEKDAYS.filter((d) => options.includes(d)).map((day) => {
        const on = value === day;
        return (
          <button
            key={day}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(on ? null : day)}
            className={cx(chip, on ? chipOn : chipOff)}
          >
            {day}
          </button>
        );
      })}
    </div>
  );
}
