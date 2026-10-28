import type { ReactNode } from "react";
import { cx } from "./cx";

/** One row: the label and its value. A null, undefined or empty value hides the row. */
export type LabelValueItem = readonly [label: string, value: ReactNode];

type LabelValueListProps = {
  items: readonly LabelValueItem[];
  /** "compact" is for small inline pairs: smaller text, label column sized to fit. */
  size?: "default" | "compact";
  className?: string;
};

function hasValue(value: ReactNode): boolean {
  if (value == null || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/** Label-value rows as a two-column definition list: muted label, ink value. */
export function LabelValueList({
  items,
  size = "default",
  className,
}: LabelValueListProps) {
  const rows = items.filter(([, value]) => hasValue(value));
  if (rows.length === 0) return null;
  const compact = size === "compact";
  return (
    <dl
      className={cx(
        "m-0 grid items-baseline",
        compact
          ? "grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm"
          : "grid-cols-[6.5rem_1fr] gap-x-4 gap-y-1.5",
        className,
      )}
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className={cx("font-medium text-muted", !compact && "text-sm")}>
            {label}
          </dt>
          <dd className="m-0 text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
