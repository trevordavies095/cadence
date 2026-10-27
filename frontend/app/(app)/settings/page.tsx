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
  fetchSettings,
  putAnthropicConnection,
  putTempoConnection,
  type AnthropicConnection,
  type SettingsSources,
  type TempoConnection,
} from "@/lib/api";

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

export default function SettingsPage() {
  const [gate, setGate] = useState<GateState>("loading");
  const [tempo, setTempo] = useState<TempoConnection | null>(null);
  const [anthropic, setAnthropic] = useState<AnthropicConnection | null>(null);
  const [sources, setSources] = useState<SettingsSources | null>(null);
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
        const settings = await fetchSettings();
        if (cancelled) return;
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
      <PageTitle>Settings</PageTitle>
      <Muted>{intro}</Muted>

      <section className="mt-3 flex flex-col gap-3" aria-label="Tempo connection">
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

      <section className="mt-3 flex flex-col gap-3" aria-label="Anthropic connection">
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

      <section className="mt-3 flex flex-col gap-3" aria-label="Appearance">
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

      <section className="mt-3 flex flex-col gap-2" aria-label="Privacy">
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

      {status && <p className="m-0 text-hr-zone-1">{status}</p>}
      <ErrorNote error={error} />

      <Muted>
        <ButtonLink href="/dossier" variant="quiet">
          About you
        </ButtonLink>
      </Muted>
    </Page>
  );
}
