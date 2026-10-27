import type { ReactNode } from "react";
import { cx } from "./cx";

type PageProps = {
  children: ReactNode;
  className?: string;
  /**
   * A single flow with no sections (a form step, an outage message): keeps the
   * tight gap throughout instead of the wide gap between sections.
   */
  flow?: boolean;
};

/**
 * The page column. Left-aligned; centre only inside empty and waiting states.
 * Its children are sections, so they sit a wide gap apart; anything that belongs
 * together (a title and its subtitle) goes in a PageHead or its own tight column.
 */
export function Page({ children, className, flow = false }: PageProps) {
  return (
    <main
      className={cx(
        "mx-auto flex w-full max-w-3xl flex-col px-4 py-8 sm:px-6",
        flow ? "gap-4" : "gap-8",
        className,
      )}
    >
      {children}
    </main>
  );
}

/** The page title and whatever sits right under it, kept at the tight gap. */
export function PageHead({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="m-0 text-3xl font-semibold leading-tight">{children}</h1>;
}

const SECTION_TITLE = "m-0 text-xl font-semibold leading-snug";
/** The rule that opens every section: 2px line-strong with room above the title. */
const SECTION_RULE = "border-t-2 border-line-strong pt-3";

/** A section's title, opened by the section rule. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className={cx(SECTION_TITLE, SECTION_RULE)}>{children}</h2>;
}

/**
 * A section title with something muted on the right (usually the week's dates).
 * The rule spans the whole row, not just the title.
 */
export function SectionHeader({
  title,
  aside,
}: {
  title: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header
      className={cx(
        "flex flex-wrap items-baseline justify-between gap-3",
        SECTION_RULE,
      )}
    >
      <h2 className={SECTION_TITLE}>{title}</h2>
      {aside ? <span className="text-muted">{aside}</span> : null}
    </header>
  );
}

/** Quiet explanatory text. */
export function Muted({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cx("m-0 text-muted", className)}>{children}</p>;
}

/** Centred state for loading and waiting screens only. */
export function WaitingState({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col items-center justify-center gap-3 px-4 py-8 text-center text-muted">
      {children}
    </main>
  );
}
