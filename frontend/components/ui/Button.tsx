import Link from "next/link";
import type { ComponentProps } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "quiet";

const base =
  "inline-flex items-center justify-center gap-2 rounded-tempo px-4 py-2.5 text-base font-semibold leading-6 transition-opacity disabled:cursor-not-allowed";

const variants: Record<ButtonVariant, string> = {
  // Volt is reserved for the one primary action on a screen. Disabled, it turns
  // to line and muted instead of a faded volt.
  primary:
    "bg-volt text-on-volt hover:opacity-90 disabled:bg-border disabled:text-muted disabled:hover:opacity-100",
  secondary:
    "border border-border bg-raised text-ink hover:border-muted disabled:opacity-50",
  quiet:
    "px-1 text-ink underline underline-offset-4 hover:opacity-80 disabled:opacity-50",
};

export function buttonClass(variant: ButtonVariant, extra?: string): string {
  return cx(base, variants[variant], extra);
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant;
};

export function Button({
  variant = "secondary",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={buttonClass(variant, className)} {...rest} />
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
};

export function ButtonLink({
  variant = "secondary",
  className,
  ...rest
}: ButtonLinkProps) {
  return <Link className={buttonClass(variant, className)} {...rest} />;
}
