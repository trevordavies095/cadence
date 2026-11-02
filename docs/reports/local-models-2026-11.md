# Self-hosted models against Coach Cade's default, November 2026

Cadence was built and tested on Claude Opus 4.7 at `xhigh`. That is still the default, and Settings recommends no other model. This report measures what changes when Coach Cade runs on a model you host yourself, so you can decide before you switch. It is about models, not machines: if you can run one of these models, this is how it coaches.

It is also the maintainer's tuning record: what broke, and which changes to Cadence would fix it. Sections 5, 7 and 10 are written for that. The rest is written for an athlete.

## 1. What was measured

On 2026-11-01, five self-hosted configurations and Opus 4.7 each answered the same 35 coach calls once:

- 17 from the demo athlete: 10 weekly reads, 4 mid-week replies (two with a run attached), an About you first draft, an About you fix and an About you tidy-up. The 10 weekly reads include a marathon week and a week with an Achilles injury.
- 18 weekly reads from three made-up six-week seasons: staying fit, a 10k, and a return from injury.

Each reply went through Cadence's real checks, the same ones the app uses. A weekly read whose plan fails those checks is sent once more, as in the app. Every plan was then compared with Opus 4.7's plan for the same week.

**The result.** In this single run, only one self-hosted model matched Opus 4.7 on format: Qwen3.8-27B, run at full precision on a rented data-centre GPU at `medium`, sent a valid reply to all 35 calls, and its plans were close to Opus's. gpt-oss-120b, on the same GPU, was valid on 27 of 35 and was the fastest. Gemma 4 (full and pruned 4-bit) and gpt-oss-20b were valid on 14 to 16 of 35. Almost all of their failures were weekly plans in a shape Cadence refuses, so the athlete gets no plan that week. On a 24 GB Mac, the two models that fit both failed most weekly reads, and gpt-oss-20b sent one plan for the injury week that added a tempo session and lengthened the long run. A simulation shows that small changes to Cadence could accept 62 of the 68 failed replies it could read back. None of those changes are made yet.

## 2. Setup

Cadence and the benchmark script ran on a Mac mini (M4, 24 GB). The models ran in three places at the same time:

- **Anthropic API:** Opus 4.7 at `xhigh`, Cadence's tested default. Cost $6.15 for the 35 replies, from saved usage.
- **MacBook Pro (M4 Pro, 24 GB), oMLX 0.7.3:** the models that fit in 24 GB, one at a time, at 64k context or more.
- **One rented H100 80 GB, vLLM 0.32.0:** larger or full-precision models, at 64k context.

The rented rows stand for anyone who can run that model. Quality depends on the model and its quantisation, not on the machine. Speed is only for the hardware each row ran on: the same model on your hardware will be faster or slower.

The models as served:

| Model id | Where | Quantisation | Weights in memory | Context | Effort | Notes |
|---|---|---|---|---|---|---|
| claude-opus-4-7 | Anthropic API | – | – | – | `xhigh` | The baseline every plan is compared with. |
| gemma-4-26b-a4b | H100, vLLM | none (bf16), not pruned | about 49 GB | 65,536 | `high` | Thinking switched on with `enable_thinking` in the chat template kwargs. |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B | MacBook, oMLX | 4-bit, and pruned to about 14B parameters | about 8 GB (estimated from its size, not measured) | 262,144 | `high` | "Enable Thinking" switched on in oMLX's model settings. |
| gpt-oss-120b | H100, vLLM | MXFP4, as released | about 61 GB | 65,536 | `high` | |
| gpt-oss-20b-MXFP4-Q8 | MacBook, oMLX | MXFP4 (MLX build) | about 13 GB | 131,072 | `high` | Ran with the older request, which sent `thinking: {type: "enabled"}` (see Caveats). |
| qwen3.8-27b | H100, vLLM | none (bf16) | about 51 GB | 65,536 | `medium` | vLLM refused `high`; `xhigh` took 373 s per weekly read. |

The two Gemma rows separate the cost of 4-bit and pruning from the model's own limits. Two models were left out: Qwen3.8-27B 4-bit on the MacBook loaded (13.7 GB) but could not finish a weekly read inside the 15-minute cap at `high` or `medium`, and Qwen3-14B was not run, for its 40,960-token context.

Each configuration as its saved runs record it, one row per input set ("snapshot" is the 17 demo-athlete calls, "seasons" the 18 season weeks). The harness commit shows which version of Cadence's request each row sent:

<!-- generated:setup:start -->
| Configuration | Inputs | Model id | Effort | Note (hardware, server, context) | Repeats | Harness commit | Started |
|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | snapshot | claude-opus-4-7 | xhigh | Anthropic API | 1 | 52ed766 | 2026-11-01 20:55 UTC |
| claude-opus-4-7--xhigh | seasons | claude-opus-4-7 | xhigh | Anthropic API | 1 | 38ed359 | 2026-11-01 21:12 UTC |
| gemma-4-26b-a4b--high | snapshot | gemma-4-26b-a4b | high | RunPod H100 80GB SXM, vLLM 0.32.0, 64k context | 1 | 38ed359 | 2026-11-01 21:19 UTC |
| gemma-4-26b-a4b--high | seasons | gemma-4-26b-a4b | high | RunPod H100 80GB SXM, vLLM 0.32.0, 64k context | 1 | 38ed359 | 2026-11-01 21:48 UTC |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | snapshot | gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B | high | MacBook Pro M4 Pro 24 GB, oMLX 0.7.3, 64k+ context, Enable Thinking on in oMLX model settings | 1 | 52ed766 | 2026-11-01 20:37 UTC |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | seasons | gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B | high | MacBook Pro M4 Pro 24 GB, oMLX 0.7.3, 64k+ context, Enable Thinking on in oMLX model settings | 1 | 38ed359 | 2026-11-01 22:11 UTC |
| gpt-oss-120b--high | snapshot | gpt-oss-120b | high | RunPod H100 80GB SXM, vLLM 0.32.0, 64k context | 1 | 52ed766 | 2026-11-01 20:36 UTC |
| gpt-oss-120b--high | seasons | gpt-oss-120b | high | RunPod H100 80GB SXM, vLLM 0.32.0, 64k context | 1 | 52ed766 | 2026-11-01 20:45 UTC |
| gpt-oss-20b-MXFP4-Q8--high | snapshot | gpt-oss-20b-MXFP4-Q8 | high | MacBook Pro M4 Pro 24 GB, oMLX 0.7.3, 64k+ context | 1 | fdcb8ab | 2026-11-01 19:57 UTC |
| gpt-oss-20b-MXFP4-Q8--high | seasons | gpt-oss-20b-MXFP4-Q8 | high | MacBook Pro M4 Pro 24 GB, oMLX 0.7.3, 64k+ context | 1 | fdcb8ab | 2026-11-01 20:14 UTC |
| qwen3.8-27b--medium | snapshot | qwen3.8-27b | medium | RunPod H100 80GB SXM, vLLM 0.32.0, 64k context; effort medium (refuses high; xhigh took 373 s on a weekly read) | 1 | 920b2ae | 2026-11-01 22:35 UTC |
| qwen3.8-27b--medium | seasons | qwen3.8-27b | medium | RunPod H100 80GB SXM, vLLM 0.32.0, 64k context; effort medium (refuses high; xhigh took 373 s on a weekly read) | 1 | 920b2ae | 2026-11-01 23:07 UTC |

Cost from saved usage, Anthropic rows only: claude-opus-4-7--xhigh: $6.15 over 35 replies ($3.32 snapshot, $2.83 seasons), refused attempts included.
<!-- generated:setup:end -->

## 3. Results

"Valid as sent" means the reply passed Cadence's checks, on the first try or when asked once more. "Failed" means it did not, and the athlete would have got no reply. "Rescued" counts failed replies that a set of candidate changes to Cadence would have accepted (section 5); those changes are not made. Times are per reply, a retry included. Self-hosted servers report no thinking tokens, so thinking is counted in characters.

<!-- generated:results:start -->
| Configuration | Replies | Valid as sent (first try / after retry) | Failed | Rescued by the candidate repairs | Time per reply, median / p90 | First token, median | Input tokens, median | Output tokens, median | Thinking characters, median |
|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 35 | 35 (34 / 1) | 0 | – | 56.5 s / 74.3 s | 3.4 s | 15150 | 3843 | 1729 |
| gemma-4-26b-a4b--high | 35 | 16 (11 / 5) | 19 | 19 of 19 | 102.6 s / 171.7 s | 0.4 s | 11472 | 6766 | 20973 |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | 35 | 14 (12 / 2) | 21 | 19 of 20 | 329.0 s / 470.7 s | 14.7 s | 11289 | 6453 | 19921 |
| gpt-oss-120b--high | 35 | 27 (26 / 1) | 8 | 8 of 8 | 34.7 s / 62.4 s | 1.3 s | 8655 | 6572 | 21021 |
| gpt-oss-20b-MXFP4-Q8--high | 35 | 14 (13 / 1) | 21 | 16 of 21 | 52.6 s / 99.9 s | 9.6 s | 9556 | 1748 | 3613 |
| qwen3.8-27b--medium | 35 | 35 (34 / 1) | 0 | – | 113.0 s / 167.4 s | 1.0 s | 11840 | 5338 | 13118 |

Valid as sent, by kind of reply:

| Configuration | weekly read | mid-week reply | About you draft | About you fix | About you tidy-up |
|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 28 of 28 | 4 of 4 | 1 of 1 | 1 of 1 | 1 of 1 |
| gemma-4-26b-a4b--high | 10 of 28 | 3 of 4 | 1 of 1 | 1 of 1 | 1 of 1 |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | 9 of 28 | 2 of 4 | 1 of 1 | 1 of 1 | 1 of 1 |
| gpt-oss-120b--high | 20 of 28 | 4 of 4 | 1 of 1 | 1 of 1 | 1 of 1 |
| gpt-oss-20b-MXFP4-Q8--high | 9 of 28 | 2 of 4 | 1 of 1 | 1 of 1 | 1 of 1 |
| qwen3.8-27b--medium | 28 of 28 | 4 of 4 | 1 of 1 | 1 of 1 | 1 of 1 |
<!-- generated:results:end -->

## 4. Per-model findings

Each model below is compared with Opus 4.7 on the same inputs. Plan figures are for weekly plans that were valid as sent; section 6 has the full tables. "About" memory means the weights alone: a 64k context and the server need several GB more.

### Gemma 4 26B-A4B, full precision (H100, vLLM)

- **How close:** valid on 16 of 35 replies. Of 28 weekly reads, 18 failed. Where a plan came through, it was close: weekly distance within 10 % of Opus's, day types matching on about 6 of 7 days. Coach Cade's full read was about a quarter of Opus's length (median 356 characters against 1,475), with 2 Watching items against 4.
- **Where it fails:** it leaves out each run's type (`run.type`) and often names the distance field its own way (`distance`, `pace`, `duration`). Asking once more fixed 5 of 23.
- **Speed on the H100:** about 1 min 43 s per reply at the median, first token under half a second.
- **Memory:** about 49 GB of weights at full precision.
- **Warnings:** expect most weekly reads to fail with today's Cadence. The short full read gives you much less of Coach Cade's reasoning. Thinking stays off unless your server switches it on.

### Gemma 4 26B-A4B, 4-bit and pruned (MacBook Pro M4 Pro 24 GB, oMLX)

- **How close:** valid on 14 of 35. Of 28 weekly reads, 19 failed, and 2 of 4 mid-week replies failed. Valid plans were close on distance (median within 3 %), with the same short full read as the full model (287 characters against 1,552).
- **Where it fails:** the same mistake as the full model, a run with no type, so 4-bit and pruning are not the cause. One call ended when the server closed the stream.
- **Speed on the MacBook:** about 5.5 min per reply at the median, nearly 10 min at worst, first token after about 15 s.
- **Memory:** about 8 GB of weights (estimated), so it fits a 24 GB Mac with room for the context.
- **Warnings:** most weekly reads fail, and each takes several minutes. Its plan for the injury week, refused today, asked for 68 km against Opus's 40 km, a long run twice as long and a quality session (section 6). If Cadence starts accepting its plans, read them with care.

### gpt-oss-120b (H100, vLLM)

- **How close:** valid on 27 of 35. All 8 failures were weekly reads, at the start of a season or a block. Valid plans were close: weekly distance median ratio 0.99, day types matching on about 6 of 7 days. Its full read was about half of Opus's length (811 against 1,588 characters), with 5 Watching items against 4. It used some internal words Coach Cade should not (RPE, "prompt", "prescribed").
- **Where it fails:** runs with no type, and distances in fields Cadence does not read (`distance`, `distanceKm`, `description` for the session). Asking once more fixed 1 of 9.
- **Speed on the H100:** the fastest row, about 35 s per reply at the median.
- **Memory:** about 61 GB of weights, so it needs an 80 GB-class GPU or a large unified-memory machine.
- **Warnings:** about one weekly read in four failed. Its injury-week plan was all easy running but put the long run at 11 miles against Opus's 8.

### gpt-oss-20b (MacBook Pro M4 Pro 24 GB, oMLX)

- **How close:** valid on 14 of 35. Of 28 weekly reads, 19 failed, and 2 of 4 mid-week replies failed. Day types matched Opus's well where a plan came through, but weekly distance ranged from 0.67 to 1.40 times Opus's. It thought far less than the other models (median 3,613 characters against about 21,000 for gpt-oss-120b), which may come from the older request it ran with (see Caveats).
- **Where it fails:** it writes the week id in its own format, leaves out or invents day types ("session": "Easy run"), sends answers as plain strings and empty fields as null. Asking once more fixed 1 of 20. Five failures stay failed even after every candidate repair.
- **Speed on the MacBook:** about 53 s per reply at the median, 1 min 40 s at p90, first token after about 10 s.
- **Memory:** about 13 GB of weights. It fits a 24 GB Mac with a 64k context.
- **Warnings:** in the injury week, a plan that passed every check added a tempo session and set a 12-mile long run where Opus planned 8 easy miles and no quality (section 6). Most weekly reads fail. When its plans are rescued, half of them drop the answer to the athlete's question.

### Qwen3.8-27B, full precision at `medium` (H100, vLLM)

- **How close:** valid on 35 of 35, the same as Opus (one weekly read needed the retry). Plans were the closest of any model: weekly distance between 0.84 and 1.13 times Opus's (median 1.00), day types matching on 93 % of days, the same rest days in 23 of 28 weeks. Its full read was nearly as long as Opus's (1,339 against 1,530 characters). Its injury-week plan matched Opus's: all easy, an 8-mile long run, no quality.
- **Where it differs:** it added a quality session in 4 weeks where Opus planned none, mostly early in a season, and once gave a long-run verdict to an athlete who was only staying fit.
- **Speed on the H100:** about 1 min 53 s per reply at the median.
- **Memory:** about 51 GB of weights at full precision. The 4-bit build (about 14 GB) fits a 24 GB Mac but was too slow there to finish a weekly read in 15 minutes.
- **Warnings:** vLLM refuses `high` for this model, so pick `medium` or `xhigh`; `xhigh` took over 6 minutes per weekly read on the H100. One repeat is not proof: it could still fail where it did not here.

### Opus 4.7 at `xhigh` (the baseline)

Valid on 35 of 35 (one weekly read after the retry). About 57 s per reply at the median, first token in about 3.4 s. $6.15 for the 35 replies, about 18 cents a reply. It also used a few words Coach Cade should not ("prescribed", the week label), so those counts are not a self-hosted problem alone.

## 5. Why replies failed

This section is for tuning Cadence. Everything here is a finding from the saved runs, not a change that has been made.

Almost every failure is a shape problem in the weekly plan, not a server error or a refusal. The validator stops at the first error, so the second table lists every problem in each refused reply.

<!-- generated:failures:start -->
Why each failed reply failed:

| Configuration | Failed | schema refusal | http/transport/timeout | no tool call | max_tokens | model refusal |
|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 0 | 0 | 0 | 0 | 0 | 0 |
| gemma-4-26b-a4b--high | 19 | 19 | 0 | 0 | 0 | 0 |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | 21 | 20 | 1 | 0 | 0 | 0 |
| gpt-oss-120b--high | 8 | 8 | 0 | 0 | 0 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | 21 | 21 | 0 | 0 | 0 | 0 |
| qwen3.8-27b--medium | 0 | 0 | 0 | 0 | 0 | 0 |

Every validator error of every refused attempt, across the self-hosted models (attempt 1, then the retry):

| Field | Rule | First attempt | Retry |
|---|---|---|---|
| `prescribedWeek.days[n].run.type` | must be easy\|quality\|long\|race\|other | 50 | 41 |
| `prescribedWeek.week` | must be an ISO week id (YYYY-Www) | 9 | 7 |
| `prescribedWeek.days[n].dayType` | must be rest\|easy\|quality\|long\|race\|other | 6 | 6 |
| `prescribedWeek.days[n]` | (easy) requires a run object | 1 | 3 |
| `answers[n]` | needs a non-empty question and answer | 1 | 2 |
| `flags[n]` | needs a non-empty title and detail | 1 | 2 |
| `prescribedDayPatches[n].run.type` | must be easy\|quality\|long\|race\|other | 3 | 0 |
| `settingsProposalBullets` | must be an array of strings | 1 | 2 |
| `(response)` | Anthropic response missing <tool> tool_use block | 2 | 0 |
| `headline` | is required and must be non-empty | 1 | 0 |
| `prescribedDayPatches[n].dayType` | must be rest\|easy\|quality\|long\|race\|other | 1 | 0 |
| `prescribedWeek` | must be an object | 1 | 0 |
| `prescribedWeek.days[n].run.distanceM` | must be a number >= 0 | 1 | 0 |

Top validator errors per configuration (refused attempts):

| Configuration | Top errors |
|---|---|
| claude-opus-4-7--xhigh | `flags` must be an array (1) |
| gemma-4-26b-a4b--high | `prescribedWeek.days[n].run.type` must be easy\|quality\|long\|race\|other (40); `prescribedDayPatches[n].run.type` must be easy\|quality\|long\|race\|other (1); `prescribedWeek.days[n]` (easy) requires a run object (1) |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | `prescribedWeek.days[n].run.type` must be easy\|quality\|long\|race\|other (35); `prescribedWeek.days[n]` (easy) requires a run object (3); `prescribedDayPatches[n].run.type` must be easy\|quality\|long\|race\|other (2) |
| gpt-oss-120b--high | `prescribedWeek.days[n].run.type` must be easy\|quality\|long\|race\|other (15); `headline` is required and must be non-empty (1); `prescribedWeek.days[n].run.distanceM` must be a number >= 0 (1) |
| gpt-oss-20b-MXFP4-Q8--high | `prescribedWeek.week` must be an ISO week id (YYYY-Www) (16); `prescribedWeek.days[n].dayType` must be rest\|easy\|quality\|long\|race\|other (12); `answers[n]` needs a non-empty question and answer (3) |
| qwen3.8-27b--medium | `prescribedWeek` must be an object (1) |

Every shape problem in the refused attempts (the validator stops at the first; these count all of them, in attempts):

| Problem | gemma-4-26b-a4b--high | gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | gpt-oss-120b--high | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|---|---|
| run without type | 40 | 38 | 15 | 0 |
| run without distanceM (or durationS) | 15 | 14 | 16 | 0 |
| day without dayType | 0 | 0 | 0 | 26 |
| week id not YYYY-Www | 0 | 0 | 0 | 16 |
| answers entries as plain strings | 0 | 0 | 0 | 7 |
| run.type outside the enum | 1 | 0 | 1 | 4 |
| settingsProposalBullets null | 0 | 0 | 0 | 6 |
| safetyCallouts null | 0 | 0 | 0 | 5 |
| run day without a run object | 1 | 3 | 0 | 0 |
| flags entries as plain strings | 0 | 0 | 0 | 2 |
<!-- generated:failures:end -->

### Asking once more

Today Cadence re-sends the identical request when a weekly plan is refused. That rarely helped: the model usually made the same mistake again.

<!-- generated:retry:start -->
| Configuration | Retried | Fixed by the retry | Same field and rule again | A new error |
|---|---|---|---|---|
| claude-opus-4-7--xhigh | 1 | 1 | 0 | 0 |
| gemma-4-26b-a4b--high | 23 | 5 | 17 | 1 |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | 20 | 2 | 15 | 3 |
| gpt-oss-120b--high | 9 | 1 | 7 | 1 |
| gpt-oss-20b-MXFP4-Q8--high | 20 | 1 | 10 | 9 |
| qwen3.8-27b--medium | 1 | 1 | 0 | 0 |
<!-- generated:retry:end -->

### Rescue simulation

Each refused reply's tool input was read back from its saved stream, a set of candidate repairs was applied, and the real validators were run again. A reply counts as rescued when any of its refused attempts passes. Plans rescued from bare distance fields had their unit inferred from the athlete's usual unit.

<!-- generated:rescue:start -->
68 failed self-hosted replies had a refused attempt to work on; with every candidate repair, 62 pass the real validators. Per configuration: gemma-4-26b-a4b--high 19 of 19; gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high 19 of 20; gpt-oss-120b--high 8 of 8; gpt-oss-20b-MXFP4-Q8--high 16 of 21.

Ranked in the greedy order (each repair added where it rescues the most replies not yet rescued):

| Rank | Repair | What it does | Rescues alone | Adds in this order | Running total | Needed by (rescued replies that fail without it) |
|---|---|---|---|---|---|---|
| 1 | `fillRunTypeFromDayType` | fill a missing run.type from the day's dayType | 23 | 23 | 23 | 48 |
| 2 | `mapRunFieldAliases` | map run field aliases (distance, distanceKm, pace, description, duration) to the schema's | 0 | 23 | 46 | 23 |
| 3 | `dropEmptyEntries` | drop flags/answers entries with an empty field (lossy) | 4 | 4 | 50 | 5 |
| 4 | `fillDayTypeFromRun` | fill a missing dayType from run.type | 3 | 3 | 53 | 3 |
| 5 | `dropNullOptionals` | remove optional fields sent as null | 3 | 3 | 56 | 3 |
| 6 | `normaliseWeekId` | normalise the plan's ISO week id from the plan week | 1 | 1 | 57 | 2 |
| 7 | `mapEnumNearMisses` | map near-miss dayType/run.type values to the enum | 0 | 1 | 58 | 5 |
| 8 | `mapDayFieldAliases` | map day field aliases (session, name, activity, note, reason, a distance on the day) to the schema's | 0 | 4 | 62 | 4 |
| 9 | `splitFlagStrings` | split flags sent as strings into title and detail | 1 | 0 | 62 | 0 |

Still failing after every repair: 6 replies.

| Configuration | Input | Attempt | Remaining error |
|---|---|---|---|
| gpt-oss-20b-MXFP4-Q8--high | snapshot/02 | 2 | `prescribedWeek.days[0].dayType must be rest\|easy\|quality\|long\|race\|other` |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | seasons/14 | 2 | `prescribedWeek.days[0].run.distanceM must be a number >= 0` |
| gpt-oss-20b-MXFP4-Q8--high | seasons/02 | 2 | `prescribedWeek.days[0].dayType must be rest\|easy\|quality\|long\|race\|other` |
| gpt-oss-20b-MXFP4-Q8--high | seasons/07 | 2 | `prescribedWeek.days[0].dayType must be rest\|easy\|quality\|long\|race\|other` |
| gpt-oss-20b-MXFP4-Q8--high | seasons/14 | 2 | `prescribedWeek.days[0].dayType must be rest\|easy\|quality\|long\|race\|other` |
| gpt-oss-20b-MXFP4-Q8--high | seasons/15 | 2 | `prescribedWeek.days[1].dayType must be rest\|easy\|quality\|long\|race\|other` |

Failed with nothing to repair (no tool input to read): gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high seasons/10: http/transport/timeout (The model server sent a stream error: terminated).
<!-- generated:rescue:end -->

What still fails after every repair needs a prompt or schema change, not a repair: gpt-oss-20b's free-text day types ("Moderate Session", "Optional Easy Run") and one Gemma distance that is not a number.

## 6. Plans against the baseline

Each weekly plan a model sent is set beside Opus 4.7's plan for the same week. "Rescued" plans are ones Cadence refused today and would accept only with the candidate repairs: they show what an athlete would get once those repairs are made, not what they get now.

<!-- generated:plans:start -->
Weekly plans for the same input, this model against the baseline. Ratios are this model's figure over the baseline's; cells with three figures are median / p90 / highest.

| Configuration | Plans | Pairs | Weekly distance ratio | Long-run ratio | Day types that match (median) | Same rest days | Quality session | Watching items, median (model vs baseline) | Fewer answers than the baseline | Full read, median characters (model vs baseline) |
|---|---|---|---|---|---|---|---|---|---|---|
| gemma-4-26b-a4b--high | valid as sent | 10 | 1.03 / 1.10 / 1.10 | 1.05 / 1.50 / 1.50 | 86% | 7 of 10 | 5 both, 1 only this model, 0 only the baseline | 2 vs 4 | 0 | 356 vs 1475 |
| gemma-4-26b-a4b--high | rescued | 18 | 1.00 / 1.09 / 1.13 | 1 / 1.14 / 1.27 | 100% | 17 of 18 | 10 both, 2 only this model, 0 only the baseline | 2 vs 4 | 0 | 389 vs 1534 |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | valid as sent | 9 | 1.03 / 1.13 / 1.13 | 1.08 / 1.50 / 1.50 | 86% | 6 of 9 | 2 both, 0 only this model, 1 only the baseline | 2 vs 4 | 0 | 287 vs 1552 |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | rescued | 17 | 0.97 / 1.11 / 1.68 | 1 / 1.27 / 2 | 86% | 15 of 17 | 11 both, 3 only this model, 0 only the baseline | 2 vs 4 | 0 | 313 vs 1515 |
| gpt-oss-120b--high | valid as sent | 20 | 0.99 / 1.13 / 1.24 | 1 / 1.37 / 1.50 | 86% | 13 of 20 | 12 both, 3 only this model, 0 only the baseline | 5 vs 4 | 0 | 811 vs 1588 |
| gpt-oss-120b--high | rescued | 8 | 1.00 / 1.17 / 1.17 | 1.10 / 1.27 / 1.27 | 86% | 4 of 8 | 3 both, 2 only this model, 0 only the baseline | 5 vs 4 | 0 | 964 vs 1417 |
| gpt-oss-20b-MXFP4-Q8--high | valid as sent | 9 | 0.95 / 1.40 / 1.40 | 0.97 / 1.50 / 1.50 | 100% | 7 of 9 | 4 both, 1 only this model, 1 only the baseline | 5 vs 4 | 0 | 630 vs 1515 |
| gpt-oss-20b-MXFP4-Q8--high | rescued | 14 | 0.91 / 1.06 / 1.19 | 0.93 / 1.18 / 1.27 | 100% | 11 of 14 | 8 both, 1 only this model, 0 only the baseline | 5 vs 4 | 7 | 676 vs 1548 |
| qwen3.8-27b--medium | valid as sent | 28 | 1 / 1.08 / 1.13 | 1 / 1.13 / 1.50 | 93% | 23 of 28 | 15 both, 4 only this model, 0 only the baseline | 3 vs 4 | 0 | 1339 vs 1530 |

Big divergences: weekly distance or long run off by more than 25 %, day types matching on fewer than half the days, a quality session on one side only, or fewer answers (39, largest distance gap first):

| Configuration | Input | Plan | Divergence |
|---|---|---|---|
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | snapshot/06 | rescued | weekly distance 67.6 km vs 40.2 km (x1.68); long run x2.00; quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/06 | valid as sent | weekly distance 56.3 km vs 40.2 km (x1.40); long run x1.50; quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/12 | valid as sent | weekly distance 31.0 km vs 46.0 km (x0.67); long run x0.57 |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/09 | rescued | weekly distance 49.9 km vs 68.4 km (x0.73); 0 answers vs 1 |
| gpt-oss-120b--high | seasons/12 | valid as sent | weekly distance 34.0 km vs 46.0 km (x0.74); long run x0.71 |
| gpt-oss-120b--high | snapshot/06 | valid as sent | long run x1.37 |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | snapshot/05 | rescued | long run x0.72 |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/07 | rescued | long run x1.27; 0 answers vs 2 |
| gpt-oss-120b--high | snapshot/01 | rescued | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/05 | valid as sent | long run x1.50 |
| qwen3.8-27b--medium | snapshot/05 | valid as sent | long run x0.75 |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/04 | rescued | long run x0.75; 0 answers vs 1 |
| gemma-4-26b-a4b--high | snapshot/02 | rescued | long run x1.27 |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | seasons/05 | valid as sent | long run x1.50 |
| gpt-oss-120b--high | seasons/05 | valid as sent | long run x1.50; quality session the baseline does not plan |
| qwen3.8-27b--medium | seasons/05 | valid as sent | long run x1.50 |
| gpt-oss-20b-MXFP4-Q8--high | seasons/04 | valid as sent | no quality session where the baseline plans one |
| gpt-oss-20b-MXFP4-Q8--high | seasons/08 | rescued | 0 answers vs 1 |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | snapshot/01 | rescued | quality session the baseline does not plan |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | snapshot/02 | rescued | long run x1.27 |
| qwen3.8-27b--medium | snapshot/02 | valid as sent | long run x1.27 |
| gemma-4-26b-a4b--high | seasons/05 | valid as sent | long run x1.50; quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/10 | rescued | 0 answers vs 1 |
| gpt-oss-120b--high | snapshot/02 | rescued | long run x1.27 |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | seasons/04 | valid as sent | no quality session where the baseline plans one |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/01 | rescued | quality session the baseline does not plan |
| qwen3.8-27b--medium | snapshot/01 | valid as sent | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/10 | rescued | 0 answers vs 2 |
| gemma-4-26b-a4b--high | seasons/01 | rescued | quality session the baseline does not plan |
| gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | seasons/01 | rescued | day types match on 3/7 days; quality session the baseline does not plan |
| gpt-oss-120b--high | seasons/01 | rescued | quality session the baseline does not plan |
| gpt-oss-120b--high | seasons/06 | valid as sent | quality session the baseline does not plan |
| gemma-4-26b-a4b--high | seasons/02 | rescued | quality session the baseline does not plan |
| gpt-oss-120b--high | seasons/03 | valid as sent | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/16 | valid as sent | day types match on 3/7 days |
| gpt-oss-20b-MXFP4-Q8--high | seasons/17 | rescued | 0 answers vs 1 |
| qwen3.8-27b--medium | seasons/01 | valid as sent | quality session the baseline does not plan |
| qwen3.8-27b--medium | seasons/02 | valid as sent | quality session the baseline does not plan |
| qwen3.8-27b--medium | seasons/03 | valid as sent | quality session the baseline does not plan |
<!-- generated:plans:end -->

**Two plans are a safety concern.** Both are for the demo athlete's injury week, when the right Achilles tightened during a tempo run and the athlete asked whether to stop running. Opus 4.7 planned about 40 km of flat easy running, an 8-mile easy long run, and no quality session.

- **Gemma 4, 4-bit and pruned:** about 68 km (1.68 times Opus's), a long run twice as long, and a quality session. Cadence refused this plan today for its format, so the athlete would have got no plan. With the candidate repairs it would have been accepted as it stands.
- **gpt-oss-20b:** about 56 km (1.40 times), a 12-mile long run, and a 2-mile tempo at 8:00/mi. This plan passed every check and is what the athlete would have got.

Cadence's checks look at a plan's shape. They do not stop a model from loading an injured runner. If you coach yourself with a self-hosted model, read each plan before you run it, most of all in a week when something hurts.

## 7. Hardest inputs

This section is for tuning Cadence. These inputs failed in at least half the self-hosted models. They are mostly the first weeks of a season or a block, where the plan is short, walk-run or built around time rather than distance. They are the regression set: rerun them first after any change to the prompt, the tool schema or the validators.

<!-- generated:hardest:start -->
13 inputs failed in at least half the self-hosted models that ran them:

| Input | Kind | Source | claude-opus-4-7--xhigh | gemma-4-26b-a4b--high | gemma-4-26B-A4B-it-OptiQ-4bit-REAP-14B--high | gpt-oss-120b--high | gpt-oss-20b-MXFP4-Q8--high | qwen3.8-27b--medium |
|---|---|---|---|---|---|---|---|---|
| seasons/01 | weekly read | 1-stay-fit-w1.json | first try | failed (rescuable) | failed (rescuable) | failed (rescuable) | failed (rescuable) | first try |
| seasons/02 | weekly read | 1-stay-fit-w2.json | first try | failed (rescuable) | failed (rescuable) | failed (rescuable) | failed (schema refusal) | first try |
| seasons/07 | weekly read | 2-10k-w1.json | first try | failed (rescuable) | failed (rescuable) | failed (rescuable) | failed (schema refusal) | first try |
| seasons/08 | weekly read | 2-10k-w2.json | first try | failed (rescuable) | failed (rescuable) | failed (rescuable) | failed (rescuable) | first try |
| seasons/13 | weekly read | 3-return-w1.json | first try | failed (rescuable) | failed (rescuable) | failed (rescuable) | failed (rescuable) | first try |
| seasons/14 | weekly read | 3-return-w2.json | first try | failed (rescuable) | failed (schema refusal) | failed (rescuable) | failed (schema refusal) | first try |
| snapshot/01 | weekly read | snapshot call at 2026-08-09 20:00:39.397411+00 | first try | failed (rescuable) | failed (rescuable) | failed (rescuable) | failed (rescuable) | first try |
| snapshot/02 | weekly read | snapshot call at 2026-08-16 20:00:37.709951+00 | first try | failed (rescuable) | failed (rescuable) | failed (rescuable) | failed (schema refusal) | first try |
| snapshot/07 | weekly read | snapshot call at 2026-09-20 20:00:40.715053+00 | first try | failed (rescuable) | failed (rescuable) | first try | failed (rescuable) | first try |
| snapshot/08 | weekly read | snapshot call at 2026-09-27 20:00:44.16432+00 | first try | failed (rescuable) | failed (rescuable) | first try | failed (rescuable) | first try |
| snapshot/09 | weekly read | snapshot call at 2026-10-04 20:01:43.157956+00 | first try | failed (rescuable) | failed (rescuable) | first try | failed (rescuable) | first try |
| snapshot/10 | weekly read | snapshot call at 2026-10-11 20:01:26.005802+00 | first try | failed (rescuable) | failed (rescuable) | first try | failed (rescuable) | first try |
| snapshot/12 | mid-week reply | snapshot call at 2026-10-13 23:05:59.215239+00 | first try | failed (rescuable) | failed (rescuable) | first try | failed (rescuable) | first try |
<!-- generated:hardest:end -->

## 8. Blind review

The numbers above say whether a reply had the right shape and how its plan compared with Opus's. They do not say whether it coached well. For that, each self-hosted model has a blind review pack against Opus 4.7: pairs of replies to the same input, in an order drawn per pair, with nothing in the pair saying which model wrote which.

**The sample, 8 pairs per model:**

- one mid-season weekly read from each season (staying fit, 10k, return from injury);
- the demo athlete's marathon week;
- the demo athlete's injury week;
- two mid-week replies, one plain and one with a run attached;
- the About you first draft.

A reply that failed is scored as what the athlete would have got: nothing.

**The rubric,** each item 1 to 5 for each reply, then an overall preference (A, B or a tie):

- **Reads the week correctly:** the runs, distances, paces, heart rate and what the athlete said, with nothing invented and nothing important missed.
- **Plan fits the goal and recent load:** the coming week suits what they train for and steps sensibly from what they have run.
- **Safety handled right:** pain and injury noticed, the plan backs off, the athlete is sent to a professional rather than diagnosed, a returning runner is not rushed.
- **Sounds like Coach Cade:** calm, direct, specific, in plain words, with no jargon, hype or system words.
- **Clear and concise:** the important thing first, nothing said twice, readable in a minute or two.

<!-- generated:review:start -->
**Pending.** The blind scores are not in yet: 5 review packs written, none scored. Once each pack's `scores.template.json` has been copied to `scores.json` and filled in, run from `api/`:

```bash
npm run replay:publish -- --analysis ../.scratch/benchmark-analysis --doc ../docs/reports/local-models-2026-11.md
```

That joins the scores to each pack's key and replaces this block with mean scores and preference rates per model.
<!-- generated:review:end -->

## 9. Caveats

- One repeat per row: run-to-run variance was not measured, so a single pass or failure can be luck.
- gpt-oss-20b ran with the older request that sent `thinking: {type: "enabled"}`; every later self-hosted row sent no thinking field, as Cadence does now.
- Qwen3.8-27B on the H100 ran at `medium`, because vLLM refused `high` and `xhigh` took 373 s per weekly read.
- Qwen3.8-27B 4-bit on the 24 GB MacBook could not finish a weekly read inside the 15-minute cap at `high` or `medium`, so it has no MacBook row.
- Qwen3-14B was dropped for its 40,960-token context, below the 64k Cadence needs.
- Gemma 4 thinks only when switched on: "Enable Thinking" in oMLX's model settings, and `enable_thinking` in the chat template kwargs on vLLM.
- The "no goal line" goal-check failures (up to 13 per row, Opus included, counting valid and rescued replies) come from the demo inputs, logged before a goal was stored, not from the models.
- Rescued plans with bare distance fields had their unit inferred, which can be wrong.
- Test connection gave Gemma 4 on oMLX a false "cut": it echoed the test text until `max_tokens`, though the server had read every token.
- Memory figures are the weights as loaded (vLLM's report, oMLX's load, or the model's size); the pruned Gemma figure is an estimate.
- Speed is for the hardware each row ran on, with one call at a time.

## 10. What to change in Cadence's harness

This section is for tuning Cadence. It was written before any of these changes. Most are now made or superseded by the plan-as-text work; see "Measured since" below and ADR 0006. After any further change, rerun the benchmark on the hard inputs (section 7), then on all inputs, and compare.

Ranked by the rescued replies that need each change (from the rescue simulation, 62 of 68 rescued with all of them):

1. Fill a missing `run.type` from the day's `dayType`: needed by 48 rescued replies, 23 rescued by it alone.
2. Accept the run field names models use (`distance`, `distanceKm`, `pace`, `description`, `duration`) and map them to the schema's: needed by 23, always together with the first.
3. Drop Watching or answer entries with an empty field: needed by 5. Lossy: log what was dropped.
4. Map near-miss day and run types to the list (`tempo` to quality, "Easy Run" to easy): needed by 5.
5. Accept the day field names models use (`session`, `name`, `activity`, `note`, `reason`): needed by 4.
6. Fill a missing `dayType` from the run's type: needed by 3.
7. Remove optional fields sent as null: needed by 3.
8. Rebuild the plan's week id from the plan week when the model writes it its own way: needed by 2.
9. Send the validator's error back with the retry, instead of the identical request: the retry fixed 10 of 73 refused replies, and repeated the same error in 49.

Two more findings for the same work:

- The tool schema's names (`distanceM`, `structure`, `paceOrHr`, `dayType`) are not followed: make them required with the unit in the description, and test each description change on the hard inputs.
- A rescued plan is accepted on shape alone. Before the repairs ship, a plan that jumps far above the athlete's recent load, or adds quality in a week with pain notes, needs a check of its own (section 6).

A second adapter that asks an OpenAI-style server for JSON-schema-constrained output would rule out most of these shape errors by construction, on servers that support it (vLLM does). It looks worth trying after the repairs above, which reach the same replies without a second adapter. Whether it changes how well a model coaches is not measured. Constrained output did not help on Anthropic's side, though: see the strict tool use result below.

### Measured since: strict tool use (2026-11-02)

The first harness change tried after this report was Anthropic's strict tool use: `strict: true` on every reply tool, which makes the API constrain the model's tool input to the schema. To fit strict mode's rules, the seven-day limit on the weekly plan (`minItems` and `maxItems` of 7) moved out of the schema and into the description. Both steps were measured on a set of 20 hard inputs, with one repeat each, on Opus 4.7 at `xhigh` and on gpt-oss-20b at `high` on oMLX.

| Step | Opus 4.7 valid | gpt-oss-20b valid |
|---|---|---|
| This report's runs, all 35 inputs | 35 of 35 | 14 of 35 |
| Schema reshaped for strict, flag not sent | 17 of 20 | 8 of 20 |
| Strict sent on every tool | 2 of the 12 that ran | 6 of 20 |

- **Opus broke on the encoding, not the coaching.** After the reshape, its failures were malformed tool calls: a missing `headline`, a plan that was not an object, and tool-call markup inside text fields. The five inputs involved all passed first try on the code before the reshape.
- **Strict mode made Opus run away.** Six replies ran to the 64,000-token output limit, and so did their retries. Each wrote only a few thousand characters of tool input, which stopped inside a text field. No weekly read passed. Eleven replies cost $14.14, against $2.98 for the same eleven without strict.
- **oMLX ignored the flag.** It accepted `strict: true` without an error. gpt-oss-20b made the same mistakes as before: day types outside the list, malformed week ids, and dates one day off.
- **This repeats an earlier result.** ADR 0002 recorded strict mode's runaway once before.

Strict mode is not a fix for the shape errors above. The changes in the list stay the plan: the run written in the athlete's units, a retry that carries the error, and the meaning-preserving repairs. Each is measured the same way.

### Measured since: the plan as text (2026-11-02)

The list above was then replaced by a different change (ADR 0006). Coach Cade writes the plan as seven lines of text, one per day, and Cadence reads each line for its date, day type, and distance or time. A day it cannot read keeps Coach Cade's sentence and is marked "Not yet filed". Every other box on the form is plain text too, and the one retry says what was wrong. First, three runs of the 20 hard inputs on the old form measured Opus 4.7's normal spread: 19, 18 and 18 valid. The reshape's 17 above sits one reply under that band, so most of its drop was chance.

On the same 20 inputs with lists of strings still in the form, gpt-oss-20b was valid on 20 of 20 with 94.6 percent of days filed, and Opus on 20 of 20 with every day filed, but only 14 first try: all six slips were in the lists. With no lists at all, Opus passed 20 of 20 on the first try at $3.11, and gpt-oss-20b filed every day of every week (112 of 112). Before this work gpt-oss-20b was valid on 8 of these 20.

To rebuild the numbers in this report from the saved runs, from `api/`:

```bash
npm run replay:analyse
npm run replay:publish -- --analysis ../.scratch/benchmark-analysis --doc ../docs/reports/local-models-2026-11.md
```

The second command rewrites only the marked tables and leaves the text as it is.

## 11. After the changes

<!-- generated:after:start -->
On 2026-11-02, after the plan-as-text work (ADR 0006), Opus 4.7 and gpt-oss-20b answered the same 35 coach calls once, on the finished code. The weekly plan is now seven lines of text that Cadence reads day by day, and every box on the form is plain text. This block was written by hand from that run's analysis. The rented-GPU rows (gpt-oss-120b, Gemma 4 full, Qwen3.8-27B) were not rerun and are not comparable with it. Pruned Gemma 4 on the MacBook was still running; its row is added when it finishes.

| Configuration | Replies | Valid (first try / after retry) | Failed | Days filed | Days fixed by the retry | Time per reply, median / p90 | Cost |
|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 35 | 35 (35 / 0) | 0 | 196 of 196 | 2 of 2 | 50.8 s / 69.4 s | $5.43 |
| gpt-oss-20b-MXFP4-Q8--high | 35 | 35 (34 / 1) | 0 | 196 of 196 | 6 of 6 | 28.7 s / 47.0 s | – |

Against section 3's run of 2026-11-01: gpt-oss-20b went from 14 of 35 valid to 35 of 35. Opus stayed at 35 of 35 and needed no retry, where it needed one before. Opus cost $5.43 against $6.15.

- **What still slips is filed by the retry.** Opus once wrote Thursday twice and left out Wednesday; gpt-oss-20b left out six days across three weeks. The retry sent back each date and reason, and every one was filed.
- **gpt-oss-20b's plans are close to Opus's on shape.** Over 28 weekly plans: weekly distance median ratio 0.99 (p90 1.12), long run 1.00, the same rest days in 21 of 28, quality on both sides in 14 weeks and on gpt-oss-20b's side only in 2.
- **It is not yet a safe coach.** In the injury week (snapshot/06) it planned a 1-mile goal-pace session, a 12-mile long run and a shin stretch, for an Achilles injury. Opus planned all easy running, a 10-mile long run and a physio appointment. It skipped the athlete's question in 4 of 28 weeks, and its full read ran a median 777 characters against Opus's 1,067. Weekly distance was off by more than a quarter in 3 weeks (1.39, 0.72 and 0.69 times Opus's).

Format is no longer the limit on other models. Coaching quality is: section 6's warning stands, and #58 is its first guard.
<!-- generated:after:end -->
