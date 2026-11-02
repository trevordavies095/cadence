# 0005: Coach Cade can run on a self-hosted model server, chosen in Settings

**Status:** Accepted, 2026-11-01 (issue #54)

## Context

Every coach call went to Anthropic. The athlete's redacted packet (About you, the week's report, the conversation with Coach Cade) left their network on every weekly read, every mid-week message and every About you draft. Tempo keeps running data on the athlete's own hardware, and Cadence undid that the moment Coach Cade spoke. An athlete who already runs a model server at home (oMLX, Ollama, LM Studio, llama.cpp, vLLM) had no way to point Cadence at it.

ADR 0004 made the model and effort the athlete's setting, read per call. The provider is the same kind of choice.

Cadence was built and dogfooded on Claude Opus 4.7 at `xhigh`. The prompts, reply-tool schemas, length caps and call limits were tuned on that pair. A model that fits on home hardware reads a 30k-token packet differently and may fail the weekly plan's format, and nobody had measured by how much.

## Decision

- **The provider is a saved setting, read per call.** The coach model setting holds provider (`anthropic` or `self_hosted`), model and effort, resolved at the start of each coach call as in ADR 0004. A weekly reply run resolves it once for both attempts. With nothing saved, behaviour is unchanged: Anthropic, Opus 4.7, `xhigh`.
- **`LLM_PROVIDER` is unchanged.** It still means stub or live. The live adapter picks Anthropic or the self-hosted server from the saved setting.
- **One adapter, two request shapes.** Self-hosted calls go to the server's Anthropic-compatible `POST /v1/messages`, through the same adapter, stream parser, validators and ask-once-more loop. Anthropic requests are byte-for-byte what they were. The model list comes from the server's own `GET /v1/models`.
- **Self-hosted sends no `thinking` field, only `output_config.effort`.** The field is optional in the Messages spec, and servers disagree on it: vLLM refuses `enabled` without `budget_tokens`, then refuses the budget unless the server has a reasoning config, and Ollama has no adaptive mode. Leaving it out is the one shape every tested server accepted. Reasoning models think by the server's default, and the docs say how to switch thinking on where it is off (Gemma 4).
- **The key goes in both headers.** When a key is saved it is sent as `x-api-key` and as `Authorization: Bearer`. vLLM reads only Bearer; oMLX reads either.
- **A longer silence limit.** A self-hosted call waits 10 minutes for data (`SELF_HOSTED_IDLE_TIMEOUT_MS`) where Anthropic waits 60 seconds. The 15-minute overall cap is shared.
- **No Compose profile.** Cadence does not run the model server. Servers differ by platform and hardware, and the athlete who wants this already runs one.
- **No header setting.** Sending the key both ways covers every server we know, so Settings asks nothing about headers.
- **No per-provider memory.** Switching provider resets model and effort to that provider's default. Both connections are kept, but no model or effort is remembered per provider.
- **The benchmark report is published alongside, and Settings recommends no model.** `docs/reports/local-models-2026-11.md` shows what each tested model got right and wrong against the baseline. Settings links to it and marks no model as recommended.
- **Anthropic stays the default.** Opus 4.7 at `xhigh` stays the tested default (ADR 0004).

## Consequences

- An athlete with a model server can keep their coaching context on their own network, and the privacy page names the host and says "stays on your network" only for a local host.
- The call log records `self_hosted`, the model and the server host, so a reply can be traced to the server that wrote it.
- Thinking and effort depend on the server. A server may map an effort level, ignore it, or refuse it (Qwen3.8-27B on vLLM refuses `high`), and a model whose server leaves thinking off answers without thinking. The docs cover the servers tested.
- Smaller models fail the weekly plan's format far more often than Opus 4.7. Prompts and schemas were not tuned for them; the report says where they fail.
- A second adapter (OpenAI-style, or JSON-schema output) is not built. The report says whether one is worth it. #53 adds its own provider value when it lands.
- Re-adding a Compose profile, a header setting or per-provider memory would each need its own reason. None had one here.
