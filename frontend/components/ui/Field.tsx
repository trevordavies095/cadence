import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

const control =
  "w-full rounded-tempo border border-border bg-raised px-3 py-2.5 text-base text-ink placeholder:text-muted";

type FieldProps = {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  className?: string;
};

/** Label, control, hint and error as one unit. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-sm font-semibold text-muted">{label}</span>
      {children}
      {hint ? <span className="text-sm text-muted">{hint}</span> : null}
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function Input({
  className,
  ...rest
}: ComponentProps<"input">) {
  return <input className={cx(control, className)} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: ComponentProps<"textarea">) {
  return <textarea className={cx(control, "resize-y", className)} {...rest} />;
}

export function Select({
  className,
  ...rest
}: ComponentProps<"select">) {
  return <select className={cx(control, className)} {...rest} />;
}
