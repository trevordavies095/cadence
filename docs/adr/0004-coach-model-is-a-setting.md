# 0004: Coach Cade's model and effort are the athlete's setting, not server config

**Status:** Accepted, 2026-11-01 (issue #52). See ADR 0005 for the provider.

## Context

Coach Cade's model and thinking effort were fixed when the API started, from `ANTHROPIC_MODEL` and `ANTHROPIC_EFFORT`. Trying a cheaper or newer model, or a lower effort for faster replies, meant editing an env file and restarting.

Cadence has one athlete, who brings their own Anthropic key and pays for every call. A server-level setting that overrides what the athlete chose protects no one, and keeping two sources of truth (the env file and Settings) means a value can be changed in one place and quietly ignored because of the other.

Cadence was built and dogfooded on Claude Opus 4.7 at `xhigh` effort. The prompts, the reply-tool schemas, the length caps and the 15-minute call limit were all tuned against that pair. Other models and efforts work at the API level, but they can coach differently, follow the prompts less closely, and fail schema validation more often.

## Decision

- **The pair is athlete data.** The model and effort a coach call uses come from the saved coach model setting, read per call like the API key. With nothing saved, the built-in default applies: `claude-opus-4-7` at `xhigh`, the **tested default**.
- **No env vars.** `ANTHROPIC_MODEL` and `ANTHROPIC_EFFORT` are removed. A value still set in an environment is ignored, without a warning.
- **One pair per run.** A run that may ask more than once (the weekly reply, asked once more when refused for its shape, ADR 0002) resolves the pair once and uses it for every attempt.
- **Effort only.** "Thinking level" means `output_config.effort`. Adaptive thinking with summaries, `tool_choice: auto`, `max_tokens` and the call timeout stay fixed for every model.
- **No fallback between models.** A model that is retired, refused or not permitted for the account fails the call with Anthropic's message. Nothing retries on another model.

## Consequences

- Changing the model needs no restart, and the call log shows the model and effort each call actually sent.
- Opus 4.7 / `xhigh` stays the tested default until a change to it is replayed through the weekly-read checks (ADR 0003). Choosing anything else is the athlete's call, and Settings says other choices may behave differently.
- Tools that run outside the app, such as the weekly-read replay, take the model and effort as explicit flags, and never read the saved setting.
- Re-adding an env override would bring back the two-sources problem. Don't.
