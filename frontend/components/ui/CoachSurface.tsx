import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * Where Coach Cade speaks on a page: coach-bg with an accent rule on the left. Used for
 * the Plan analysis and the review read, so the two cannot drift. It carries the surface
 * only; the words inside are the caller's. In the conversation Coach Cade speaks in a
 * bubble on the same paper (ConversationMessage).
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
