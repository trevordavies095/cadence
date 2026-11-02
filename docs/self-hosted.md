# Run Coach Cade on your own model server

Coach Cade can run on a model server you host yourself instead of on Anthropic. Your coaching context then goes to that server and nowhere else. This page covers what Cadence needs from the server, how to set it up, and which servers and models have been tested.

Anthropic, Claude Opus 4.7 at `xhigh`, stays the default and the tested setup. Cadence's prompts and reply formats were tuned on it. A model you host will coach differently, and smaller models often fail the weekly plan's format. Settings recommends no model. The benchmark in [`docs/reports/local-models-2026-11.md`](reports/local-models-2026-11.md) shows what each tested model got right and wrong, so read it before you switch.

- [What your server needs](#what-your-server-needs)
- [Raise the context length](#raise-the-context-length) (start here if Test connection said the message was cut)
- [Set it up in Cadence](#set-it-up-in-cadence)
- [Tested on](#tested-on)
- Servers: [oMLX](#omlx) · [Ollama](#ollama) · [LM Studio](#lm-studio) · [llama.cpp](#llamacpp) · [vLLM](#vllm)

## What your server needs

- **The Anthropic Messages endpoint.** Cadence calls `POST /v1/messages` with streaming and lists models with `GET /v1/models`. It does not use the OpenAI-style `/v1/chat/completions`.
- **Tool calls.** Every reply from Coach Cade comes back as a tool call. The server must parse your model's tool-call format.
- **The `strict` flag.** Cadence marks every reply tool `strict: true`. Your server may enforce the tool's format, ignore the flag, or reject it. A server that rejects it fails every coach call, and the error shows the server's message. Test connection sends no tool, so it does not catch this.
- **A context of at least 64k tokens** (65,536). A weekly read sends about 21k tokens on average and up to 36k. A mid-week message sends about 28k. Replies are 3k to 9k tokens, thinking included, and must fit too.
- **A reasoning model, ideally.** Cadence asks for an effort level and expects the model to think before it replies.

## Raise the context length

Many servers start every model with a short context, often 4k to 32k, whatever the model itself supports. A prompt longer than that is cut, and the server may still answer as if nothing was missing. Set the context to at least `65536`, restart or reload the model, and run Test connection again.

| Server | Setting |
|---|---|
| oMLX | The model's context setting in oMLX's per-model settings. oMLX advertises 32k by default. |
| Ollama | `OLLAMA_CONTEXT_LENGTH=65536` in the server's environment, or `PARAMETER num_ctx 65536` in a Modelfile |
| LM Studio | **Context Length** in the model's load settings, or `lms load <model> --context-length 65536` |
| llama.cpp | `--ctx-size 65536` on `llama-server` |
| vLLM | `--max-model-len 65536` on `vllm serve` |

A bigger context needs more memory. If the model no longer loads, pick a smaller model or a smaller quantisation rather than cutting the context below 64k.

## Set it up in Cadence

1. Start your model server with a model loaded (see your server's section below).
2. Make sure the live coach is on: `LLM_PROVIDER=anthropic` in your `.env`. The name is historical: it means "live", and the saved setting then picks Anthropic or your server. With the stub, Settings hides the coach model section.
3. In **Settings**, under the coach model, choose **Self-hosted**.
4. Enter the **Base URL**, for example `http://<your-server>:8000`. Cadence adds `/v1/messages` and `/v1/models` itself. A URL that already ends in `/v1` is fine.
5. Enter the **API key** if your server asks for one, and save the server.
6. Pick a **Model** from the list your server returns, and a thinking level.
7. Press **Test connection**, then save.

The change applies on the next coach call. No restart is needed. Switching provider resets the model and effort to that provider's default. Your Anthropic key and your server details are both kept, so you can switch back and forth.

### Running Cadence in Docker

Inside the API container, `localhost` is the container itself, not your machine. If the model server runs on the same machine as Cadence's Compose stack, use `http://host.docker.internal:<port>` as the base URL.

Docker Desktop (macOS, Windows) knows that name already. On Linux, add this to the `api` service in your compose file:

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

On Linux the container reaches the host through Docker's bridge, so the server must also listen on more than `127.0.0.1` (see each server's LAN setting below).

A server on another machine needs no change: use that machine's address or name.

### The key

The key is optional. Leave it blank if your server does not check one. When you enter one, Cadence stores it encrypted, like your Anthropic key, and Settings shows only its last four characters.

Cadence sends the key in both styles, `x-api-key` and `Authorization: Bearer`, so you do not need to know which one your server reads. vLLM, for example, reads only `Authorization: Bearer`.

Leave the key field blank to keep the saved key when you save the server again. Clear the server to remove it.

### Privacy

The privacy page shows the host your coaching context is sent to. It adds "This stays on your network." only when the host is local: `localhost` or another loopback address, `host.docker.internal`, a private address (one starting with 10, 172.16 to 172.31, or 192.168), a link-local address, a CGNAT address (100.64 to 100.127, which Tailscale uses), a name ending in `.local` or `.lan`, or a bare name with no dot. For any other host it says the host is outside your network.

The check reads only the address. A rented GPU reached through an SSH tunnel on `localhost` counts as local, even though your data leaves home. You know where the tunnel ends; the privacy page does not.

Turning on a server's LAN setting exposes a model server to everyone on your network. Most servers have no login, so anyone who can reach the port can use your model. Set a key where the server supports one, and keep the port off the internet.

### Thinking and effort

Cadence sends the effort you pick as `output_config.effort` and sends no `thinking` field. Servers disagree on that field, so leaving it out is the one request every tested server accepts. A reasoning model then thinks by the server's own default.

Most reasoning models think by default. Some do not: Gemma 4 needs thinking switched on in the server (see [oMLX](#omlx) and [vLLM](#vllm)). To check, send Coach Cade a message, then open the latest call in the call log (`GET /llm-calls`, then `GET /llm-calls/<id>` on the API, port 5002 under Compose) and look for a `thinking` block in the raw response. oMLX and vLLM report no thinking token counts, so the log shows those as empty even when the model thought.

Servers treat the effort in three ways: they map it onto the model's own levels, ignore it, or refuse it. A refused level fails the call with the server's own message. Qwen3.8-27B on vLLM refuses `high` and accepts `low`, `medium` and `xhigh`. If a coach call fails with an effort error, pick another level.

### Test connection

Test connection runs two checks on the saved server:

1. It lists the server's models with your key. This fails fast on a wrong address or a refused key.
2. It sends the chosen model a long test message, about 40k tokens, at `low` effort. A code word sits on the first line, and the model is asked to reply with it.

The message counts as **cut** when the server reports under 90 percent of the tokens sent, or the reply misses the code word. Raise the context length (see [above](#raise-the-context-length)) and test again.

The test can take several minutes on home hardware, up to the 10-minute silence limit. It always uses `low`, so it does not check that your server accepts the level you saved.

A model can also miss the word for another reason. Gemma 4 on oMLX once copied the test text back instead of answering, and the test said "cut" though the server had read every token. If the token count shown is close to the total and only the word is missing, the context is probably fine.

### Time limits

A self-hosted call is aborted after 10 minutes with no data from the server (`SELF_HOSTED_IDLE_TIMEOUT_MS`). Every call, on any provider, is also capped at 15 minutes overall (`ANTHROPIC_TIMEOUT_MS`).

The overall cap is the one that matters on slow hardware. Some servers, oMLX among them, send keep-alive pings while they work, so the silence limit never fires. A large model at a high effort can still be thinking when 15 minutes run out. Lower the effort, use a faster model, or raise `ANTHROPIC_TIMEOUT_MS` and keep `FRONTEND_PROXY_TIMEOUT_MS` above it.

## Tested on

Each model below was run through every coach operation (a weekly read, a mid-week message, a message with a run attached, an About you draft, a fix and a tidy-up) and the context test, with the smoke script in `api/scripts/smoke-self-hosted.ts`. Effort was `high` unless the row says otherwise.

A row that says "works" means the server and model ran every operation. How often each model's replies were valid, and how its plans compare with the tested default, is in the [benchmark report](reports/local-models-2026-11.md).

| Server | Version | Hardware | Model | Context | Date | Outcome |
|---|---|---|---|---|---|---|
| oMLX | 0.7.3 | MacBook Pro M4 Pro, 24 GB | gpt-oss-20b-MXFP4-Q8 | 131,072 | 2026-11-01 | Works, but in the benchmark only 14 of 35 replies were valid as sent (9 of 28 weekly plans). A weekly read took about 1 to 3 minutes. |
| oMLX | 0.7.3 | MacBook Pro M4 Pro, 24 GB | gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B | 262,144 | 2026-11-01 | Works, but weekly plans are often refused for their format (a run with no type). A weekly read took about 4 to 10 minutes. |
| oMLX | 0.7.3 | MacBook Pro M4 Pro, 24 GB | Qwen3.8-27B-lean-4bit-mlx | 262,144 | 2026-11-01 | Loads (13.7 GB), but cannot finish a weekly read inside the 15-minute cap at `high` or `medium`. |
| vLLM | 0.32.0 | 1 × H100 80 GB | gpt-oss-120b | 65,536 | 2026-11-01 | Works. In the benchmark 27 of 35 replies were valid as sent; the 8 failures were weekly plans refused for their format. A weekly read took about a minute. |
| vLLM | 0.32.0 | 1 × H100 80 GB | Qwen3.8-27B | 65,536 | 2026-11-01 | Works at `medium` and `xhigh`; the server refuses `high`. A weekly read took about 2 minutes at `medium` and 373 s at `xhigh`. |
| vLLM | 0.32.0 | 1 × H100 80 GB | Gemma 4 26B-A4B | 65,536 | 2026-11-01 | Works, with thinking switched on. Weekly plans are often refused for their format. A weekly read took about 2 to 3 minutes. |
| Ollama | – | – | – | – | – | Expected to work, not tested. |
| LM Studio | – | – | – | – | – | Expected to work, not tested. |
| llama.cpp | – | – | – | – | – | Expected to work, not tested. |

Context is what the server reported for the model. Qwen3-14B was not tried: its 40,960-token context is below the 64k Cadence needs.

The format failures come from the model, not the server: the same models fail the same way on both. Cadence asks once more when a weekly reply is refused for its format, but a model that makes the same mistake twice still fails the week. The [benchmark report](reports/local-models-2026-11.md) has the numbers.

## oMLX

oMLX serves MLX models on Apple silicon. It speaks the Messages endpoint natively.

- **Install:** see the oMLX project, [github.com/jundot/omlx](https://github.com/jundot/omlx).
- **LAN:** start it with `--host 0.0.0.0`. oMLX refuses to listen on anything but loopback without a key, which is a good default.
- **Key:** `--api-key <key>` or the `OMLX_API_KEY` environment variable. oMLX accepts it in either header.
- **Context:** oMLX advertises 32k for every model by default, whatever the model supports. Raise it in the model's settings to at least 65,536, then run Test connection.
- **Memory:** for a larger model, raise oMLX's process memory cap with `--max-process-memory`. On a 24 GB Mac, Qwen3.8-27B lean 4-bit loaded in 13.7 GB of a 17.9 GB budget. gpt-oss-20b (MXFP4) needs about 13 GB.
- **Thinking:** gpt-oss and Qwen3.8 think by default. For Gemma 4, switch on **Enable Thinking** in oMLX's per-model settings.
- **Models:** the list comes from `/v1/models` and can include `model:profile` entries. Pick the one whose profile you want.
- **Version:** oMLX's own `GET /api/status` shows it. `/v1/models` and replies only say `server: uvicorn`.
- **Quirks:** oMLX reports no thinking token counts. It sends pings while it works, so a stalled call runs to the 15-minute cap rather than the silence limit. Installing a model while a call runs made oMLX rescan its models and stall that call.

Tested on oMLX 0.7.3, MacBook Pro M4 Pro 24 GB, 2026-11-01: gpt-oss-20b-MXFP4-Q8 (works; many weekly plans refused for format), gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B (works, format refusals), Qwen3.8-27B-lean-4bit-mlx (too slow).

## Ollama

- **Install:** [ollama.com](https://ollama.com). Use a version that serves the Anthropic Messages endpoint.
- **LAN:** set `OLLAMA_HOST=0.0.0.0` in the server's environment. Ollama has no login, so this opens the model to anyone on your network.
- **Key:** Ollama checks none. Leave the key blank.
- **Context:** `OLLAMA_CONTEXT_LENGTH=65536` in the server's environment, or `PARAMETER num_ctx 65536` in a Modelfile for that model.
- **Thinking and effort:** Ollama maps effort names onto the model's own levels. Check the call log for a thinking block.
- **Quirks:** Ollama ignores `tool_choice` (Cadence sends `auto`, so this does no harm). Its token counts are approximate, which can make Test connection's count look a little off.

Expected to work, not tested.

## LM Studio

- **Install:** [lmstudio.ai](https://lmstudio.ai), version 0.4.1 or later for the Messages endpoint.
- **LAN:** start the server from the Developer tab and switch on serving on the local network, or run `lms server start`. Its default port is 1234.
- **Key:** LM Studio needs a key value, but does not check it. Enter any text in the API key field.
- **Context:** set **Context Length** in the model's load settings, or load it with `lms load <model> --context-length 65536`.
- **Thinking:** check the call log for a thinking block.

Expected to work, not tested.

## llama.cpp

- **Install:** [github.com/ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp). Use `llama-server`.
- **Start:** `llama-server -m <model>.gguf --jinja --ctx-size 65536 --host 0.0.0.0 --port 8080 --api-key <key>`. `--jinja` is needed for tool calls.
- **LAN:** `--host 0.0.0.0`. Without `--api-key` the server is open to your network.
- **Key:** `--api-key <key>`.
- **Context:** `--ctx-size 65536`.
- **Thinking:** depends on the model's chat template. Check the call log for a thinking block.
- **Quirks:** there is a reported bug where a stop sequence ends the reply in the middle of thinking. If replies end early with no tool call, that may be it.

Expected to work, not tested.

## vLLM

vLLM suits a GPU server, at home or rented.

- **Install:** [docs.vllm.ai](https://docs.vllm.ai), version 0.11.1 or later for the Messages endpoint.
- **LAN:** `vllm serve` listens on all addresses unless you pass `--host`. To keep it private, pass `--host 127.0.0.1` and reach it through an SSH tunnel.
- **Key:** `--api-key <key>`. vLLM checks only `Authorization: Bearer`; a key in `x-api-key` alone gets a 401. Cadence sends both, so this just works. vLLM masks the key in its own logs.
- **Context:** `--max-model-len 65536`.
- **Tool calls:** `--enable-auto-tool-choice` plus the right parsers for the model (below).
- **Effort:** vLLM passes the effort to the model's chat template, which may refuse a level. Qwen3.8-27B refuses `high`.

Commands that worked on vLLM 0.32.0, each with `--enable-auto-tool-choice --max-model-len 65536 --api-key <key>` added:

| Model | Flags |
|---|---|
| gpt-oss-120b | `--tool-call-parser openai --reasoning-parser openai_gptoss` |
| Qwen3.8-27B | `--reasoning-parser qwen3 --tool-call-parser qwen3_coder --max-num-seqs 16` |
| Gemma 4 26B-A4B | `--reasoning-parser gemma4 --tool-call-parser gemma4 --default-chat-template-kwargs '{"enable_thinking": true}'` |

For example:

```bash
vllm serve <model-path> --served-model-name gpt-oss-120b \
  --enable-auto-tool-choice --tool-call-parser openai --reasoning-parser openai_gptoss \
  --max-model-len 65536 --api-key "$VLLM_API_KEY"
```

- Qwen3.8 needs `--max-num-seqs 16`. Its hybrid layers need one cache block per sequence, and the default of 1024 fails at startup.
- Gemma 4 does not think unless `enable_thinking` is set as above.

Tested on vLLM 0.32.0, one H100 80 GB, 2026-11-01: gpt-oss-120b (works; some weekly plans refused for format), Qwen3.8-27B (works; `high` refused, slow at `xhigh`), Gemma 4 26B-A4B (works, format refusals).
