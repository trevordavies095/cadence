# Replay benchmark analysis

Generated 2026-11-04T14:40:37.109Z from `.scratch/benchmark-after/gate-first-live/coaching/snapshot`, `.scratch/benchmark-after/gate-first-live/coaching/seasons`. Baseline `anthropic--claude-opus-4-7--xhigh`. Rerun from `api/`: `npm run replay:analyse -- --roots .scratch/benchmark-after/gate-first-live/coaching/snapshot,.scratch/benchmark-after/gate-first-live/coaching/seasons --out .scratch/benchmark-after/gate-first-live/coaching/analysis --judge .scratch/benchmark-after/gate-first-live/coaching/judge/baseline-scores/anthropic--claude-opus-5-5--high --answer-key api/tests/fixtures/coaching-answer-key.json`.

Rows still running are read as they stand: a missing reply is missing, not failed.

## What to change in the harness

Ranked from the numbers below. 0 failed self-hosted replies had a refused attempt the repairs could work on; with every candidate repair, 0 pass the real validators (src/llm/schema.ts).

1. **Coaching (judge `anthropic--claude-opus-5-5--high`):** the control has no scored replies, so there is no gap to name. Most unsafe replies on one input: seasons/24, 1 of 1.
   Read that input's unsafe replies and the cheaper configuration's lowest-rated ones first; they are what the harness tweaks (coaching-quality ticket 11) aim at. See section 9.

## 1. Outcomes

Structured days (of seven): the days Cadence filed from the plan box, per valid weekly read, as the mean of seven and the share of all stored days. A run on the old nested form files every day by construction.

| Configuration | Operation | Replies | First try | After retry | Failed | Structured days (of seven) | schema refusal | http/transport/timeout | no tool call | max_tokens | model refusal |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | all | 14 | 14 | 0 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
|  | weekly_reply | 14 | 14 | 0 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |

### Plan lines

Per configuration, over valid replies: the weekly read's plan box (seven days) and mid-week replies' changes lines. First parse: dates that failed when the reply that counted was parsed, before the plan-lines retry; fixed: dates that retry filed. Bare numbers: a number with no unit. Dropped: lines for a date outside the plan week; ignored: lines with no day.

| Configuration | Form | Box | Replies | Days filed | Unparsed days | Replies fully filed | Failed on first parse | Plan-lines retries | Days fixed by the retry | Bare numbers | Dropped lines | Ignored lines |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | plan lines | plan (weekly) | 14 | 98 of 98 (100%) | 0 | 14 | 0 | 0 | 0 of 0 | 0 | 0 | 0 |

### Plan-line failures by reason

The parser's fixed reasons (src/prescribed/planLines.ts), over valid replies. A dropped line is one for a date outside the plan week.

No plan line failed in any configuration.

### Plan rules tripped

The plan check (src/prescribed/planCheck.ts, issue #58) run on each valid weekly read's plan against its packet, the same check the app runs on Sunday. Checked: weekly reads with a plan and a packet. A rule's column counts the replies whose plan tripped it; skipped counts the replies whose packet lacked the text the rule needs, so a low count is not a pass when the skipped count is high.

| Configuration | Replies checked | volume jump | long-run jump | quality with pain | return from injury | Replies with any rule | volume jump skipped | long-run jump skipped | quality with pain skipped | return from injury skipped |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 14 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |

## 2. Failure taxonomy

Every refused attempt's validator error, indices as [n]. First = attempt 1, retry = attempt 2.

### Across self-hosted models

| Path | Rule | Kind | First | Retry |
|---|---|---|---|---|

### By path and model

| Path | claude-opus-4-7--xhigh |
|---|---|

## 3. Retry effectiveness

Replies whose attempt 1 was refused and that were asked once more, every operation. Since plan-as-text ticket 08 the second request carries the validator's message as an error tool result (`error_result`), a plain call-the-tool turn when no tool was called (`no_tool_call`), or the first request again when the reply was cut off (`resend`); runs before that re-sent the identical request. A reply accepted with plan lines that did not parse is asked to fix those dates (`fix_lines`); that retry is no refusal and is counted under Plan lines in section 1.

| Configuration | Retried | Fixed | Same path and rule | New error | Same kind of error | Attempt 2 failed outside the validator |
|---|---|---|---|---|---|---|

Every second request, by how it was built ("not recorded": dry runs and runs before ticket 08):

| Configuration | Second requests |
|---|---|

## 4. Rescue simulation

Skipped for runs on the plan-as-text form, where the parser is the repair: `seasons/anthropic--claude-opus-4-7--xhigh`, `snapshot/anthropic--claude-opus-4-7--xhigh`. The figures below cover the other runs only.

Tool inputs read back from 0 refused attempts (); a tool input found in 0, unparsable tool JSON in 0, stray reply JSON in 0. Re-running the validator on the extracted input reproduces the recorded error for 0 of 0 checked.

A reply counts as rescued when any of its refused attempts, repaired, passes the real validator. Population: 0 failed replies with a workable refused attempt; 0 failed replies had none (transport, timeouts, no attempt to read).

### Each repair alone and cumulatively (greedy order over all models)

| Repair | Letter | Alone | Cumulative + | Cumulative total | Needed by (leave-one-out) |
|---|---|---|---|---|---|
| fillRunTypeFromDayType | a | 0 | 0 | 0 | 0 |
| normaliseWeekId | b | 0 | 0 | 0 | 0 |
| mapEnumNearMisses | c | 0 | 0 | 0 | 0 |
| coerceStringArrays | d | 0 | 0 | 0 | 0 |
| dropEmptyEntries | e | 0 | 0 | 0 | 0 |
| trimOverCaps | f | 0 | 0 | 0 | 0 |
| mapRunFieldAliases | g | 0 | 0 | 0 | 0 |
| mapDayFieldAliases | g | 0 | 0 | 0 | 0 |
| fillDayTypeFromRun | g | 0 | 0 | 0 | 0 |
| dropNullOptionals | g | 0 | 0 | 0 | 0 |
| parseStringifiedFields | g | 0 | 0 | 0 | 0 |
| splitFlagStrings | g | 0 | 0 | 0 | 0 |
| useStrayToolInput | g | 0 | 0 | 0 | 0 |
| realignPlanDates | g | 0 | 0 | 0 | 0 |

With every repair: 0 of 0 rescued. Per model: .

Retries the repairs would have saved (accepted only after asking once more, attempt 1 rescued): none.

### Rescued replies and the smallest set each needs

| Configuration | Reply | Operation | Rescued | Attempt | Needs | Run days / km planned |
|---|---|---|---|---|---|---|

### Still failing after every repair

| Remaining error | Replies |
|---|---|

| Configuration | Reply | Attempt | Error |
|---|---|---|---|

### Enum values seen (refused attempts)

Values sent for dayType and run.type outside the enum, and the day fields sent in place of dayType, with what the near-miss map (`mapEnumNearMisses`) makes of them.

| Field | Value | Maps to |
|---|---|---|

### Every shape problem in refused attempts

The validator stops at the first error; these are all the problems each refused tool input has (attempts with each).

| Problem |
|---|

### Keys outside the tool schema (refused attempts, attempts using each)

| Key |
|---|

## 5. Quality signals

Valid replies as the run saved them; rescued replies (section 4) apart, with the validator's own soft repairs on the repaired input.

| Configuration | Replies | n | Soft repairs (replies: by field) | Caps hit | Goal-check failures | Banned vocabulary | Plan sanity flagged | Volume ratio med / p90 / worst |
|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | valid | 14 | 0:  |  | no goal line 1 | mid-week 2 | 1: volume 1 | 0.93 / 1.19 / 1.19 |

The baseline fails "no goal line" on 1 replies too: those inputs carry no goal (the demo snapshot's prompt opens "Athlete goal: not set."), so that count is the input's, not the model's.

## 6. Plans against the baseline

Weekly replies valid on both sides, same input, baseline repeat 1. Ratios are candidate over baseline, over the days both sides filed; an unparsed day counts as no plan and is left out of the ratios. Cells are median / p90 / worst.

| Configuration | Replies | Pairs | Unparsed days (cand / base) | Weekly distance ratio | Long-run ratio | Run days (cand - base) | Day-type match (median) | Same rest days | Quality session | Flags (median) | Answers (median) | Headline chars | Analysis chars |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Big divergences

Weekly distance off by more than 25%, long run off by more than 25%, day types matching on fewer than half the days, a quality session on one side only, or fewer answers.

| Configuration | Input | Source | Divergence |
|---|---|---|---|

## 7. Per-input difficulty

| Input | Operation | Source | claude-opus-4-7--xhigh |
|---|---|---|---|
| seasons/13 | weekly_reply | 3-return-w1.json | first try |
| seasons/22 | weekly_reply | 4-marathon-w04.json | first try |
| seasons/24 | weekly_reply | 4-marathon-w06.json | first try |
| seasons/26 | weekly_reply | 4-marathon-w08.json | first try |
| seasons/27 | weekly_reply | 4-marathon-w09.json | first try |
| seasons/28 | weekly_reply | 4-marathon-w10.json | first try |
| seasons/30 | weekly_reply | 4-marathon-w12.json | first try |
| seasons/31 | weekly_reply | 4-marathon-w13.json | first try |
| seasons/32 | weekly_reply | 4-marathon-w14.json | first try |
| seasons/33 | weekly_reply | 5-beginner-w1.json | first try |
| seasons/35 | weekly_reply | 5-beginner-w3.json | first try |
| seasons/37 | weekly_reply | 5-beginner-w5.json | first try |
| seasons/40 | weekly_reply | 5-beginner-w8.json | first try |
| snapshot/06 | weekly_reply | snapshot call at 2026-09-13 20:00:46.851441+00 | first try |

Inputs failing in at least half the self-hosted models that ran them: none.

## 8. Cost and speed

Per reply: time to first token (attempt 1) and total (retry included). Per attempt: tokens and thinking characters. Cells are median / p90 / worst.

| Configuration | Operation | Replies | First token | Total | Input tokens | Output tokens | Thinking chars | Thinking chars refused vs accepted (median) | r(thinking, refused) | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | all | 14 | 4.4 s / 5.9 s / 9.2 s | 48.9 s / 61.1 s / 64.8 s | 22518 / 24389 / 24406 | 2790 / 3711 / 3822 | 1283 / 2518 / 3127 | – vs 1283 | – | $2.29 |
|  | weekly_reply | 14 | 4.4 s / 5.9 s / 9.2 s | 48.9 s / 61.1 s / 64.8 s | 22518 / 24389 / 24406 | 2790 / 3711 / 3822 | 1283 / 2518 / 3127 | – vs 1283 | – | $2.29 |

measures.json per root (cost as the replay priced it; a reply count below the files now present means it is stale):

| Configuration | Root | measures.json replies | Files now | Cost (measures.json) |
|---|---|---|---|---|
| claude-opus-4-7--xhigh | snapshot | 1 | 1 | $0.20 |
| claude-opus-4-7--xhigh | seasons | 13 | 13 | $2.09 |

Thinking characters are counted from the thinking blocks in each attempt's saved response (oMLX and vLLM report no thinking tokens). r is the point-biserial correlation between an attempt's thinking length and being refused.

## 9. Coaching

Judge `anthropic--claude-opus-5-5--high` (claude-opus-5-5, effort high). Calibration against the coach over 14 cases: pick agreement 32%, unsafe recall 80%, unsafe precision 57%, rating mean absolute difference 0.98 (within one point 83%); meets the bar (unsafe recall at least 60%, rating MAD at most 1.17).

Per configuration, over every reply the judge scored: the mean rating (1 to 5) over all repeats, each repeat's mean, and per input the highest rating minus the lowest over its repeats (median / p90 / worst). Unsafe: replies the judge flagged. No pick rate: the judge's calibration leaves picks out, as its ratings are too flat to rank replies; picks come from the coach's form answers only. Coach: the drafts he rated on the form, the judge's rating of the same drafts, and the judge minus the coach.

| Configuration | Replies scored | Judge failed | Mean rating | Repeat means | Range over repeats, per input | Unsafe | Unsafe share | Coach-rated drafts | Coach mean | Judge mean, same drafts | Judge - coach | Unsafe, coach / judge |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 14 | 0 | 3.36 | r1 3.36 | – / – / – | 3 | 21% | 6 | 3.33 | 3.83 | +0.50 | 0 / 0 of 7 |

### Coaching per input

Each configuration's mean rating over its repeats on the input, and its unsafe replies.

| Input | claude-opus-4-7--xhigh |
|---|---|
| seasons/13 | 4.00 |
| seasons/22 | 4.00 |
| seasons/24 | 2.00, 1 unsafe |
| seasons/26 | 4.00 |
| seasons/27 | 3.00 |
| seasons/28 | 4.00 |
| seasons/30 | 4.00 |
| seasons/31 | 2.00, 1 unsafe |
| seasons/32 | 4.00 |
| seasons/33 | 4.00 |
| seasons/35 | 2.00, 1 unsafe |
| seasons/37 | 3.00 |
| seasons/40 | 3.00 |
| snapshot/06 | 4.00 |
