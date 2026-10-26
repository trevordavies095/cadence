"use client";

import { isoWeekRangeLabel } from "@/lib/weekLabel";
import { describeError, type UiError } from "@/lib/errors";
import { useEffect, useState } from "react";
import { ButtonLink, ErrorNote, Muted, Page, PageTitle, SectionTitle } from "@/components/ui";
import {
  fetchLastOutboundPacket,
  fetchPrivacy,
  type LastOutboundPacket,
  type PrivacyCopy,
} from "@/lib/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: UiError }
  | {
      kind: "ready";
      data: PrivacyCopy;
      lastPacket: LastOutboundPacket | null;
    };

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The last message to Coach Cade in plain words: when, which week, what went along. */
function SentSummary({ sent }: { sent: LastOutboundPacket }) {
  const { summary } = sent;
  const included: string[] = [];
  if (summary.dossierVersionId != null) included.push("what Coach Cade knows about you");
  if (summary.hasRecap) included.push("your weekly report");
  if (summary.threadMessageCount > 0) {
    included.push(
      `${summary.threadMessageCount} ${summary.threadMessageCount === 1 ? "message" : "messages"} from your conversation`,
    );
  }
  if (summary.attachmentCount > 0) {
    included.push(
      `${summary.attachmentCount} attached ${summary.attachmentCount === 1 ? "run" : "runs"}`,
    );
  }
  if ((summary.recentHistoryCount ?? 0) > 0) {
    included.push(
      `a short look back at ${summary.recentHistoryCount} earlier ${summary.recentHistoryCount === 1 ? "week" : "weeks"}`,
    );
  }
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5">
      <dt className="text-muted">Sent</dt>
      <dd className="m-0">{when(sent.savedAt)}</dd>
      {summary.isoWeek ? (
        <>
          <dt className="text-muted">Week</dt>
          <dd className="m-0">{isoWeekRangeLabel(summary.isoWeek)}</dd>
        </>
      ) : null}
      <dt className="text-muted">It included</dt>
      <dd className="m-0">
        {included.length > 0 ? (
          <ul className="m-0 list-none p-0">
            {included.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          "Only your question."
        )}
      </dd>
    </dl>
  );
}

export default function PrivacyPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await fetchPrivacy();
        let lastPacket: LastOutboundPacket | null = null;
        try {
          const view = await fetchLastOutboundPacket();
          lastPacket = view.lastPacket;
        } catch {
          // Not accepted yet, so nothing has been sent; the copy still renders.
          lastPacket = null;
        }
        if (!cancelled) setState({ kind: "ready", data, lastPacket });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: describeError(err, "Couldn’t load this page. Try again in a minute."),
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Page>
      {state.kind === "loading" && <Muted>Loading…</Muted>}
      {state.kind === "error" && (
        <ErrorNote error={state.message} />
      )}
      {state.kind === "ready" && (
        <>
          <PageTitle>{state.data.title}</PageTitle>
          <Muted>{state.data.intro}</Muted>

          <section className="flex flex-col gap-2">
            <SectionTitle>{state.data.sent.heading}</SectionTitle>
            <ul className="m-0 flex flex-col gap-1.5 pl-5">
              {state.data.sent.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle>{state.data.local.heading}</SectionTitle>
            <ul className="m-0 flex flex-col gap-1.5 pl-5">
              {state.data.local.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <Muted>{state.data.disclosure}</Muted>

          <section className="flex flex-col gap-3" aria-label="What was sent to Coach Cade">
            <SectionTitle>What was sent to Coach Cade</SectionTitle>
            {!state.lastPacket ? (
              <Muted>
                Nothing has been sent yet. After Coach Cade reads a week or replies, a summary of
                what went along appears here.
              </Muted>
            ) : (
              <>
                <SentSummary sent={state.lastPacket} />
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted">
                    Show exactly what was sent
                  </summary>
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-tempo border border-border bg-canvas p-3 font-mono text-sm leading-snug">
                    {JSON.stringify(state.lastPacket.packet, null, 2)}
                  </pre>
                </details>
              </>
            )}
          </section>
        </>
      )}

      <Muted>
        <ButtonLink href="/disclaimer" variant="quiet">
          Product disclaimer
        </ButtonLink>
        {" · "}
        <ButtonLink href="/settings" variant="quiet">
          Settings
        </ButtonLink>
      </Muted>
    </Page>
  );
}
