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
        "flex flex-wrap items-center justify-between gap-3 rounded-tempo border bg-raised px-4 py-3",
        tone === "danger" ? "border-danger" : "border-border",
        className,
      )}
    >
      <p className={cx("m-0", tone === "danger" && "text-danger")}>{children}</p>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
