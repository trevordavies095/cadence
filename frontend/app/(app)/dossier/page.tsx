"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CoachText } from "@/components/CoachText";
import { NoteCard } from "@/components/NoteCard";
import {
  Button,
  ButtonLink,
  ErrorNote,
  Field,
  Muted,
  Page,
  PageTitle,
  SectionTitle,
  Textarea,
  WaitingState,
} from "@/components/ui";
import {
  fetchDossier,
  fetchDossierChanges,
  fetchDossierProposals,
  postDossierCorrection,
  putDossier,
  undoDossierProposal,
  type DossierProposal,
  type DossierVersion,
  type ThreadNote,
} from "@/lib/api";
import { describeError, type UiError } from "@/lib/errors";

const KIND_WORDS: Record<string, string> = {
  settings: "Noted by Coach Cade",
  correction: "Your correction",
  audit: "Tidy-up",
  onboarding: "Your first answers",
};

function toNote(p: DossierProposal): ThreadNote {
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

type Section = { title: string; body: string };

/** Split the profile on its `##` headings. The coach's own instructions stay out of sight. */
function sectionsOf(body: string): Section[] {
  const parts = body.split(/^## +/m);
  const sections: Section[] = [];
  for (const part of parts.slice(1)) {
    const newline = part.indexOf("\n");
    const title = (newline === -1 ? part : part.slice(0, newline)).trim();
    if (/^stance$/i.test(title)) continue;
    sections.push({ title, body: newline === -1 ? "" : part.slice(newline + 1).trim() });
  }
  return sections;
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function AboutYouPage() {
  const [ready, setReady] = useState(false);
  const [current, setCurrent] = useState<DossierVersion | null>(null);
  const [waiting, setWaiting] = useState<DossierProposal[]>([]);
  const [changes, setChanges] = useState<DossierProposal[]>([]);
  const [error, setError] = useState<UiError | null>(null);
  const [tell, setTell] = useState("");
  const [telling, setTelling] = useState(false);
  const [told, setTold] = useState<ThreadNote[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [undoing, setUndoing] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [data, pending, history] = await Promise.all([
      fetchDossier(),
      fetchDossierProposals(),
      fetchDossierChanges(),
    ]);
    setCurrent(data.current);
    setDraft(data.current?.body ?? "");
    setWaiting(pending.proposals);
    setChanges(history.changes);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        await load();
      } catch (err) {
        if (!cancelled) {
          setError(describeError(err, "Couldn’t load this page. Try again in a minute."));
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    void start();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function tellCoach(e: FormEvent) {
    e.preventDefault();
    const body = tell.trim();
    if (!body) return;
    setTelling(true);
    setError(null);
    try {
      const result = await postDossierCorrection({ body });
      setTold((prev) => [...prev, toNote(result.dossierProposal)]);
      setTell("");
      await load();
    } catch (err) {
      setError(describeError(err, "Couldn’t pass that on. Try again."));
    } finally {
      setTelling(false);
    }
  }

  async function undo(id: number) {
    setUndoing(id);
    setError(null);
    try {
      await undoDossierProposal(id);
      await load();
    } catch (err) {
      setError(describeError(err, "Couldn’t undo that. Try again."));
    } finally {
      setUndoing(null);
    }
  }

  async function saveRaw(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await putDossier(draft);
      await load();
      setSaved(true);
    } catch (err) {
      setError(describeError(err, "Couldn’t save that. Try again."));
    } finally {
      setSaving(false);
    }
  }

  if (!ready) {
    return (
      <WaitingState>
        <p className="m-0">Loading…</p>
      </WaitingState>
    );
  }

  const sections = current ? sectionsOf(current.body) : [];
  const knowsYou = current !== null || waiting.length > 0;

  return (
    <Page>
      <PageTitle>About you</PageTitle>
      <Muted>
        What Coach Cade knows about you, so every plan starts from the real you.
        {current ? ` Last changed ${dayLabel(current.createdAt)}.` : ""}
      </Muted>
      <ErrorNote error={error} />

      {waiting.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Waiting for you">
          <SectionTitle>Waiting for you</SectionTitle>
          {waiting.map((p) => (
            <NoteCard key={p.id} note={toNote(p)} onChange={() => void load()} />
          ))}
        </section>
      ) : null}

      {knowsYou ? (
        <section className="flex flex-col gap-3" aria-label="Tell Coach Cade">
          <SectionTitle>Tell Coach Cade something to remember or fix</SectionTitle>
          <form onSubmit={(e) => void tellCoach(e)} className="flex flex-col gap-3">
            <Field label="What should Coach Cade know?">
              <Textarea
                rows={3}
                value={tell}
                onChange={(e) => setTell(e.target.value)}
                placeholder="For example: I can only run Monday, Wednesday and Friday."
              />
            </Field>
            <div>
              <Button type="submit" variant="primary" disabled={telling || !tell.trim()}>
                {telling ? "Passing it on…" : "Tell Coach Cade"}
              </Button>
            </div>
          </form>
          {told.map((n) => (
            <NoteCard key={n.id} note={n} onChange={() => void load()} />
          ))}
        </section>
      ) : (
        <section className="flex flex-col gap-3 border-y border-border py-6">
          <p className="m-0 font-semibold">Coach Cade doesn’t know you yet.</p>
          <Muted>Answer a few questions and this page will fill in.</Muted>
          <div>
            <ButtonLink href="/onboarding" variant="primary">
              Start
            </ButtonLink>
          </div>
        </section>
      )}

      {current ? (
        <section className="flex flex-col gap-3" aria-label="What Coach Cade knows">
          <SectionTitle>What Coach Cade knows</SectionTitle>
          {sections.length > 0 ? (
            <div className="flex flex-col">
              {sections.map((s, i) => (
                <details
                  key={`${s.title}-${i}`}
                  open={i === 0}
                  className="border-b border-border py-3"
                >
                  <summary className="cursor-pointer text-lg font-semibold">
                    {s.title}
                  </summary>
                  {s.body ? <CoachText className="mt-3">{s.body}</CoachText> : null}
                </details>
              ))}
            </div>
          ) : (
            <CoachText>{current.body}</CoachText>
          )}
        </section>
      ) : null}

      {changes.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Changes">
          <SectionTitle>Changes</SectionTitle>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {changes.map((c) => (
              <li key={c.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="font-semibold">
                    {dayLabel(c.createdAt)} · {KIND_WORDS[c.kind ?? "settings"]}
                    {c.status === "undone" ? " · undone" : ""}
                  </span>
                  {c.status === "accepted" && c.previousVersionId !== null ? (
                    <Button
                      disabled={undoing === c.id}
                      onClick={() => void undo(c.id)}
                    >
                      Undo
                    </Button>
                  ) : null}
                </div>
                <ul
                  className={`m-0 flex list-disc flex-col gap-1 pl-5 ${c.status === "undone" ? "text-muted line-through" : ""}`}
                >
                  {c.summaryBullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {current ? (
        <details className="border-t border-border pt-4">
          <summary className="cursor-pointer font-semibold">Advanced</summary>
          <form onSubmit={(e) => void saveRaw(e)} className="mt-3 flex flex-col gap-3">
            <p className="m-0 text-muted">
              This is the exact text Coach Cade reads every time. Changes made
              here skip Coach Cade and are saved as you write them.
            </p>
            <Textarea
              className="font-mono text-sm leading-relaxed"
              rows={14}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
              }}
              aria-label="The full text Coach Cade reads"
              required
            />
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {saved ? <span className="text-hr-zone-1">Saved.</span> : null}
            </div>
          </form>
        </details>
      ) : null}
    </Page>
  );
}
