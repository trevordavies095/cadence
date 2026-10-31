"use client";

import { useId } from "react";
import { cx } from "@/components/ui";

/**
 * A 1 to 10 slider (0 to 10 with min 0) with a word at each end. It starts unanswered, so skipping a
 * question and answering "5" are different things.
 */
export function ScaleSlider({
  label,
  low,
  high,
  value,
  onChange,
  hint,
  min = 1,
}: {
  label: string;
  low: string;
  high: string;
  value: number | undefined;
  onChange: (next: number) => void;
  hint?: string;
  min?: 0 | 1;
}) {
  const labelId = useId();
  const answered = value !== undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium" id={labelId}>
          {label}
        </span>
        <span className={cx("tabular-nums", answered ? "font-semibold" : "text-muted")} aria-live="polite">
          {answered ? `${value} of 10` : "Slide to answer"}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={10}
        step={1}
        value={value ?? 5}
        aria-labelledby={labelId}
        aria-valuetext={answered ? `${value} of 10` : "Not answered"}
        onChange={(e) => onChange(Number(e.target.value))}
        // Clicking or tapping the starting position is still an answer.
        onPointerUp={(e) => onChange(Number(e.currentTarget.value))}
        className={cx("w-full accent-ink", !answered && "opacity-60")}
      />
      <div className="flex justify-between text-sm text-muted">
        <span>{low}</span>
        <span>{high}</span>
      </div>
      {hint ? <span className="text-sm text-muted">{hint}</span> : null}
    </div>
  );
}

/** A number the athlete steps up and down. Unanswered until the first press. */
export function Stepper({
  label,
  value,
  min,
  max,
  step,
  firstUp,
  firstDown,
  format,
  lessLabel,
  moreLabel,
  onChange,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  /** Where the first press of "more" and of "less" lands. */
  firstUp: number;
  firstDown: number;
  format: (n: number) => string;
  lessLabel: string;
  moreLabel: string;
  onChange: (next: number) => void;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const button =
    "inline-flex h-12 w-12 items-center justify-center rounded-tempo border border-border bg-raised text-2xl font-semibold text-ink hover:border-muted disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={label}>
      <div className="flex items-center gap-4">
        <button
          type="button"
          className={button}
          aria-label={lessLabel}
          disabled={value !== undefined && value <= min}
          onClick={() => onChange(value === undefined ? firstDown : clamp(value - step))}
        >
          −
        </button>
        <output className="min-w-32 text-center text-xl font-semibold tabular-nums" aria-live="polite">
          {value === undefined ? <span className="font-normal text-muted">Not answered</span> : format(value)}
        </output>
        <button
          type="button"
          className={button}
          aria-label={moreLabel}
          disabled={value !== undefined && value >= max}
          onClick={() => onChange(value === undefined ? firstUp : clamp(value + step))}
        >
          +
        </button>
      </div>
    </div>
  );
}

/** A handful of words, one of which fits. */
export function WordChoice({
  label,
  words,
  value,
  onChange,
}: {
  label: string;
  words: readonly string[];
  value: string | undefined;
  onChange: (next: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {words.map((word) => {
        const selected = value === word;
        return (
          <button
            key={word}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(word)}
            className={cx(
              "rounded-tempo border px-4 py-2.5 text-base font-semibold",
              selected ? "border-ink bg-raised text-ink" : "border-border text-muted hover:text-ink",
            )}
          >
            {word}
          </button>
        );
      })}
    </div>
  );
}
