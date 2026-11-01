"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, cx, ErrorNote, Field, Input, Muted, SectionTitle, Select } from "@/components/ui";
import { ConfirmClear } from "@/components/ConfirmClear";
import {
  deleteSelfHostedConnection,
  fetchCoachModel,
  fetchSelfHostedConnection,
  putSelfHostedConnection,
  resetCoachModel,
  saveCoachModel,
  type CoachEffort,
  type CoachModelSettings,
  type CoachProvider,
  type SelfHostedConnection,
} from "@/lib/api";
import { ApiError, describeError, type UiError } from "@/lib/errors";

const EFFORTS: { value: CoachEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

const ALL_EFFORTS = EFFORTS.map((e) => e.value);

const PROVIDERS: { value: CoachProvider; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "self_hosted", label: "Self-hosted" },
];

const effortLabel = (effort: CoachEffort) => EFFORTS.find((e) => e.value === effort)!.label;

const providerOf = (view: CoachModelSettings): CoachProvider => view.provider ?? "anthropic";

/**
 * What the picker starts on for one provider's list: its saved choice, else its default
 * (Anthropic: the tested default; self-hosted: nothing chosen).
 */
function selectionFor(view: CoachModelSettings): { model: string; effort: CoachEffort | null } {
  if (providerOf(view) === "self_hosted") {
    return { model: view.saved?.model ?? "", effort: view.saved?.effort ?? null };
  }
  return { model: view.effective.model, effort: view.effective.effort };
}

/**
 * The level a model falls back to when it can't take the one chosen: the nearest
 * level below it, else the lowest it has. Never silently more costly.
 */
function nearestEffort(wanted: CoachEffort, supported: CoachEffort[]): CoachEffort {
  const order = EFFORTS.map((e) => e.value);
  const below = order.slice(0, order.indexOf(wanted)).reverse().find((e) => supported.includes(e));
  return below ?? order.find((e) => supported.includes(e)) ?? wanted;
}

/** Self-hosted refusals in words about the athlete's server rather than an Anthropic key. */
const SELF_HOSTED_ERRORS: Record<string, string> = {
  baseUrl_required: "Enter your server’s address.",
  invalid_baseUrl: "That address isn’t valid. Use a full address starting with http:// or https://.",
  invalid_apiKey: "That key isn’t valid. Enter it again, or leave it blank.",
  no_self_hosted_connection: "Save your server’s address first.",
  unknown_model: "That model isn’t on your server’s list. Choose another one.",
};

function describeSelfHostedError(err: unknown, fallback: string): UiError {
  if (err instanceof ApiError && err.code && SELF_HOSTED_ERRORS[err.code]) {
    return SELF_HOSTED_ERRORS[err.code];
  }
  return describeError(err, fallback);
}

/**
 * The athlete's own model server: base URL and an optional key, with save and clear,
 * in the same pattern as the Anthropic key section.
 */
function SelfHostedConnectionFields({
  connection,
  busy,
  onBusy,
  onChanged,
}: {
  connection: SelfHostedConnection;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onChanged: (next: SelfHostedConnection, status: string) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    onBusy(true);
    setError(null);
    try {
      // A blank key keeps the saved one.
      const key = apiKey.trim();
      const next = await putSelfHostedConnection(key ? { baseUrl, apiKey: key } : { baseUrl });
      setApiKey("");
      if (next.baseUrl) setBaseUrl(next.baseUrl);
      onChanged(next, "Model server saved.");
    } catch (err) {
      setError(describeSelfHostedError(err, "Couldn’t save that. Try again."));
    } finally {
      onBusy(false);
    }
  }

  async function onClear() {
    setConfirming(false);
    onBusy(true);
    setError(null);
    try {
      const next = await deleteSelfHostedConnection();
      setBaseUrl("");
      setApiKey("");
      onChanged(next, "Model server cleared.");
    } catch (err) {
      setError(describeError(err, "Couldn’t clear that. Try again."));
    } finally {
      onBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSave(e)} className="flex flex-col gap-3">
      <Muted>
        {connection.configured
          ? `Configured — ${connection.baseUrl} · ${
              connection.keyConfigured ? `key ${connection.maskedKey}` : "no key"
            }`
          : "Not configured — your server’s base URL is required."}
      </Muted>
      <Field label="Base URL">
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:8000"
          required
          autoComplete="off"
        />
      </Field>
      <Field label="API key" hint="Only if your server asks for one.">
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={connection.keyConfigured ? "Leave blank to keep the saved key" : "Optional"}
          autoComplete="off"
        />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" disabled={busy}>
          Save server
        </Button>
        <Button disabled={busy || !connection.configured} onClick={() => setConfirming(true)}>
          Clear
        </Button>
      </div>
      {confirming ? (
        <ConfirmClear
          question="Remove your model server?"
          consequence="Coach Cade can’t reply from your server until you add it again."
          onConfirm={() => void onClear()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
      <ErrorNote error={error} />
    </form>
  );
}

/**
 * Coach Cade's provider, model and thinking level (#52, #54). Shown only with the live
 * coach: in demo mode and with the offline coach there is nothing to choose.
 */
export function CoachModelSection({ offline, demo }: { offline: boolean; demo: boolean }) {
  /** What is saved: its provider, and whether anything is saved at all. */
  const [savedProvider, setSavedProvider] = useState<CoachProvider>("anthropic");
  const [hasSaved, setHasSaved] = useState(false);
  /** The saved setting has been read; until then there is no provider to show. */
  const [loaded, setLoaded] = useState(false);
  /** The provider control; the list below is that provider's. */
  const [provider, setProvider] = useState<CoachProvider>("anthropic");
  const [settings, setSettings] = useState<CoachModelSettings | null>(null);
  const [connection, setConnection] = useState<SelfHostedConnection | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<CoachEffort | null>("xhigh");
  const [adjusted, setAdjusted] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the latest list request may fill the picker.
  const listRequest = useRef(0);

  /** Fill the picker from one provider's list: its saved choice, else its default. */
  function show(next: CoachModelSettings) {
    const choice = selectionFor(next);
    setSettings(next);
    setModel(choice.model);
    setEffort(choice.effort);
    setAdjusted(null);
  }

  /** A view of what is saved (load, save, reset): the control follows it. */
  function showSaved(next: CoachModelSettings) {
    // A list still loading for the old provider must not replace this one.
    listRequest.current += 1;
    setLoaded(true);
    setSavedProvider(providerOf(next));
    setHasSaved(next.saved != null);
    setProvider(providerOf(next));
    show(next);
  }

  useEffect(() => {
    if (offline) return;
    let cancelled = false;
    fetchCoachModel()
      .then((next) => {
        if (cancelled) return;
        const choice = selectionFor(next);
        setLoaded(true);
        setSavedProvider(providerOf(next));
        setHasSaved(next.saved != null);
        setProvider(providerOf(next));
        setSettings(next);
        setModel(choice.model);
        setEffort(choice.effort);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err, "Couldn’t load Coach Cade’s model. Try again."));
      });
    return () => {
      cancelled = true;
    };
  }, [offline]);

  // The server details are read once Self-hosted is chosen.
  const wantsConnection = !offline && provider === "self_hosted" && connection == null;
  useEffect(() => {
    if (!wantsConnection) return;
    let cancelled = false;
    fetchSelfHostedConnection()
      .then((next) => {
        if (!cancelled) setConnection(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err, "Couldn’t load your model server. Try again."));
      });
    return () => {
      cancelled = true;
    };
  }, [wantsConnection]);

  /** Load one provider's list; with `keepChoice`, keep the model chosen if still listed. */
  async function loadList(next: CoachProvider, keepChoice: boolean) {
    const request = ++listRequest.current;
    try {
      const view = await fetchCoachModel(next);
      if (request !== listRequest.current) return;
      if (keepChoice && model && view.models.some((m) => m.id === model)) {
        setSettings(view);
      } else {
        show(view);
      }
    } catch (err) {
      if (request === listRequest.current) {
        setError(describeError(err, "Couldn’t load the model list. Try again."));
      }
    }
  }

  if (offline) {
    return (
      <section className="flex flex-col gap-3" aria-label="Coach model">
        <SectionTitle>Coach model</SectionTitle>
        <Muted>
          {demo
            ? "This demo uses the offline coach, so there is no model to choose."
            : "In use: the offline coach, so there is no model to choose. To use Claude, set LLM_PROVIDER=anthropic and restart."}
        </Muted>
      </section>
    );
  }

  const selfHosted = provider === "self_hosted";
  const listed = settings != null && providerOf(settings) === provider ? settings : null;
  const models = listed?.models ?? [];
  const selected = models.find((m) => m.id === model);
  const supported = selfHosted ? (selected?.efforts ?? ALL_EFFORTS) : (selected?.efforts ?? []);
  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id;
  const unchanged =
    listed != null &&
    provider === savedProvider &&
    model === listed.effective.model &&
    effort === listed.effective.effort;
  const canSave =
    listed != null &&
    !unchanged &&
    !!model &&
    effort != null &&
    (!selfHosted || connection?.configured === true);

  function chooseProvider(next: CoachProvider) {
    if (next === provider) return;
    setProvider(next);
    setSettings(null);
    setModel("");
    setEffort(null);
    setAdjusted(null);
    setStatus(null);
    setError(null);
    void loadList(next, false);
  }

  function chooseModel(id: string) {
    setModel(id);
    setStatus(null);
    const next = models.find((m) => m.id === id);
    if (next && effort && !next.efforts.includes(effort)) {
      const fallback = nearestEffort(effort, next.efforts);
      setAdjusted(
        `${next.displayName} can’t think at ${effortLabel(effort)}, so this is set to ${effortLabel(fallback)}.`,
      );
      setEffort(fallback);
    } else {
      setAdjusted(null);
    }
  }

  function onConnectionChanged(next: SelfHostedConnection, message: string) {
    setConnection(next);
    setError(null);
    setStatus(message);
    // Another server lists other models.
    void loadList("self_hosted", true);
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!effort) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // Anthropic is the provider when none is sent, as before #54.
      const next = await saveCoachModel(
        selfHosted ? { provider: "self_hosted", model, effort } : { model, effort },
      );
      showSaved(next);
      setStatus(
        `Saved. Coach Cade uses ${nameOf(next.effective.model)} at ${effortLabel(next.effective.effort)} from the next reply.`,
      );
    } catch (err) {
      // Keep the athlete's selection so they can change it and try again.
      setError(
        selfHosted
          ? describeSelfHostedError(err, "Couldn’t save that. Try again.")
          : describeError(err, "Couldn’t save that. Try again."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function onReset() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      showSaved(await resetCoachModel());
      setStatus("Back to the tested default.");
    } catch (err) {
      setError(describeError(err, "Couldn’t reset that. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const effortPicker = (
    <div role="radiogroup" aria-label="Thinking level" className="flex flex-wrap gap-2">
      {EFFORTS.map((choice) => {
        const available = supported.includes(choice.value);
        const checked = effort === choice.value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={!available || busy}
            onClick={() => {
              setEffort(choice.value);
              setAdjusted(null);
              setStatus(null);
            }}
            className={cx(
              "rounded-tempo border px-4 py-2.5 text-base font-semibold",
              checked ? "border-ink bg-raised text-ink" : "border-border text-muted hover:text-ink",
              !available && "cursor-not-allowed opacity-40 hover:text-muted",
            )}
          >
            {choice.label}
          </button>
        );
      })}
    </div>
  );

  const actions = (
    <div className="flex flex-wrap gap-3">
      <Button type="submit" variant="primary" disabled={busy || !canSave}>
        Save model
      </Button>
      {hasSaved ? (
        <Button variant="quiet" disabled={busy} onClick={() => void onReset()}>
          Reset to tested default
        </Button>
      ) : null}
    </div>
  );

  const selfHostedFallback =
    listed?.fallback === "no_connection"
      ? "Save your server’s address to see its models."
      : listed?.fallback === "unavailable"
        ? models.length > 0
          ? "Couldn’t load the model list from your server. Your saved model is still shown."
          : "Couldn’t load the model list from your server."
        : null;

  return (
    <section className="flex flex-col gap-3" aria-label="Coach model">
      <SectionTitle>Coach model</SectionTitle>
      {loaded ? (
        <div role="radiogroup" aria-label="Provider" className="flex flex-wrap gap-2">
          {PROVIDERS.map((choice) => {
            const checked = provider === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={busy}
                onClick={() => chooseProvider(choice.value)}
                className={cx(
                  "rounded-tempo border px-4 py-2.5 text-base font-semibold",
                  checked ? "border-ink bg-raised text-ink" : "border-border text-muted hover:text-ink",
                )}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {selfHosted ? (
        <>
          {connection ? (
            <SelfHostedConnectionFields
              connection={connection}
              busy={busy}
              onBusy={setBusy}
              onChanged={onConnectionChanged}
            />
          ) : error ? null : (
            <Muted>Loading…</Muted>
          )}
          {listed ? (
            <form onSubmit={(e) => void onSave(e)} className="flex flex-col gap-3">
              {models.length > 0 ? (
                <Field label="Model">
                  <Select value={model} onChange={(e) => chooseModel(e.target.value)} disabled={busy}>
                    {model ? null : (
                      <option value="" disabled>
                        Choose a model
                      </option>
                    )}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {selfHostedFallback ? <Muted>{selfHostedFallback}</Muted> : null}
              <Muted>
                Self-hosted models have not been measured against the tested default and may coach
                differently, follow Coach Cade’s guidance less closely, or fail more often.
              </Muted>
              {effortPicker}
              {adjusted ? <p className="m-0">{adjusted}</p> : null}
              <Muted>Your server may map these levels onto its own, or ignore them.</Muted>
              {actions}
            </form>
          ) : null}
        </>
      ) : listed ? (
        <form onSubmit={(e) => void onSave(e)} className="flex flex-col gap-3">
          <Muted>
            Cadence was built and tested on {nameOf(listed.tested.model)} at{" "}
            {effortLabel(listed.tested.effort)}. Other choices work, but Coach Cade may coach
            differently, follow its instructions less closely, and fail to reply more often.
          </Muted>
          <Field label="Model">
            <Select value={model} onChange={(e) => chooseModel(e.target.value)} disabled={busy}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.tested ? `${m.displayName} · tested` : m.displayName}
                </option>
              ))}
            </Select>
          </Field>
          {listed.fallback ? (
            <Muted>
              {listed.fallback === "no_key"
                ? "Save your Anthropic key to see other models."
                : "Couldn’t load the models your key can use, so only these are shown. Try again later."}
            </Muted>
          ) : null}
          {effortPicker}
          {adjusted ? <p className="m-0">{adjusted}</p> : null}
          <Muted>
            Higher levels think longer, so replies are slower and cost more. Max can take several
            minutes.
          </Muted>
          {actions}
        </form>
      ) : error ? null : (
        <Muted>Loading…</Muted>
      )}
      {status ? <p className="m-0 text-ok">{status}</p> : null}
      <ErrorNote error={error} />
    </section>
  );
}
