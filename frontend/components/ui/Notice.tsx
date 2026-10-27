import type { ReactNode } from "react";
import { cx } from "./cx";

type NoticeProps = {
  title: string;
  severity?: "info" | "caution" | "urgent";
  children?: ReactNode;
  className?: string;
};

type Severity = NonNullable<NoticeProps["severity"]>;

/* Severity is told apart before it is read: an edge, a wash of about 8 percent
   of the edge color over raised, and the title set in the edge color. Info has
   no wash. Ink, muted and each title clear 4.5:1 on their wash in both themes. */
const surface: Record<Severity, string> = {
  info: "border-l-line-strong bg-raised",
  caution: "border-l-warn bg-[color-mix(in_srgb,var(--warn)_8%,var(--raised))]",
  urgent:
    "border-l-danger bg-[color-mix(in_srgb,var(--danger)_8%,var(--raised))]",
};

const titleColor: Record<Severity, string> = {
  info: "text-ink",
  caution: "text-warn",
  urgent: "text-danger",
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
        "rounded-tempo border border-l-4 border-border px-4 py-3",
        surface[severity],
        className,
      )}
    >
      <p className={cx("m-0 font-semibold", titleColor[severity])}>{title}</p>
      {children ? <div className="mt-1 text-muted">{children}</div> : null}
    </aside>
  );
}
