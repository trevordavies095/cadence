# Replay gate: first-pass report

Generated 2026-11-04T12:22:25.319Z from 18 replayed coach calls across 6 configurations in .scratch/benchmark-coaching/baseline/snapshot.

The checks below only point at what to read. A figure listed as missing may be rounded, restated or deliberately dropped; each one is judged by a person before the gate passes.

## Configurations

Schema outcomes: replies accepted on the first try, accepted when asked once more, and refused on every attempt. The other columns are the measures; each configuration's section breaks them down.

| Configuration | Provider | Host | Model | Effort | Repeats | Note | Replies | First try | After retry | Failed | Wall clock | First token (median / worst) | Total (median / worst) | Input tok (median) | Output tok (median) | Thinking tok (median) | Thinking chars (median) | Prompt cut | Soft repairs | Caps hit | Goal-check failures | Banned words | Plan sanity flags | Cost total | Cost per reply (median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anthropic--claude-haiku-5-5--high | anthropic |  | claude-haiku-5-5 | high | 3 | Anthropic API | 3 | 3 | 0 | 0 | 163.5 s | 6.8 s / 7.2 s | 56.5 s / 58.7 s | 24406 | 2941 | 544 | 700 | 0 of 3 | 0 | 0 | 3 | 0 | 0 of 3 | $0.5809 | $0.1956 |
| anthropic--claude-opus-4-7--high | anthropic |  | claude-opus-4-7 | high | 3 | Anthropic API | 3 | 3 | 0 | 0 | 167.7 s | 5.1 s / 5.7 s | 57.8 s / 61.1 s | 24406 | 3196 | 935 | 1003 | 0 of 3 | 0 | 0 | 3 | 0 | 0 of 3 | $0.5954 | $0.2019 |
| anthropic--claude-opus-4-7--xhigh | anthropic |  | claude-opus-4-7 | xhigh | 3 | Anthropic API | 3 | 3 | 0 | 0 | 162.3 s | 4.3 s / 5.2 s | 51.6 s / 60.2 s | 24406 | 2856 | 846 | 862 | 0 of 3 | 0 | 0 | 3 | 1 | 0 of 3 | $0.5916 | $0.1934 |
| anthropic--claude-opus-5-5--xhigh | anthropic |  | claude-opus-5-5 | xhigh | 3 | Anthropic API | 3 | 3 | 0 | 0 | 173.5 s | 5.3 s / 7.6 s | 57.4 s / 64.0 s | 24406 | 3031 | 937 | 1037 | 0 of 3 | 0 | 0 | 3 | 0 | 0 of 3 | $0.6093 | $0.1978 |
| anthropic--claude-sonnet-5-5--xhigh | anthropic |  | claude-sonnet-5-5 | xhigh | 3 | Anthropic API | 3 | 3 | 0 | 0 | 176.6 s | 5.2 s / 6.0 s | 57.7 s / 62.0 s | 24406 | 3307 | 993 | 1240 | 0 of 3 | 0 | 0 | 3 | 1 | 0 of 3 | $0.6143 | $0.2047 |
| self_hosted--gpt-oss-20b-MXFP4-Q8--high | self_hosted | <macbook> | gpt-oss-20b-MXFP4-Q8 | high | 3 | MacBook Pro M4 Pro 24 GB, oMLX, 64k+ context | 3 | 3 | 0 | 0 | 96.2 s | 1.2 s / 29.0 s | 25.8 s / 46.3 s | 16828 | 1379 | – | 3214 | 0 of 3 | 0 | 0 | 3 | 2 | 0 of 3 |  |  |

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

- anthropic--claude-haiku-5-5--high/06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-haiku-5-5--high/06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-haiku-5-5--high/06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-opus-4-7--high/06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-opus-4-7--high/06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-opus-4-7--high/06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-opus-4-7--xhigh/06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-opus-4-7--xhigh/06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-opus-4-7--xhigh/06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-opus-5-5--xhigh/06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-opus-5-5--xhigh/06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-opus-5-5--xhigh/06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-sonnet-5-5--xhigh/06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-sonnet-5-5--xhigh/06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- anthropic--claude-sonnet-5-5--xhigh/06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal
- self_hosted--gpt-oss-20b-MXFP4-Q8--high/06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- self_hosted--gpt-oss-20b-MXFP4-Q8--high/06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- self_hosted--gpt-oss-20b-MXFP4-Q8--high/06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal

## anthropic--claude-haiku-5-5--high

Provider anthropic. Model claude-haiku-5-5, effort high. 3 repeats over demo snapshot.
Started 2026-11-03T15:11:57.239Z, resumed 2026-11-03T15:27:33.827Z, 2026-11-04T11:36:38.415Z. Harness commit 4b0b84b37ffbeb941347c2453eb59353ac7cd614. Note: Anthropic API

Replies: 3 weekly reads.

### Measures

| Measure | Value |
|---|---|
| Schema | 3 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 3 (no goal line 3) |
| Banned words | 0 in 0 replies (none) |
| Plan sanity | 0 of 3 weekly plans flagged (none); volume ratio median 0.58, highest 0.76 |
| First token (median / worst) | 6.8 s / 7.2 s |
| Total time (median / worst) | 56.5 s / 58.7 s |
| Wall clock (all calls) | 163.5 s |
| Input tokens (median) | 24406 |
| Output tokens (median) | 2941 |
| Thinking tokens (median) | 544 |
| Thinking characters (median) | 700 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 3; lowest ratio 238.5 % |
| Cost | $0.5809 over 3 replies; median $0.1956, worst $0.1983 (prices taken 2026-11-03) |

### Goal checks

- 06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal

### 06.1: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 2941.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1367 |
| Headline | | 235 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: 16

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

### 06.2: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3049.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1562 |
| Headline | | 214 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: none

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

### 06.3: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 2603.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1562 |
| Headline | | 207 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: none

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

## anthropic--claude-opus-4-7--high

Provider anthropic. Model claude-opus-4-7, effort high. 3 repeats over demo snapshot.
Started 2026-11-03T13:07:55.949Z, resumed 2026-11-03T15:11:55.458Z, 2026-11-03T15:11:56.343Z. Harness commit 3046c4c2dedde93dbf871beec5b8ea89ef183403. Note: Anthropic API

Replies: 3 weekly reads.

### Measures

| Measure | Value |
|---|---|
| Schema | 3 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 3 (no goal line 3) |
| Banned words | 0 in 0 replies (none) |
| Plan sanity | 0 of 3 weekly plans flagged (none); volume ratio median 0.66, highest 0.74 |
| First token (median / worst) | 5.1 s / 5.7 s |
| Total time (median / worst) | 57.8 s / 61.1 s |
| Wall clock (all calls) | 167.7 s |
| Input tokens (median) | 24406 |
| Output tokens (median) | 3196 |
| Thinking tokens (median) | 935 |
| Thinking characters (median) | 1003 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 3; lowest ratio 238.5 % |
| Cost | $0.5954 over 3 replies; median $0.2019, worst $0.2085 (prices taken 2026-11-03) |

### Goal checks

- 06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal

### 06.1: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3196.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1589 |
| Headline | | 245 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | yes |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: 3:30

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

### 06.2: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3460.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1495 |
| Headline | | 213 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: none

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

### 06.3: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 2516.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1170 |
| Headline | | 236 chars |
| Flags | | 5 |
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

## anthropic--claude-opus-4-7--xhigh

Provider anthropic. Model claude-opus-4-7, effort xhigh. 3 repeats over demo snapshot.
Started 2026-11-03T12:31:50.321Z, resumed 2026-11-03T15:11:53.570Z, 2026-11-03T15:11:54.537Z. Harness commit 3046c4c2dedde93dbf871beec5b8ea89ef183403. Note: Anthropic API

Replies: 3 weekly reads.

### Measures

| Measure | Value |
|---|---|
| Schema | 3 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 3 (no goal line 3) |
| Banned words | 1 in 1 replies (mid-week 1) |
| Plan sanity | 0 of 3 weekly plans flagged (none); volume ratio median 0.71, highest 0.76 |
| First token (median / worst) | 4.3 s / 5.2 s |
| Total time (median / worst) | 51.6 s / 60.2 s |
| Wall clock (all calls) | 162.3 s |
| Input tokens (median) | 24406 |
| Output tokens (median) | 2856 |
| Thinking tokens (median) | 846 |
| Thinking characters (median) | 862 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 3; lowest ratio 238.5 % |
| Cost | $0.5916 over 3 replies; median $0.1934, worst $0.2067 (prices taken 2026-11-03) |

### Goal checks

- 06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal

### 06.1: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 2776.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1590 |
| Headline | | 232 chars |
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

### 06.2: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3387.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1570 |
| Headline | | 236 chars |
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

### 06.3: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 2856.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1369 |
| Headline | | 208 chars |
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

## anthropic--claude-opus-5-5--xhigh

Provider anthropic. Model claude-opus-5-5, effort xhigh. 3 repeats over demo snapshot.
Started 2026-11-03T16:33:41.598Z, resumed 2026-11-03T16:59:05.471Z, 2026-11-04T12:21:33.051Z. Harness commit 4b0b84b37ffbeb941347c2453eb59353ac7cd614. Note: Anthropic API

Replies: 3 weekly reads.

### Measures

| Measure | Value |
|---|---|
| Schema | 3 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 3 (no goal line 3) |
| Banned words | 0 in 0 replies (none) |
| Plan sanity | 0 of 3 weekly plans flagged (none); volume ratio median 0.63, highest 0.68 |
| First token (median / worst) | 5.3 s / 7.6 s |
| Total time (median / worst) | 57.4 s / 64.0 s |
| Wall clock (all calls) | 173.5 s |
| Input tokens (median) | 24406 |
| Output tokens (median) | 3031 |
| Thinking tokens (median) | 937 |
| Thinking characters (median) | 1037 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 3; lowest ratio 238.5 % |
| Cost | $0.6093 over 3 replies; median $0.1978, worst $0.2154 (prices taken 2026-11-03) |

### Goal checks

- 06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal

### 06.1: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 2961.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1369 |
| Headline | | 226 chars |
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

### 06.2: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3735.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1492 |
| Headline | | 199 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: none

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

### 06.3: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3031.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1650 |
| Headline | | 197 chars |
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

## anthropic--claude-sonnet-5-5--xhigh

Provider anthropic. Model claude-sonnet-5-5, effort xhigh. 3 repeats over demo snapshot.
Started 2026-11-03T15:45:34.406Z, resumed 2026-11-03T16:10:50.208Z, 2026-11-04T11:55:44.268Z. Harness commit 4b0b84b37ffbeb941347c2453eb59353ac7cd614. Note: Anthropic API

Replies: 3 weekly reads.

### Measures

| Measure | Value |
|---|---|
| Schema | 3 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 3 (no goal line 3) |
| Banned words | 1 in 1 replies (mid-week 1) |
| Plan sanity | 0 of 3 weekly plans flagged (none); volume ratio median 0.61, highest 0.76 |
| First token (median / worst) | 5.2 s / 6.0 s |
| Total time (median / worst) | 57.7 s / 62.0 s |
| Wall clock (all calls) | 176.6 s |
| Input tokens (median) | 24406 |
| Output tokens (median) | 3307 |
| Thinking tokens (median) | 993 |
| Thinking characters (median) | 1240 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 3; lowest ratio 238.5 % |
| Cost | $0.6143 over 3 replies; median $0.2047, worst $0.2091 (prices taken 2026-11-03) |

### Goal checks

- 06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal

### 06.1: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3139.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1390 |
| Headline | | 236 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: none

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

### 06.2: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3483.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1282 |
| Headline | | 204 chars |
| Flags | | 4 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

Figures in the old read not found anywhere in the new reply: none

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

### 06.3: weekly read on 2026-09-13

Model claude-opus-4-7. Outcome ok. Tokens in 24406, out 3307.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1636 |
| Headline | | 225 chars |
| Flags | | 5 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | mid-week |

Figures in the old read not found anywhere in the new reply: 3:30

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

## self_hosted--gpt-oss-20b-MXFP4-Q8--high

Provider self_hosted at <macbook>. Model gpt-oss-20b-MXFP4-Q8, effort high. 3 repeats over demo snapshot.
Started 2026-11-03T12:32:37.032Z. Harness commit 380933a762f5d15170c1328d4e0ef515a4752e1e. Note: MacBook Pro M4 Pro 24 GB, oMLX, 64k+ context

Replies: 3 weekly reads.

### Measures

| Measure | Value |
|---|---|
| Schema | 3 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 3 (no goal line 3) |
| Banned words | 2 in 2 replies (raw date 1, recap 1) |
| Plan sanity | 0 of 3 weekly plans flagged (none); volume ratio median 0.79, highest 0.84 |
| First token (median / worst) | 1.2 s / 29.0 s |
| Total time (median / worst) | 25.8 s / 46.3 s |
| Wall clock (all calls) | 96.2 s |
| Input tokens (median) | 16828 |
| Output tokens (median) | 1379 |
| Thinking tokens (median) | not reported |
| Thinking characters (median) | 3214 |
| Cache read / write tokens (median) | – / – |
| Prompt cut | 0 of 3; lowest ratio 164.5 % |
| Cost | self-hosted: not priced |

### Goal checks

- 06.1 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.2 (weekly read on 2026-09-13): no goal line: the packet has no goal
- 06.3 (weekly read on 2026-09-13): no goal line: the packet has no goal

### 06.1: weekly read on 2026-09-13

Model gpt-oss-20b-MXFP4-Q8. Outcome ok. Tokens in 16828, out 1051.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1162 |
| Headline | | 66 chars |
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

### 06.2: weekly read on 2026-09-13

Model gpt-oss-20b-MXFP4-Q8. Outcome ok. Tokens in 16828, out 1379.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 683 |
| Headline | | 59 chars |
| Flags | | 4 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 6 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | raw date |

Figures in the old read not found anywhere in the new reply: 10, 16, 3:30

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_

### 06.3: weekly read on 2026-09-13

Model gpt-oss-20b-MXFP4-Q8. Outcome ok. Tokens in 16828, out 1481.

Goal: none. Goal checks: no goal line.

| Check | Old | New |
|---|---|---|
| Read length (characters) | 1439 | 1109 |
| Headline | | 77 chars |
| Flags | | 1 |
| Questions answered | 0 | 1 |
| Session reasons | 0 in the read | 5 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | recap |

Figures in the old read not found anywhere in the new reply: 10, 16, 3:30

Old questions:
- none found

New answers to:
- 

Verdict: _to be judged_
