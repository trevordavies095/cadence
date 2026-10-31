"use client";

import { describeError, type UiError } from "@/lib/errors";
import { useEffect, useState, type FormEvent } from "react";
import {
  Button,
  ButtonLink,
  Field,
  Input,
  Muted,
  Page,
  PageHead,
  PageTitle,
  SectionTitle,
  WaitingState,
  ErrorNote,
} from "@/components/ui";
import {
  persistAppearance,
  readStoredAppearance,
  type AppearancePreference,
} from "@/lib/appearance";
import { cx } from "@/components/ui";
import {
  deleteAnthropicConnection,
  deleteTempoConnection,
  fetchGoal,
  fetchSettings,
  putAnthropicConnection,
  putTempoConnection,
  saveGoal,
  type AnthropicConnection,
  type SettingsSources,
  type StoredGoal,
  type TempoConnection,
  type ThreadNote,
} from "@/lib/api";
import { GoalFields } from "@/components/GoalFields";
import { NoteCard, toNote } from "@/components/NoteCard";
import { draftGoal, goalDraft, goalProblem, type GoalDraft } from "@/lib/onboarding";

type GateState = "loading" | "open";

const APPEARANCE_CHOICES: { value: AppearancePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function ConfirmClear({
  question,
  consequence,
  onConfirm,
  onCancel,
}: {
  question: string;
  consequence: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-label={question} className="flex flex-col gap-2 border-l-4 border-ink bg-raised px-3 py-2">
      <p className="m-0 font-semibold">{question}</p>
      <p className="m-0 text-muted">{consequence}</p>
      <div className="flex gap-3">
        <Button onClick={onConfirm}>Remove</Button>
        <Button variant="quiet" onClick={onCancel}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

/**
 * What the athlete is training for, with Change. After the first answers this is the only
 * way to change the goal: saving stores it and tells Coach Cade, who notes it in About you.
 */
function TrainingGoalSection({ initial }: { initial: StoredGoal }) {
  const [stored, setStored] = useState(initial);
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<ThreadNote | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [saving, setSaving] = useState(false);

  function startChange() {
    setDraft(goalDraft(stored.goal));
    setProblem(null);
    setError(null);
    setNote(null);
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const missing = goalProblem(draft);
    const goal = draftGoal(draft);
    if (missing || !goal) {
      setProblem(missing ?? "Choose one to continue.");
      return;
    }
    setSaving(true);
    setProblem(null);
    setError(null);
    try {
      const saved = await saveGoal(goal);
      setStored(saved);
      setNote(saved.correction ? toNote(saved.correction.dossierProposal) : null);
      setDraft(null);
    } catch (err) {
      setError(describeError(err, "Couldn’t save that. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-label="What you’re training for">
      <SectionTitle>What you’re training for</SectionTitle>
      {draft ? (
        <form onSubmit={(e) => void onSave(e)} className="flex flex-col gap-3">
          <GoalFields
            draft={draft}
            onChange={(patch) => {
              setDraft((d) => (d ? { ...d, ...patch } : d));
              setProblem(null);
            }}
          />
          {problem ? <p className="m-0 text-muted">{problem}</p> : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="quiet" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {stored.sentence ? <p className="m-0">{stored.sentence}</p> : null}
          <Muted>Coach Cade plans every week around this.</Muted>
          <div>
            <Button onClick={startChange}>Change</Button>
          </div>
        </>
      )}
      <ErrorNote error={error} />
      {note ? (
        <div className="flex flex-col gap-2">
          <NoteCard key={note.id} note={note} />
          <Muted>
            <ButtonLink href="/dossier" variant="quiet">
              See it in About you
            </ButtonLink>
          </Muted>
        </div>
      ) : null}
    </section>
  );
}

export default function SettingsPage() {
  const [gate, setGate] = useState<GateState>("loading");
  const [tempo, setTempo] = useState<TempoConnection | null>(null);
  const [anthropic, setAnthropic] = useState<AnthropicConnection | null>(null);
  const [sources, setSources] = useState<SettingsSources | null>(null);
  const [goal, setGoal] = useState<StoredGoal | null>(null);
  const [appearance, setAppearance] = useState<AppearancePreference>("dark");
  const [confirming, setConfirming] = useState<"tempo" | "anthropic" | null>(null);
  const [tempoBaseUrl, setTempoBaseUrl] = useState("http://localhost:5001");
  const [tempoApiKey, setTempoApiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const [settings, storedGoal] = await Promise.all([
          fetchSettings(),
          // The goal section is extra: if it cannot load, the connections still can.
          fetchGoal().catch(() => null),
        ]);
        if (cancelled) return;
        setGoal(storedGoal);
        setTempo(settings.tempo);
        setAnthropic(settings.anthropic);
        setSources({
          tempo: settings.tempo.source,
          model: settings.anthropic.source,
          demo: settings.demo,
        });
        setAppearance(readStoredAppearance());
        if (settings.tempo.baseUrl) setTempoBaseUrl(settings.tempo.baseUrl);
        setGate("open");
      } catch (err) {
        if (!cancelled) {
          setError(describeError(err, "Couldn’t load your settings. Try again in a minute."));
        }
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSaveTempo(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const view = await putTempoConnection(tempoBaseUrl, tempoApiKey);
      setTempo(view);
      setTempoApiKey("");
      setStatus("Tempo connection saved.");
    } catch (err) {
      setError(describeError(err, "Couldn’t save that. Try again."));
    } finally {
      setBusy(false);
    }
  }

  function chooseAppearance(next: AppearancePreference) {
    setAppearance(next);
    persistAppearance(next);
  }

  async function onClearTempo() {
    setConfirming(null);
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setTempo(await deleteTempoConnection());
      setStatus("Tempo connection cleared.");
    } catch (err) {
      setError(describeError(err, "Couldn’t clear that. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function onSaveAnthropic(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const view = await putAnthropicConnection(anthropicKey);
      setAnthropic(view);
      setAnthropicKey("");
      setStatus("Anthropic key saved.");
    } catch (err) {
      setError(describeError(err, "Couldn’t save that. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function onClearAnthropic() {
    setConfirming(null);
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setAnthropic(await deleteAnthropicConnection());
      setStatus("Anthropic key cleared.");
    } catch (err) {
      setError(describeError(err, "Couldn’t clear that. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (gate !== "open") {
    return (
      <WaitingState>
        {error ? <ErrorNote error={error} /> : <p className="m-0">Loading your settings…</p>}
      </WaitingState>
    );
  }

  // An export or the offline coach is already in use: a saved key would be ignored (#6).
  const tempoOffline = sources?.tempo === "export";
  const modelOffline = sources?.model === "stub";
  const intro = sources?.demo
    ? "This demo runs on a sample running log and an offline coach. Nothing here needs a key."
    : tempoOffline && modelOffline
      ? "Cadence is running offline, from a Tempo export file with the offline coach. No keys are needed."
      : `${tempoOffline ? "Add your Anthropic API key." : modelOffline ? "Connect Tempo." : "Connect Tempo and your Anthropic API key."} Keys are encrypted at rest and never shown in full after save.`;

  return (
    <Page>
      <PageHead>
        <PageTitle>Settings</PageTitle>
        <Muted>{intro}</Muted>
      </PageHead>

      {/* No goal before the first answers: onboarding asks for it. */}
      {goal ? <TrainingGoalSection initial={goal} /> : null}

      <section className="flex flex-col gap-3" aria-label="Tempo connection">
        <SectionTitle>Tempo</SectionTitle>
        {tempoOffline ? (
          <Muted>
            {sources?.demo
              ? "In use: a sample running log."
              : "In use: a Tempo export file. To read from your Tempo instance instead, unset TEMPO_EXPORT_PATH and restart."}
          </Muted>
        ) : (
          <>
            <Muted>
              {tempo?.configured
                ? `Configured — ${tempo.baseUrl} · key ${tempo.maskedKey}`
                : "Not configured — base URL and API key required."}
            </Muted>
            <form onSubmit={(e) => void onSaveTempo(e)} className="flex flex-col gap-3">
              <Field label="Base URL">
                <Input
                  value={tempoBaseUrl}
                  onChange={(e) => setTempoBaseUrl(e.target.value)}
                  placeholder="http://localhost:5001"
                  required
                />
              </Field>
              <Field label="API key">
                <Input
                  type="password"
                  value={tempoApiKey}
                  onChange={(e) => setTempoApiKey(e.target.value)}
                  placeholder={tempo?.configured ? "Enter new key to rotate" : "tmp_…"}
                  required
                  autoComplete="off"
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" variant="primary" disabled={busy}>
                  Save Tempo
                </Button>
                <Button
                  disabled={busy || !tempo?.configured}
                  onClick={() => setConfirming("tempo")}
                >
                  Clear
                </Button>
              </div>
              {confirming === "tempo" ? (
                <ConfirmClear
                  question="Remove the Tempo connection?"
                  consequence="Coach Cade can’t see your runs until you connect again."
                  onConfirm={() => void onClearTempo()}
                  onCancel={() => setConfirming(null)}
                />
              ) : null}
            </form>
          </>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Anthropic connection">
        <SectionTitle>Anthropic</SectionTitle>
        {modelOffline ? (
          <Muted>
            {sources?.demo
              ? "In use: the offline coach."
              : "In use: the offline coach, so no API key is needed. To use Claude, set LLM_PROVIDER=anthropic and restart."}
          </Muted>
        ) : (
          <>
            <Muted>
              {anthropic?.configured
                ? `Configured — key ${anthropic.maskedKey}`
                : "Not configured — BYO API key required for coaching replies."}
            </Muted>
            <form
              onSubmit={(e) => void onSaveAnthropic(e)}
              className="flex flex-col gap-3"
            >
              <Field label="API key">
                <Input
                  type="password"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder={
                    anthropic?.configured ? "Enter new key to rotate" : "sk-ant-…"
                  }
                  required
                  autoComplete="off"
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" variant="primary" disabled={busy}>
                  Save Anthropic
                </Button>
                <Button
                  disabled={busy || !anthropic?.configured}
                  onClick={() => setConfirming("anthropic")}
                >
                  Clear
                </Button>
              </div>
              {confirming === "anthropic" ? (
                <ConfirmClear
                  question="Remove your Anthropic key?"
                  consequence="Coach Cade can’t reply until you add a key again."
                  onConfirm={() => void onClearAnthropic()}
                  onCancel={() => setConfirming(null)}
                />
              ) : null}
            </form>
          </>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Appearance">
        <SectionTitle>Appearance</SectionTitle>
        <div role="radiogroup" aria-label="Appearance" className="flex flex-wrap gap-2">
          {APPEARANCE_CHOICES.map((choice) => {
            const selected = appearance === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => chooseAppearance(choice.value)}
                className={cx(
                  "rounded-tempo border px-4 py-2.5 text-base font-semibold",
                  selected ? "border-ink bg-raised text-ink" : "border-border text-muted hover:text-ink",
                )}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
        <Muted>System follows your computer’s light or dark setting.</Muted>
      </section>

      <section className="flex flex-col gap-2" aria-label="Privacy">
        <SectionTitle>Privacy</SectionTitle>
        <Muted>
          What Coach Cade reads, what is sent to Anthropic, and what was sent last.
        </Muted>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/privacy" variant="secondary">
            Privacy
          </ButtonLink>
          <ButtonLink href="/disclaimer" variant="secondary">
            Product disclaimer
          </ButtonLink>
        </div>
      </section>

      {status && <p className="m-0 text-ok">{status}</p>}
      <ErrorNote error={error} />

      <Muted>
        <ButtonLink href="/dossier" variant="quiet">
          About you
        </ButtonLink>
      </Muted>
    </Page>
  );
}
