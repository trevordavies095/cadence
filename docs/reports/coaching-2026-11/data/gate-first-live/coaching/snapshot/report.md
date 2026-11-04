# Replay gate: first-pass report

Generated 2026-11-04T14:27:57.383Z from 1 replayed coach calls across 1 configuration in .scratch/benchmark-after/gate-first-live/coaching/snapshot.

The checks below only point at what to read. A figure listed as missing may be rounded, restated or deliberately dropped; each one is judged by a person before the gate passes.

## Configurations

Schema outcomes: replies accepted on the first try, accepted when asked once more, and refused on every attempt. The other columns are the measures; each configuration's section breaks them down.

| Configuration | Provider | Host | Model | Effort | Repeats | Note | Replies | First try | After retry | Failed | Wall clock | First token (median / worst) | Total (median / worst) | Input tok (median) | Output tok (median) | Thinking tok (median) | Thinking chars (median) | Prompt cut | Soft repairs | Caps hit | Goal-check failures | Banned words | Plan sanity flags | Cost total | Cost per reply (median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anthropic--claude-opus-4-7--xhigh | anthropic |  | claude-opus-4-7 | xhigh | 1 |  | 1 | 1 | 0 | 0 | 64.8 s | 9.2 s / 9.2 s | 64.8 s / 64.8 s | 24406 | 3171 | 832 | 1181 | 0 of 1 | 0 | 0 | 1 | 1 | 0 of 1 | $0.2013 | $0.2013 |

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
| Fable 5.1 (claude-fable-5-1) | $10 | $50 | $0.25 | $12.50 |

## Goal checks

- anthropic--claude-opus-4-7--xhigh/06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal

## anthropic--claude-opus-4-7--xhigh

Provider anthropic. Model claude-opus-4-7, effort xhigh. 1 repeat over demo snapshot.
Started 2026-11-04T14:26:52.605Z. Harness commit 99843954d41608139b592d3d533adc7b4b7a14f7. Rules retry on.

Replies: 1 weekly read.

### Measures

| Measure | Value |
|---|---|
| Schema | 1 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 1 (no goal line 1) |
| Banned words | 1 in 1 replies (mid-week 1) |
| Plan sanity | 0 of 1 weekly plans flagged (none); volume ratio median 0.71, highest 0.71 |
| First token (median / worst) | 9.2 s / 9.2 s |
| Total time (median / worst) | 64.8 s / 64.8 s |
| Wall clock (all calls) | 64.8 s |
| Input tokens (median) | 24406 |
| Output tokens (median) | 3171 |
| Thinking tokens (median) | 832 |
| Thinking characters (median) | 1181 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 1; lowest ratio 238.5 % |
| Cost | $0.2013 over 1 replies; median $0.2013, worst $0.2013 (prices taken 2026-11-03) |

### Goal checks

- 06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal

### 06.1: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3171.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1595 |
| Headline | | 206 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | mid-week |

Figures in the old read not found anywhere in the new reply: none

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_
