# Replay gate: first-pass report

Generated 2026-11-03T14:57:31.466Z from 3 replayed coach calls across 3 configurations in .scratch/benchmark-coaching/probe/seasons.

The checks below only point at what to read. A figure listed as missing may be rounded, restated or deliberately dropped; each one is judged by a person before the gate passes.

## Configurations

Schema outcomes: replies accepted on the first try, accepted when asked once more, and refused on every attempt. The other columns are the measures; each configuration's section breaks them down.

| Configuration | Provider | Host | Model | Effort | Repeats | Note | Replies | First try | After retry | Failed | Wall clock | First token (median / worst) | Total (median / worst) | Input tok (median) | Output tok (median) | Thinking tok (median) | Thinking chars (median) | Prompt cut | Soft repairs | Caps hit | Goal-check failures | Banned words | Plan sanity flags | Cost total | Cost per reply (median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anthropic--claude-haiku-5-5--xhigh | anthropic |  | claude-haiku-5-5 | xhigh | 1 | Anthropic API, probe | 1 | 0 | 0 | 1 | 189.8 s | 1.7 s / 1.7 s | 189.8 s / 189.8 s | 22281 | 20000 | 20000 | 20680 | 0 of 1 | 0 | 0 | 0 | 0 | – | $0.0245 | $0.0245 |
| anthropic--claude-opus-5-5--xhigh | anthropic |  | claude-opus-5-5 | xhigh | 1 | Anthropic API, probe | 1 | 1 | 0 | 0 | 124.1 s | 3.0 s / 3.0 s | 124.1 s / 124.1 s | 22281 | 12665 | 10300 | 12051 | 0 of 1 | 0 | 0 | 0 | 0 | 0 of 1 | $0.3424 | $0.3424 |
| anthropic--claude-sonnet-5-5--xhigh | anthropic |  | claude-sonnet-5-5 | xhigh | 1 | Anthropic API, probe | 1 | 1 | 0 | 0 | 107.3 s | 3.3 s / 3.3 s | 107.3 s / 107.3 s | 22281 | 13469 | 11223 | 10425 | 0 of 1 | 0 | 0 | 0 | 0 | 0 of 1 | $0.1793 | $0.1793 |

How the measures are taken (each configuration's measures.json holds them all):

- Plan sanity, weekly reads only, flagged and not failed: seven days; the dates and week id match the expected plan week; every day that is not rest or other carries a run; the week's planned distance within 0.5x to 1.6x of the packet's recent weekly distance (the last four weeks' average from its reports). A plan given by time only, or a packet with no distance in its reports, skips the volume check.
- Prompt cut: the server's reported input tokens (cache reads and writes included) under 90 % of the harness's own count of the prompt (system and messages, characters / 4), the probe's rule.
- Latency: first token is the first attempt's first content_block_delta; total is the whole call's wall-clock, a retry included; wall clock is the sum over every call. A dry run has no first token.
- Tokens are the last attempt's usage, as medians. Thinking tokens are blank where the server never reports them (oMLX); thinking characters stand in.
- Cost, Anthropic rows only (self-hosted is blank): every attempt's usage, refused attempts included, at the prices below, in US dollars per million tokens, taken 2026-11-03. Cache reads at 0.1x the input price (0.05x on Opus 5.5 and Sonnet 5.5) and cache writes at 1.25x the input price (Anthropic's standard multipliers; writes priced as the 5-minute cache). Thinking is billed as output and is inside the output count.

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| Opus 4.7 (claude-opus-4-7) | $5 | $25 | $0.50 | $6.25 |
| Opus 5.5 (claude-opus-5-5) | $4 | $20 | $0.20 | $5 |
| Sonnet 5.5 (claude-sonnet-5-5) | $2 | $10 | $0.10 | $2.50 |
| Haiku 5.5 (claude-haiku-5-5) | $0.10 | $0.50 | $0.010 | $0.125 |

## Goal checks

- anthropic--claude-haiku-5-5--xhigh/24.1 (4-marathon-w06.json): refused reply: no reply to check; replay it again

## anthropic--claude-haiku-5-5--xhigh

Provider anthropic. Model claude-haiku-5-5, effort xhigh. 1 repeat over api/tests/fixtures/seasons/season-packets.
Started 2026-11-03T14:50:28.735Z. Harness commit 380933a762f5d15170c1328d4e0ef515a4752e1e. Note: Anthropic API, probe

Replies: 1 weekly read.

### Measures

| Measure | Value |
|---|---|
| Schema | 0 first try, 0 after retry, 1 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 0 (none) |
| Banned words | 0 in 0 replies (none) |
| Plan sanity | no weekly plans |
| First token (median / worst) | 1.7 s / 1.7 s |
| Total time (median / worst) | 189.8 s / 189.8 s |
| Wall clock (all calls) | 189.8 s |
| Input tokens (median) | 22281 |
| Output tokens (median) | 20000 |
| Thinking tokens (median) | 20000 |
| Thinking characters (median) | 20680 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 1; lowest ratio 245.5 % |
| Cost | $0.0245 over 1 replies; median $0.0245, worst $0.0245 (prices taken 2026-11-03) |

### Goal checks

- 24.1 (4-marathon-w06.json): refused reply: no reply to check; replay it again

### Refused replies

- 24.1.failed.json (4-marathon-w06.json, weekly read): Anthropic stopped at max_tokens before completing the reply tool call (stop_reason=max_tokens, output cap 20000 tokens); stop reason max_tokens (refused on all 2 attempts)

## anthropic--claude-opus-5-5--xhigh

Provider anthropic. Model claude-opus-5-5, effort xhigh. 1 repeat over api/tests/fixtures/seasons/season-packets.
Started 2026-11-03T14:55:27.306Z. Harness commit 380933a762f5d15170c1328d4e0ef515a4752e1e. Note: Anthropic API, probe

Replies: 1 weekly read.

### Measures

| Measure | Value |
|---|---|
| Schema | 1 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 0 (none) |
| Banned words | 0 in 0 replies (none) |
| Plan sanity | 0 of 1 weekly plans flagged (none); volume ratio median 1.02, highest 1.02 |
| First token (median / worst) | 3.0 s / 3.0 s |
| Total time (median / worst) | 124.1 s / 124.1 s |
| Wall clock (all calls) | 124.1 s |
| Input tokens (median) | 22281 |
| Output tokens (median) | 12665 |
| Thinking tokens (median) | 10300 |
| Thinking characters (median) | 12051 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 1; lowest ratio 245.5 % |
| Cost | $0.3424 over 1 replies; median $0.3424, worst $0.3424 (prices taken 2026-11-03) |

### Goal checks

All passed: every packet has a goal line, no non-marathon reply says marathon, no stay-fit reply gives a long-run verdict, and no reply was refused.

### 24.1 (4-marathon-w06.json): weekly read

Model claude-opus-5-5. Outcome ok. Tokens in 22281, out 12665.

Goal: race (marathon). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1905 |
| Headline | | 241 chars |
| Flags | | 5 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | yes |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- I missed Thursday and cut the long run short. Should I make up the miles next week?

Verdict: _to be judged_

## anthropic--claude-sonnet-5-5--xhigh

Provider anthropic. Model claude-sonnet-5-5, effort xhigh. 1 repeat over api/tests/fixtures/seasons/season-packets.
Started 2026-11-03T14:53:39.307Z. Harness commit 380933a762f5d15170c1328d4e0ef515a4752e1e. Note: Anthropic API, probe

Replies: 1 weekly read.

### Measures

| Measure | Value |
|---|---|
| Schema | 1 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 0 (none) |
| Banned words | 0 in 0 replies (none) |
| Plan sanity | 0 of 1 weekly plans flagged (none); volume ratio median 0.98, highest 0.98 |
| First token (median / worst) | 3.3 s / 3.3 s |
| Total time (median / worst) | 107.3 s / 107.3 s |
| Wall clock (all calls) | 107.3 s |
| Input tokens (median) | 22281 |
| Output tokens (median) | 13469 |
| Thinking tokens (median) | 11223 |
| Thinking characters (median) | 10425 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 1; lowest ratio 245.5 % |
| Cost | $0.1793 over 1 replies; median $0.1793, worst $0.1793 (prices taken 2026-11-03) |

### Goal checks

All passed: every packet has a goal line, no non-marathon reply says marathon, no stay-fit reply gives a long-run verdict, and no reply was refused.

### 24.1 (4-marathon-w06.json): weekly read

Model claude-sonnet-5-5. Outcome ok. Tokens in 22281, out 13469.

Goal: race (marathon). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1946 |
| Headline | | 182 chars |
| Flags | | 4 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | yes |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- I missed Thursday and cut the long run short. Should I make up the miles next week?

Verdict: _to be judged_
