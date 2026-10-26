import type { ReactNode } from "react";
import { cx } from "./cx";

type PageProps = {
  children: ReactNode;
  className?: string;
};

/** The page column. Left-aligned; centre only inside empty and waiting states. */
export function Page({ children, className }: PageProps) {
  return (
    <main
      className={cx(
        "mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6",
        className,
      )}
    >
      {children}
    </main>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="m-0 text-3xl font-semibold leading-tight">{children}</h1>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="m-0 text-xl font-semibold leading-snug">{children}</h2>;
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
