"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Page, PageTitle, Muted } from "@/components/ui";
import { fetchDisclaimer } from "@/lib/disclaimer";

type GateState = "checking" | "open" | "needs" | "outage";

/** Pages an athlete may read before accepting; they are linked from the welcome screen. */
const OPEN_PATHS = new Set(["/privacy"]);

/** A neutral page-shaped placeholder, so nothing flashes while the check runs. */
function Skeleton() {
  return (
    <Page>
      <div role="status" aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
        <div className="h-9 w-1/3 animate-pulse rounded-tempo bg-raised" />
        <div className="h-24 w-full animate-pulse rounded-tempo bg-raised" />
        <div className="h-24 w-full animate-pulse rounded-tempo bg-raised" />
      </div>
    </Page>
  );
}

/**
 * Checks the disclaimer once for every page in the app. Accepted: the page renders.
 * Not accepted: the welcome screen. API unreachable: an outage message, never the welcome screen.
 */
export function DisclaimerGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<GateState>("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchDisclaimer()
      .then((disclaimer) => {
        if (cancelled) return;
        setState(disclaimer.accepted ? "open" : "needs");
      })
      .catch(() => {
        if (!cancelled) setState("outage");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Not accepted yet: everything but the open pages goes to the welcome screen.
  const open = OPEN_PATHS.has(pathname);
  useEffect(() => {
    if (state === "needs" && !open) router.replace("/disclaimer");
  }, [state, open, router]);

  const retry = useCallback(() => {
    setState("checking");
    setAttempt((n) => n + 1);
  }, []);

  if (state === "open" || open) return <>{children}</>;
  if (state === "outage") {
    return (
      <Page>
        <PageTitle>Can’t reach Coach Cade</PageTitle>
        <Muted>
          Coach Cade isn’t responding. Check that it’s running, then try again. Nothing you’ve
          entered has been lost.
        </Muted>
        <div>
          <Button variant="primary" onClick={retry}>
            Try again
          </Button>
        </div>
      </Page>
    );
  }
  return <Skeleton />;
}
