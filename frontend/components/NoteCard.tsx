"use client";

import { useState } from "react";
import {
  acceptDossierProposal,
  postDossierCorrection,
  undoDossierProposal,
  type DossierProposal,
  type ThreadNote,
} from "@/lib/api";
import { describeError, type UiError } from "@/lib/errors";
import { Button, Card, ErrorNote, Field, Textarea } from "./ui";

export function toNote(p: DossierProposal): ThreadNote {
  return {
    id: p.id,
    kind: p.kind ?? "correction",
    status: p.status,
    summaryBullets: p.summaryBullets,
    appliedVersionId: p.appliedVersionId ?? null,
    previousVersionId: p.previousVersionId ?? null,
    createdAt: p.createdAt,
  };
}

function heading(note: ThreadNote): string {
  if (note.status === "undone") return "You undid this";
  if (note.status === "rejected") return "Set aside";
  if (note.status === "pending") {
    return note.kind === "onboarding"
      ? "Here’s what Coach Cade understood"
      : "Coach Cade tidied what it knows about you";
  }
  // Something the athlete said yes to, rather than a note the coach took itself.
  if (note.kind === "onboarding" || note.kind === "audit") return "Saved";
  if (note.kind === "correction") return "Coach Cade made your change";
  return "Coach Cade noted";
}

/**
 * What the coach remembered, in a few plain lines, with the two things the
 * athlete can do about it: take it back, or say what to change. Notes that
 * wait for a yes (the first answers, a tidy-up) show "Looks right" instead.
 */
export function NoteCard({
  note: initial,
  weekSessionId,
  onChange,
}: {
  note: ThreadNote;
  weekSessionId?: string | null;
  /** Called after the card changed something, so the page can look again. */
  onChange?: () => void;
}) {
  const [note, setNote] = useState(initial);
  const [fixing, setFixing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [followUps, setFollowUps] = useState<ThreadNote[]>([]);

  async function undo() {
    setBusy(true);
    setError(null);
    try {
      const { proposal } = await undoDossierProposal(note.id);
      setNote(toNote(proposal));
      onChange?.();
    } catch (err) {
      setError(describeError(err, "Couldn’t undo that. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function looksRight() {
    setBusy(true);
    setError(null);
    try {
      const { proposal } = await acceptDossierProposal(note.id);
      setNote(toNote(proposal));
      onChange?.();
    } catch (err) {
      setError(describeError(err, "Couldn’t save that. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function fix() {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const result = await postDossierCorrection({
        body,
        weekSessionId: weekSessionId ?? undefined,
      });
      // A correction replaces a draft that was still waiting.
      if (note.status === "pending") setNote({ ...note, status: "rejected" });
      setFollowUps((prev) => [...prev, toNote(result.dossierProposal)]);
      setText("");
      setFixing(false);
      onChange?.();
    } catch (err) {
      setError(describeError(err, "Couldn’t make that change. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const inactive = note.status === "undone" || note.status === "rejected";

  return (
    <div className="flex flex-col gap-3">
      <Card
        aria-label={heading(note)}
        className="flex flex-col gap-3"
      >
        <p className="m-0 font-semibold">{heading(note)}</p>
        {note.summaryBullets.length > 0 ? (
          <ul
            className={`m-0 flex list-disc flex-col gap-1 pl-5 ${inactive ? "text-muted line-through" : ""}`}
          >
            {note.summaryBullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}

        {!inactive ? (
          <div className="flex flex-wrap items-center gap-3">
            {note.status === "pending" ? (
              <Button
                variant={fixing ? "secondary" : "primary"}
                disabled={busy}
                onClick={() => void looksRight()}
              >
                Looks right
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void undo()}>
                Undo
              </Button>
            )}
            <Button disabled={busy} onClick={() => setFixing((v) => !v)}>
              Fix something
            </Button>
          </div>
        ) : null}

        {fixing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void fix();
            }}
          >
            <Field label="What should Coach Cade change?">
              <Textarea
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
                autoFocus
              />
            </Field>
            <div className="flex gap-3">
              <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
                {busy ? "Sending…" : "Send"}
              </Button>
              <Button disabled={busy} onClick={() => setFixing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        <ErrorNote error={error} />
      </Card>

      {followUps.map((n) => (
        <NoteCard key={n.id} note={n} weekSessionId={weekSessionId} onChange={onChange} />
      ))}
    </div>
  );
}
