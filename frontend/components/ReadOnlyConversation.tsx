"use client";

import { useEffect, useState } from "react";
import { ConversationMessage } from "@/components/ConversationMessage";
import { ErrorNote, Muted, SectionTitle } from "@/components/ui";
import { fetchThread, type ThreadMessage, type UnitPreference } from "@/lib/api";
import { describeError, type UiError } from "@/lib/errors";

/** A past week's conversation with the coach. Nothing here can be sent or changed. */
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
    <section className="flex flex-col gap-3" aria-label="The conversation">
      <SectionTitle>The conversation</SectionTitle>
      <ErrorNote error={error} />
      {messages === null && !error ? <Muted>Loading…</Muted> : null}
      {messages?.length === 0 ? <Muted>You and Coach Cade didn’t talk this week.</Muted> : null}
      {messages?.map((m) => (
        <ConversationMessage key={m.id} message={m} unit={unit} />
      ))}
    </section>
  );
}
