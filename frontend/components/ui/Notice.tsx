import type { ReactNode } from "react";
import { cx } from "./cx";

type NoticeProps = {
  title: string;
  severity?: "info" | "caution" | "urgent";
  children?: ReactNode;
  className?: string;
};

const edge: Record<NonNullable<NoticeProps["severity"]>, string> = {
  info: "border-l-muted",
  caution: "border-l-hr-zone-3",
  urgent: "border-l-danger",
};

/** A titled message the athlete should read once, such as a safety callout. */
export function Notice({
  title,
  severity = "info",
  children,
  className,
}: NoticeProps) {
  return (
    <aside
      className={cx(
        "rounded-tempo border border-l-4 border-border bg-raised px-4 py-3",
        edge[severity],
        className,
      )}
    >
      <p className="m-0 font-semibold">{title}</p>
      {children ? <div className="mt-1 text-muted">{children}</div> : null}
    </aside>
  );
}
