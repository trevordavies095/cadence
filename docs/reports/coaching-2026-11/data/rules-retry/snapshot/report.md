# Replay gate: first-pass report

Generated 2026-11-04T11:38:29.448Z from 4 replayed coach calls across 2 configurations in .scratch/benchmark-coaching/rules-retry/snapshot.

The checks below only point at what to read. A figure listed as missing may be rounded, restated or deliberately dropped; each one is judged by a person before the gate passes.

## Configurations

Schema outcomes: replies accepted on the first try, accepted when asked once more, and refused on every attempt. The other columns are the measures; each configuration's section breaks them down.

| Configuration | Provider | Host | Model | Effort | Repeats | Note | Replies | First try | After retry | Failed | Wall clock | First token (median / worst) | Total (median / worst) | Input tok (median) | Output tok (median) | Thinking tok (median) | Thinking chars (median) | Prompt cut | Soft repairs | Caps hit | Goal-check failures | Banned words | Plan sanity flags | Cost total | Cost per reply (median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anthropic--claude-opus-4-7--xhigh | anthropic |  | claude-opus-4-7 | xhigh | 1 | Anthropic API | 1 | 1 | 0 | 0 | 66.1 s | 5.0 s / 5.0 s | 66.1 s / 66.1 s | 24406 | 3786 | 1590 | 1643 | 0 of 1 | 0 | 0 | 1 | 0 | 0 of 1 | $0.2167 | $0.2167 |
| self_hosted--gpt-oss-20b-MXFP4-Q8--high | self_hosted | <macbook> | gpt-oss-20b-MXFP4-Q8 | high | 3 | MacBook Pro M4 Pro 24 GB, oMLX, 64k+ context | 3 | 3 | 0 | 0 | 184.9 s | 1.0 s / 23.5 s | 64.9 s / 70.3 s | 16828 | 1616 | – | 3359 | 0 of 3 | 0 | 0 | 3 | 0 | 0 of 3 |  |  |

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
- self_hosted--gpt-oss-20b-MXFP4-Q8--high/06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- self_hosted--gpt-oss-20b-MXFP4-Q8--high/06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- self_hosted--gpt-oss-20b-MXFP4-Q8--high/06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal

## anthropic--claude-opus-4-7--xhigh

Provider anthropic. Model claude-opus-4-7, effort xhigh. 1 repeat over demo snapshot.
Started 2026-11-04T11:36:20.348Z. Harness commit 4b0b84b37ffbeb941347c2453eb59353ac7cd614. Rules retry on. Note: Anthropic API

Replies: 1 weekly read.

### Measures

| Measure | Value |
|---|---|
| Schema | 1 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 1 (no goal line 1) |
| Banned words | 0 in 0 replies (none) |
| Plan sanity | 0 of 1 weekly plans flagged (none); volume ratio median 0.58, highest 0.58 |
| First token (median / worst) | 5.0 s / 5.0 s |
| Total time (median / worst) | 66.1 s / 66.1 s |
| Wall clock (all calls) | 66.1 s |
| Input tokens (median) | 24406 |
| Output tokens (median) | 3786 |
| Thinking tokens (median) | 1590 |
| Thinking characters (median) | 1643 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 1; lowest ratio 238.5 % |
| Cost | $0.2167 over 1 replies; median $0.2167, worst $0.2167 (prices taken 2026-11-03) |

### Goal checks

- 06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal

### 06.1: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3786.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1557 |
| Headline | | 196 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: 3:30

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

## self_hosted--gpt-oss-20b-MXFP4-Q8--high

Provider self_hosted at <macbook>. Model gpt-oss-20b-MXFP4-Q8, effort high. 3 repeats over demo snapshot.
Started 2026-11-04T11:35:24.498Z. Harness commit 4b0b84b37ffbeb941347c2453eb59353ac7cd614. Rules retry on. Note: MacBook Pro M4 Pro 24 GB, oMLX, 64k+ context

Replies: 3 weekly reads.

### Measures

| Measure | Value |
|---|---|
| Schema | 3 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 3 (no goal line 3) |
| Banned words | 0 in 0 replies (none) |
| Plan sanity | 0 of 3 weekly plans flagged (none); volume ratio median 0.82, highest 0.84 |
| First token (median / worst) | 1.0 s / 23.5 s |
| Total time (median / worst) | 64.9 s / 70.3 s |
| Wall clock (all calls) | 184.9 s |
| Input tokens (median) | 16828 |
| Output tokens (median) | 1616 |
| Thinking tokens (median) | not reported |
| Thinking characters (median) | 3359 |
| Cache read / write tokens (median) | – / – |
| Prompt cut | 0 of 3; lowest ratio 164.5 % |
| Cost | self-hosted: not priced |

### Goal checks

- 06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal

### 06.1: weekly read on 2026-09-13

Model gpt-oss-20b-MXFP4-Q8. Outcome ok. Tokens in 16828, out 1299.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 695 |
| Headline | | 88 chars |
| Flags | | 4 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: 3:30

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

### 06.2: weekly read on 2026-09-13

Model gpt-oss-20b-MXFP4-Q8. Outcome ok. Tokens in 16828, out 1616.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 523 |
| Headline | | 86 chars |
| Flags | | 4 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: 16, 3:30

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

### 06.3: weekly read on 2026-09-13

Model gpt-oss-20b-MXFP4-Q8. Outcome ok. Tokens in 16828, out 2676.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 534 |
| Headline | | 137 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 5 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: 16, 3:30

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_
