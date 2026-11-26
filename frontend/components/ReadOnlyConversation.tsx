"use client";

import { useEffect, useState } from "react";
import { ConversationMessages } from "@/components/ConversationMessage";
import { ErrorNote, Muted, SectionTitle } from "@/components/ui";
import { fetchThread, type ThreadMessage, type UnitPreference } from "@/lib/api";
import { describeError, type UiError } from "@/lib/errors";

/**
 * A past week's conversation with the coach, closed until asked for: it has its
 * own page, and open it was most of this one (ADR 0009). Nothing here can be
 * sent or changed.
 */
export function ReadOnlyConversation({
  weekSessionId,
  unit,
}: {
  weekSessionId: string;
  unit: UnitPreference;
}) {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchThread(weekSessionId)
      .then((data) => {
        if (!cancelled) setMessages(data.messages);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(describeError(err, "Couldn’t load that conversation. Try again in a minute."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [weekSessionId]);

  return (
    <section id="conversation" className="flex scroll-mt-20 flex-col gap-3" aria-label="The conversation">
      <SectionTitle>The conversation</SectionTitle>
      <ErrorNote error={error} />
      {messages === null && !error ? <Muted>Loading…</Muted> : null}
      {messages?.length === 0 ? <Muted>You and Coach Cade didn’t talk this week.</Muted> : null}
      {messages && messages.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-muted">
            {messages.length === 1 ? "1 message" : `${messages.length} messages`} between you and
            Coach Cade
          </summary>
          <div className="relative mt-3 flex flex-col">
            <ConversationMessages messages={messages} unit={unit} />
          </div>
        </details>
      ) : null}
    </section>
  );
}
