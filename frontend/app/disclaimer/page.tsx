"use client";

import { describeError, type UiError } from "@/lib/errors";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  ButtonLink,
  ErrorNote,
  Muted,
  Page,
  PageHead,
  PageTitle,
  SectionTitle,
} from "@/components/ui";
import {
  acceptDisclaimer,
  disclaimerSections,
  fetchDisclaimer,
  type DisclaimerState,
} from "@/lib/disclaimer";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: UiError }
  | { kind: "ready"; data: DisclaimerState };

export default function DisclaimerPage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await fetchDisclaimer();
        if (!cancelled) setState({ kind: "ready", data });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: describeError(err, "Couldn’t reach Coach Cade. Check that it’s running, then reload."),
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onAccept() {
    setSubmitting(true);
    try {
      await acceptDisclaimer();
      router.replace("/");
    } catch (err) {
      setState({
        kind: "error",
        message: describeError(err, "Couldn’t save that. Try again."),
      });
      setSubmitting(false);
    }
  }

  const ready = state.kind === "ready" ? state.data : null;

  return (
    <Page>
      <PageHead>
        <PageTitle>{ready?.accepted ? "Disclaimer" : "Welcome to Cadence"}</PageTitle>
        {state.kind === "error" && <ErrorNote error={state.message} />}
        {ready && !ready.accepted && (
          <Muted>
            Your coach reads your running log and plans your weeks. Before you start, here is
            what to know.
          </Muted>
        )}
      </PageHead>
      {state.kind === "loading" && (
        <div role="status" aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
          <div className="h-24 w-full animate-pulse rounded-tempo bg-raised" />
          <div className="h-24 w-full animate-pulse rounded-tempo bg-raised" />
        </div>
      )}
      {ready && (
        <>
          <div className="flex flex-col gap-8">
            {disclaimerSections(ready.text).map((section) => (
              <section key={section.body} className="flex flex-col gap-1.5">
                {section.heading && <SectionTitle>{section.heading}</SectionTitle>}
                <p className="m-0 leading-relaxed">{section.body}</p>
              </section>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            <Muted>
              The full list of what may be sent is on the{" "}
              <ButtonLink href="/privacy" variant="quiet">
                Privacy page
              </ButtonLink>
              .
            </Muted>
            {!ready.accepted ? (
              <div>
                <Button variant="primary" onClick={() => void onAccept()} disabled={submitting}>
                  {submitting ? "One moment…" : "I understand, continue"}
                </Button>
              </div>
            ) : (
              <Muted>
                You accepted this earlier.{" "}
                <ButtonLink href="/" variant="quiet">
                  Back to Home
                </ButtonLink>
              </Muted>
            )}
          </div>
        </>
      )}
    </Page>
  );
}
