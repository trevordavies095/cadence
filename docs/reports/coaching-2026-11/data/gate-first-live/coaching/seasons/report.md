# Replay gate: first-pass report

Generated 2026-11-04T14:38:20.717Z from 13 replayed coach calls across 1 configuration in .scratch/benchmark-after/gate-first-live/coaching/seasons.

The checks below only point at what to read. A figure listed as missing may be rounded, restated or deliberately dropped; each one is judged by a person before the gate passes.

## Configurations

Schema outcomes: replies accepted on the first try, accepted when asked once more, and refused on every attempt. The other columns are the measures; each configuration's section breaks them down.

| Configuration | Provider | Host | Model | Effort | Repeats | Note | Replies | First try | After retry | Failed | Wall clock | First token (median / worst) | Total (median / worst) | Input tok (median) | Output tok (median) | Thinking tok (median) | Thinking chars (median) | Prompt cut | Soft repairs | Caps hit | Goal-check failures | Banned words | Plan sanity flags | Cost total | Cost per reply (median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anthropic--claude-opus-4-7--xhigh | anthropic |  | claude-opus-4-7 | xhigh | 1 |  | 13 | 13 | 0 | 0 | 623.1 s | 4.3 s / 5.9 s | 48.9 s / 61.1 s | 22363 | 2771 | 1158 | 1385 | 0 of 13 | 0 | 0 | 0 | 1 | 1 of 13 | $2.0878 | $0.1750 |

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

All passed: every packet has a goal line, no non-marathon reply says marathon, no stay-fit reply gives a long-run verdict, and no reply was refused.

## anthropic--claude-opus-4-7--xhigh

Provider anthropic. Model claude-opus-4-7, effort xhigh. 1 repeat over api/tests/fixtures/seasons/season-packets.
Started 2026-11-04T14:27:57.617Z. Harness commit 99843954d41608139b592d3d533adc7b4b7a14f7. Rules retry on.

Replies: 13 weekly reads.

### Measures

| Measure | Value |
|---|---|
| Schema | 13 first try, 0 after retry, 0 failed |
| Soft repairs | 0 in 0 replies (none) |
| Length caps hit | 0 (none) |
| Goal-check failures | 0 (none) |
| Banned words | 1 in 1 replies (mid-week 1) |
| Plan sanity | 1 of 13 weekly plans flagged (volume 1); volume ratio median 0.97, highest 1.19; not checked: volume 5 |
| First token (median / worst) | 4.3 s / 5.9 s |
| Total time (median / worst) | 48.9 s / 61.1 s |
| Wall clock (all calls) | 623.1 s |
| Input tokens (median) | 22363 |
| Output tokens (median) | 2771 |
| Thinking tokens (median) | 1158 |
| Thinking characters (median) | 1385 |
| Cache read / write tokens (median) | 0 / 0 |
| Prompt cut | 0 of 13; lowest ratio 226.1 % |
| Cost | $2.0878 over 13 replies; median $0.1750, worst $0.2056 (prices taken 2026-11-03) |

Plan sanity flags:

- 31.1: volume: 3.2 km planned is 0.05x the recent 65.7 km

### Goal checks

All passed: every packet has a goal line, no non-marathon reply says marathon, no stay-fit reply gives a long-run verdict, and no reply was refused.

### 13.1 (3-return-w1.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 5991, out 3711.

Goal: return. Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1209 |
| Headline | | 196 chars |
| Flags | | 5 |
| Questions answered |  | 0 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- none

Verdict: _to be judged_

### 22.1 (4-marathon-w04.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 18812, out 2809.

Goal: race (marathon). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1278 |
| Headline | | 165 chars |
| Flags | | 5 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- Is this an IT band thing? Should I still do Wednesday's tempo?

Verdict: _to be judged_

### 24.1 (4-marathon-w06.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 22673, out 2639.

Goal: race (marathon). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1401 |
| Headline | | 179 chars |
| Flags | | 5 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- I missed Thursday and cut the long run short. Should I make up the miles next week?

Verdict: _to be judged_

### 26.1 (4-marathon-w08.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 24043, out 3414.

Goal: race (marathon). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1172 |
| Headline | | 151 chars |
| Flags | | 5 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- I ran way more than the plan and felt fine. Can I keep this up?

Verdict: _to be judged_

### 27.1 (4-marathon-w09.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 23636, out 2888.

Goal: race (marathon). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1078 |
| Headline | | 164 chars |
| Flags | | 5 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- My club mate runs 70 miles a week before a marathon. I'm thinking of doubling to 80 next week to catch up, running twice a day. Would that work?

Verdict: _to be judged_

### 28.1 (4-marathon-w10.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 24389, out 2726.

Goal: race (marathon). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 971 |
| Headline | | 180 chars |
| Flags | | 5 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- The race got moved two weeks earlier, to October 18, because of the bridge works. That's three weeks from today. I've only done one 20. Do I still have time for my 22-miler?

Verdict: _to be judged_

### 30.1 (4-marathon-w12.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 24386, out 2121.

Goal: race (marathon). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1345 |
| Headline | | 154 chars |
| Flags | | 5 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- Is it crazy to do one more 16-miler on Wednesday so I feel ready?

Verdict: _to be judged_

### 31.1 (4-marathon-w13.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 23760, out 2771.

Goal: race (marathon). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1416 |
| Headline | | 203 chars |
| Flags | | 5 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- How long before I can run again? A friend wants me to race the Thanksgiving 10K in five weeks.

Verdict: _to be judged_

### 32.1 (4-marathon-w14.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 22363, out 2654.

Goal: race (marathon). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 894 |
| Headline | | 196 chars |
| Flags | | 5 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | mid-week |

New answers to:
- I feel ready. Can I go back to 40 miles next week and start speedwork for the 10K?

Verdict: _to be judged_

### 33.1 (5-beginner-w1.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 6056, out 3241.

Goal: race (5k). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1099 |
| Headline | | 168 chars |
| Flags | | 3 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- I want to be ready for the 5K in November. Should I run every day next week to get there faster?

Verdict: _to be judged_

### 35.1 (5-beginner-w3.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 10638, out 1946.

Goal: race (5k). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 839 |
| Headline | | 157 chars |
| Flags | | 4 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- Can I do all three runs next week and add the two I missed?

Verdict: _to be judged_

### 37.1 (5-beginner-w5.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 14202, out 2106.

Goal: race (5k). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1259 |
| Headline | | 155 chars |
| Flags | | 4 |
| Questions answered |  | 0 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- none

Verdict: _to be judged_

### 40.1 (5-beginner-w8.json): weekly read

Model claude-opus-4-7. Outcome ok. Tokens in 12370, out 3822.

Goal: race (5k). Goal checks: passed.

| Check | Old | New |
|---|---|---|
| Read length (characters) |  | 1307 |
| Headline | | 165 chars |
| Flags | | 5 |
| Questions answered |  | 1 |
| Session reasons |  | 7 days with notes |
| Read repeats the headline | | no |
| Read lists the days (as a list or a table) | | no |
| A flag or answer points "above" or "below" | | no |
| Read repeats an answer's table | | no |
| Internal words | | none |

New answers to:
- I haven't run for two weeks. Do I have to start again from the beginning? And is the 5K in four weeks still realistic?

Verdict: _to be judged_
