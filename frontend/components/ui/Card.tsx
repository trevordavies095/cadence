import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/** For a discrete unit (a day, a run, a note). Not a page-layout wrapper. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        "rounded-tempo border border-border bg-raised p-4",
        className,
      )}
      {...rest}
    />
  );
}
