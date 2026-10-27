import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * Where Coach Cade speaks: coach-bg with an accent rule on the left. Used for chat
 * replies, the Plan analysis and the review read, so the three cannot drift. It carries
 * the surface only; the words inside are the caller's.
 */
export function CoachSurface({
  as: Tag = "div",
  className,
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: "div" | "article" | "section" }) {
  return (
    <Tag
      className={cx(
        "rounded-r-md border-l-[3px] border-accent bg-coach-bg px-5 py-4",
        className,
      )}
      {...rest}
    />
  );
}
