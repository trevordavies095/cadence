import type { ReactNode } from "react";
import { cx } from "./cx";

type BannerProps = {
  tone?: "info" | "danger";
  children: ReactNode;
  action?: ReactNode;
  className?: string;
  role?: "status" | "alert";
};

/** One line that says something needs the athlete, with an optional action. */
export function Banner({
  tone = "info",
  children,
  action,
  className,
  role,
}: BannerProps) {
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={cx(
        "flex flex-wrap items-center justify-between gap-3 rounded-tempo border border-l-[3px] px-4 py-3",
        // Info is Coach Cade asking for something, so it sits on his paper.
        tone === "danger"
          ? "border-danger bg-[color-mix(in_srgb,var(--danger)_8%,var(--raised))]"
          : "border-border border-l-accent bg-coach-bg",
        className,
      )}
    >
      <p className={cx("m-0", tone === "danger" && "text-danger")}>{children}</p>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
