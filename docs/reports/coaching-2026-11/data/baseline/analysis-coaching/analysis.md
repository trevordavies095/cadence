# Replay benchmark analysis

Generated 2026-11-04T13:16:25.103Z from `.scratch/benchmark-coaching/baseline/seasons`, `.scratch/benchmark-coaching/baseline/snapshot`. Baseline `anthropic--claude-opus-4-7--xhigh`. Rerun from `api/`: `npm run replay:analyse -- --roots .scratch/benchmark-coaching/baseline/seasons,.scratch/benchmark-coaching/baseline/snapshot --out .scratch/benchmark-coaching/baseline/analysis-coaching --judge .scratch/benchmark-coaching/judge-2/baseline-scores/anthropic--claude-opus-5-5--high --answer-key api/tests/fixtures/coaching-answer-key.json`.

Rows still running are read as they stand: a missing reply is missing, not failed.

## What to change in the harness

Ranked from the numbers below. 0 failed self-hosted replies had a refused attempt the repairs could work on; with every candidate repair, 0 pass the real validators (src/llm/schema.ts).

1. **Plan volume:** 42 weekly plans differ from the baseline's distance by more than 25% (gpt-oss-20b-MXFP4-Q8--high 13, claude-opus-5-5--xhigh 9, claude-haiku-5-5--high 8, claude-sonnet-5-5--xhigh 7, claude-opus-4-7--high 5); worst gpt-oss-20b-MXFP4-Q8--high seasons/31 x2.75, gpt-oss-20b-MXFP4-Q8--high seasons/33 x2.57, gpt-oss-20b-MXFP4-Q8--high seasons/31 x2.25.
   Read these plans beside the baseline's; a ratio far from 1 on a rescued plan can also be a unit guessed wrong by mapRunFieldAliases.
2. **Coaching (judge `anthropic--claude-opus-5-5--high`):** against the control claude-opus-4-7--xhigh (mean 3.31), gpt-oss-20b-MXFP4-Q8--high is 1.48 below, the largest gap; the closest cheaper is claude-sonnet-5-5--xhigh at -0.48. Most unsafe replies on one input: seasons/31, 18 of 18.
   Read that input's unsafe replies and the cheaper configuration's lowest-rated ones first; they are what the harness tweaks (coaching-quality ticket 11) aim at. See section 9.
3. **Retry prompt:** of 9 retried replies, attempt 2 fixed 8, repeated the same path and rule in 1, and failed on a new error in 0. Per model: claude-haiku-5-5--high 4/1/0; claude-sonnet-5-5--xhigh 2/0/0; gpt-oss-20b-MXFP4-Q8--high 2/0/0 (fixed/same/new).
   Since plan-as-text ticket 08 the retry sends the reply back with the validator's message as an error tool result (a plain "call the tool" turn when no tool was called, the request unchanged when the reply was cut off); see the second requests by kind in section 3. On runs before that, it re-sent the identical request.
4. **No tool call:** 1 attempts came back with stop_reason tool_use but no submit_* block (0 replies failed that way); stray JSON found for 0.
   The server dropped the call (thinking only); not fixable from the stream, so a retry or tool_choice {type: "tool"} is the lever.

## 1. Outcomes

Structured days (of seven): the days Cadence filed from the plan box, per valid weekly read, as the mean of seven and the share of all stored days. A run on the old nested form files every day by construction.

| Configuration | Operation | Replies | First try | After retry | Failed | Structured days (of seven) | schema refusal | http/transport/timeout | no tool call | max_tokens | model refusal |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | all | 42 | 41 | 0 | 1 | 7.0 (100%) | 1 | 0 | 0 | 0 | 0 |
|  | weekly_reply | 42 | 41 | 0 | 1 | 7.0 (100%) | 1 | 0 | 0 | 0 | 0 |
| claude-haiku-5-5--high | all | 42 | 37 | 4 | 1 | 7.0 (100%) | 0 | 0 | 0 | 1 | 0 |
|  | weekly_reply | 42 | 37 | 4 | 1 | 7.0 (100%) | 0 | 0 | 0 | 1 | 0 |
| claude-opus-4-7--high | all | 42 | 42 | 0 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
|  | weekly_reply | 42 | 42 | 0 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
| claude-opus-5-5--xhigh | all | 42 | 42 | 0 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
|  | weekly_reply | 42 | 42 | 0 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
| claude-sonnet-5-5--xhigh | all | 42 | 40 | 2 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
|  | weekly_reply | 42 | 40 | 2 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | all | 42 | 40 | 2 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
|  | weekly_reply | 42 | 40 | 2 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |

### Plan lines

Per configuration, over valid replies: the weekly read's plan box (seven days) and mid-week replies' changes lines. First parse: dates that failed when the reply that counted was parsed, before the plan-lines retry; fixed: dates that retry filed. Bare numbers: a number with no unit. Dropped: lines for a date outside the plan week; ignored: lines with no day.

| Configuration | Form | Box | Replies | Days filed | Unparsed days | Replies fully filed | Failed on first parse | Plan-lines retries | Days fixed by the retry | Bare numbers | Dropped lines | Ignored lines |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | plan lines | plan (weekly) | 41 | 287 of 287 (100%) | 0 | 41 | 0 | 0 | 0 of 0 | 0 | 0 | 0 |
| claude-haiku-5-5--high | plan lines | plan (weekly) | 41 | 287 of 287 (100%) | 0 | 41 | 0 | 0 | 0 of 0 | 0 | 0 | 0 |
| claude-opus-4-7--high | plan lines | plan (weekly) | 42 | 294 of 294 (100%) | 0 | 42 | 0 | 0 | 0 of 0 | 0 | 0 | 0 |
| claude-opus-5-5--xhigh | plan lines | plan (weekly) | 42 | 294 of 294 (100%) | 0 | 42 | 0 | 0 | 0 of 0 | 0 | 0 | 0 |
| claude-sonnet-5-5--xhigh | plan lines | plan (weekly) | 42 | 294 of 294 (100%) | 0 | 42 | 0 | 0 | 0 of 0 | 0 | 0 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | plan lines | plan (weekly) | 42 | 293 of 294 (100%) | 1 | 41 | 2 | 2 | 1 of 2 | 0 | 2 | 0 |

### Plan-line failures by reason

The parser's fixed reasons (src/prescribed/planLines.ts), over valid replies. A dropped line is one for a date outside the plan week.

| Configuration | Box | Reason | Failed on first parse | Fixed by the retry | Still unparsed | Lines dropped |
|---|---|---|---|---|---|---|
| gpt-oss-20b-MXFP4-Q8--high | plan | no line | 2 | 1 | 1 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | plan | outside the plan week | 0 | 0 | 0 | 2 |

### Plan rules tripped

The plan check (src/prescribed/planCheck.ts, issue #58) run on each valid weekly read's plan against its packet, the same check the app runs on Sunday. Checked: weekly reads with a plan and a packet. A rule's column counts the replies whose plan tripped it; skipped counts the replies whose packet lacked the text the rule needs, so a low count is not a pass when the skipped count is high.

| Configuration | Replies checked | volume jump | long-run jump | quality with pain | return from injury | Replies with any rule | volume jump skipped | long-run jump skipped | quality with pain skipped | return from injury skipped |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 41 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 |
| claude-haiku-5-5--high | 41 | 1 | 0 | 0 | 0 | 1 | 6 | 0 | 0 | 0 |
| claude-opus-4-7--high | 42 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 |
| claude-opus-5-5--xhigh | 42 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 |
| claude-sonnet-5-5--xhigh | 42 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | 42 | 8 | 9 | 5 | 2 | 17 | 6 | 0 | 0 | 0 |

## 2. Failure taxonomy

Every refused attempt's validator error, indices as [n]. First = attempt 1, retry = attempt 2.

### Across self-hosted models

| Path | Rule | Kind | First | Retry |
|---|---|---|---|---|
| (response) | Anthropic stopped at max_tokens before completing the reply tool call (stop_reason=max_tokens, output cap 20000 tokens) | max_tokens | 3 | 1 |
| flags | contains tool-call markup (<parameter ...>); write every box as plain text, one item per line | other | 3 | 0 |
| (response) | Anthropic response missing <tool> tool_use block | no tool call | 1 | 0 |
| answers | contains tool-call markup (<parameter ...>); write every box as plain text, one item per line | other | 1 | 0 |
| headline | is required and must be non-empty | missing or empty | 1 | 0 |

### By path and model

| Path | claude-opus-4-7--xhigh | claude-haiku-5-5--high | claude-opus-4-7--high | claude-opus-5-5--xhigh | claude-sonnet-5-5--xhigh | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|---|---|---|---|
| (response) | 0 | 2 | 0 | 0 | 2 | 1 |
| flags | 1 | 3 | 0 | 0 | 0 | 0 |
| answers | 1 | 1 | 0 | 0 | 0 | 0 |
| headline | 0 | 0 | 0 | 0 | 0 | 1 |

### claude-haiku-5-5--high

| Path | Rule | First | Retry |
|---|---|---|---|
| flags | contains tool-call markup (<parameter ...>); write every box as plain text, one item per line | 3 | 0 |
| (response) | Anthropic stopped at max_tokens before completing the reply tool call (stop_reason=max_tokens, output cap 20000 tokens) | 1 | 1 |
| answers | contains tool-call markup (<parameter ...>); write every box as plain text, one item per line | 1 | 0 |

### claude-sonnet-5-5--xhigh

| Path | Rule | First | Retry |
|---|---|---|---|
| (response) | Anthropic stopped at max_tokens before completing the reply tool call (stop_reason=max_tokens, output cap 20000 tokens) | 2 | 0 |

### gpt-oss-20b-MXFP4-Q8--high

| Path | Rule | First | Retry |
|---|---|---|---|
| (response) | Anthropic response missing <tool> tool_use block | 1 | 0 |
| headline | is required and must be non-empty | 1 | 0 |

## 3. Retry effectiveness

Replies whose attempt 1 was refused and that were asked once more, every operation. Since plan-as-text ticket 08 the second request carries the validator's message as an error tool result (`error_result`), a plain call-the-tool turn when no tool was called (`no_tool_call`), or the first request again when the reply was cut off (`resend`); runs before that re-sent the identical request. A reply accepted with plan lines that did not parse is asked to fix those dates (`fix_lines`); that retry is no refusal and is counted under Plan lines in section 1.

| Configuration | Retried | Fixed | Same path and rule | New error | Same kind of error | Attempt 2 failed outside the validator |
|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 1 | 0 (0%) | 0 | 1 | 1 | 0 |
| claude-haiku-5-5--high | 5 | 4 (80%) | 1 | 0 | 1 | 0 |
| claude-sonnet-5-5--xhigh | 2 | 2 (100%) | 0 | 0 | 0 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | 2 | 2 (100%) | 0 | 0 | 0 | 0 |

Every second request, by how it was built ("not recorded": dry runs and runs before ticket 08):

| Configuration | Second requests |
|---|---|
| claude-opus-4-7--xhigh | error_result 1 |
| claude-haiku-5-5--high | error_result 4, resend 1 |
| claude-sonnet-5-5--xhigh | resend 2 |
| gpt-oss-20b-MXFP4-Q8--high | fix_lines 2, error_result 1, no_tool_call 1 |

## 4. Rescue simulation

Skipped for runs on the plan-as-text form, where the parser is the repair: `seasons/anthropic--claude-haiku-5-5--high`, `seasons/anthropic--claude-opus-4-7--high`, `seasons/anthropic--claude-opus-4-7--xhigh`, `seasons/anthropic--claude-opus-5-5--xhigh`, `seasons/anthropic--claude-sonnet-5-5--xhigh`, `seasons/self_hosted--gpt-oss-20b-MXFP4-Q8--high`, `snapshot/anthropic--claude-haiku-5-5--high`, `snapshot/anthropic--claude-opus-4-7--high`, `snapshot/anthropic--claude-opus-4-7--xhigh`, `snapshot/anthropic--claude-opus-5-5--xhigh`, `snapshot/anthropic--claude-sonnet-5-5--xhigh`, `snapshot/self_hosted--gpt-oss-20b-MXFP4-Q8--high`. The figures below cover the other runs only.

Tool inputs read back from 12 refused attempts (message 12); a tool input found in 7, unparsable tool JSON in 3, stray reply JSON in 0. Re-running the validator on the extracted input reproduces the recorded error for 0 of 0 checked.

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

| Field | Value | Maps to | claude-haiku-5-5--high | claude-opus-4-7--high | claude-opus-5-5--xhigh | claude-sonnet-5-5--xhigh | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|---|---|---|---|---|

### Every shape problem in refused attempts

The validator stops at the first error; these are all the problems each refused tool input has (attempts with each).

| Problem | claude-haiku-5-5--high | claude-opus-4-7--high | claude-opus-5-5--xhigh | claude-sonnet-5-5--xhigh | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|---|---|---|

### Keys outside the tool schema (refused attempts, attempts using each)

| Key | claude-haiku-5-5--high | claude-opus-4-7--high | claude-opus-5-5--xhigh | claude-sonnet-5-5--xhigh | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|---|---|---|

## 5. Quality signals

Valid replies as the run saved them; rescued replies (section 4) apart, with the validator's own soft repairs on the repaired input.

| Configuration | Replies | n | Soft repairs (replies: by field) | Caps hit | Goal-check failures | Banned vocabulary | Plan sanity flagged | Volume ratio med / p90 / worst |
|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | valid | 41 | 0:  |  | no goal line 3 | mid-week 2, week label 1 | 5: volume 5 | 0.99 / 4.37 / 4.72 |
| claude-haiku-5-5--high | valid | 41 | 2: analysis 1, flags 1 |  | no goal line 3 | mid-week 2 | 9: volume 9 | 1.02 / 1.14 / 4.37 |
| claude-opus-4-7--high | valid | 42 | 1: headline 1 | headline 1 | no goal line 3 | mid-week 7, prescribed 1 | 5: volume 5 | 1.02 / 1.25 / 4.72 |
| claude-opus-5-5--xhigh | valid | 42 | 0:  |  | no goal line 3 |  | 6: volume 6 | 0.91 / 1.12 / 1.15 |
| claude-sonnet-5-5--xhigh | valid | 42 | 0:  |  | no goal line 3 | mid-week 1, prompt 1 | 6: volume 6 | 0.93 / 1.12 / 1.13 |
| gpt-oss-20b-MXFP4-Q8--high | valid | 42 | 2: plan 4 |  | no goal line 3 | prescribed 6, recap 3, RPE 2, week label 2, raw date 1 | 17: volume 17 | 1.05 / 9.73 / 13.41 |

The baseline fails "no goal line" on 3 replies too: those inputs carry no goal (the demo snapshot's prompt opens "Athlete goal: not set."), so that count is the input's, not the model's.

## 6. Plans against the baseline

Weekly replies valid on both sides, same input, baseline repeat 1. Ratios are candidate over baseline, over the days both sides filed; an unparsed day counts as no plan and is left out of the ratios. Cells are median / p90 / worst.

| Configuration | Replies | Pairs | Unparsed days (cand / base) | Weekly distance ratio | Long-run ratio | Run days (cand - base) | Day-type match (median) | Same rest days | Quality session | Flags (median) | Answers (median) | Headline chars | Analysis chars |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-haiku-5-5--high | valid | 41 | 0 / 0 (in 0 pairs) | 0.94 / 1.15 / 1.50 | 0.92 / 1.12 / 1.12 | 0 / 2 / 2 | 0.86 | 29/41 | 14 both, +4, -0 | 4 vs 5 | 1 vs 1 (fewer in 1) | 231 vs 178 | 1616 vs 1136 |
| claude-opus-4-7--high | valid | 42 | 0 / 0 (in 0 pairs) | 1 / 1.08 / 1.13 | 1 / 1.12 / 1.25 | 0 / 1 / 3 | 1 | 36/42 | 13 both, +0, -2 | 4 vs 5 | 1 vs 1 (fewer in 0) | 179 vs 183 | 1152 vs 1126 |
| claude-opus-5-5--xhigh | valid | 42 | 0 / 0 (in 0 pairs) | 0.94 / 1.05 / 1.12 | 0.87 / 1 / 1 | 0 / 2 / 2 | 1 | 32/42 | 15 both, +0, -0 | 5 vs 5 | 1 vs 1 (fewer in 0) | 198 vs 183 | 1842 vs 1126 |
| claude-sonnet-5-5--xhigh | valid | 42 | 0 / 0 (in 0 pairs) | 0.93 / 1.10 / 1.12 | 0.86 / 1.12 / 1.12 | 0 / 1 / 2 | 1 | 31/42 | 15 both, +0, -0 | 4 vs 5 | 1 vs 1 (fewer in 0) | 199 vs 183 | 1562 vs 1126 |
| gpt-oss-20b-MXFP4-Q8--high | valid | 42 | 1 / 0 (in 1 pairs) | 1.02 / 2.23 / 2.75 | 1.12 / 1.75 / 1.75 | 0 / 1 / 2 | 0.86 | 21/42 | 13 both, +14, -2 | 5 vs 5 | 1 vs 1 (fewer in 1) | 86 vs 183 | 770 vs 1126 |

### Big divergences

Weekly distance off by more than 25%, long run off by more than 25%, day types matching on fewer than half the days, a quality session on one side only, or fewer answers.

| Configuration | Input | Source | Divergence |
|---|---|---|---|
| gpt-oss-20b-MXFP4-Q8--high | seasons/31.1 | valid | weekly distance 35.4 km vs 12.9 km (x2.75); day types match on 2/7 days |
| gpt-oss-20b-MXFP4-Q8--high | seasons/33.1 | valid | weekly distance 19.0 km vs 7.4 km (x2.57) |
| gpt-oss-20b-MXFP4-Q8--high | seasons/31.3 | valid | weekly distance 29.0 km vs 12.9 km (x2.25); day types match on 2/7 days |
| gpt-oss-20b-MXFP4-Q8--high | seasons/33.3 | valid | weekly distance 16.5 km vs 7.4 km (x2.23) |
| claude-haiku-5-5--high | seasons/22.2 | valid | weekly distance 0.0 km vs 30.6 km (x0.00); day types match on 3/7 days |
| claude-haiku-5-5--high | seasons/33.2 | valid | weekly distance 0.0 km vs 7.4 km (x0.00) |
| claude-haiku-5-5--high | seasons/33.3 | valid | weekly distance 0.0 km vs 7.4 km (x0.00) |
| claude-opus-4-7--high | seasons/33.3 | valid | weekly distance 0.0 km vs 7.4 km (x0.00) |
| claude-opus-5-5--xhigh | seasons/33.1 | valid | weekly distance 0.0 km vs 7.4 km (x0.00) |
| claude-opus-5-5--xhigh | seasons/33.2 | valid | weekly distance 0.0 km vs 7.4 km (x0.00) |
| claude-opus-5-5--xhigh | seasons/33.3 | valid | weekly distance 0.0 km vs 7.4 km (x0.00) |
| claude-sonnet-5-5--xhigh | seasons/33.1 | valid | weekly distance 0.0 km vs 7.4 km (x0.00) |
| claude-sonnet-5-5--xhigh | seasons/33.2 | valid | weekly distance 0.0 km vs 7.4 km (x0.00) |
| claude-sonnet-5-5--xhigh | seasons/33.3 | valid | weekly distance 0.0 km vs 7.4 km (x0.00) |
| gpt-oss-20b-MXFP4-Q8--high | seasons/22.1 | valid | weekly distance 57.9 km vs 30.6 km (x1.89); long run x1.75; quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/22.3 | valid | weekly distance 57.9 km vs 30.6 km (x1.89); long run x1.75; quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/22.2 | valid | weekly distance 54.7 km vs 30.6 km (x1.79); long run x1.69; quality session the baseline does not plan |
| claude-opus-4-7--high | seasons/31.2 | valid | weekly distance 3.2 km vs 12.9 km (x0.25) |
| gpt-oss-20b-MXFP4-Q8--high | seasons/31.2 | valid | weekly distance 22.5 km vs 12.9 km (x1.75); day types match on 2/7 days |
| claude-opus-5-5--xhigh | seasons/22.1 | valid | weekly distance 9.7 km vs 30.6 km (x0.32) |
| claude-opus-5-5--xhigh | seasons/22.3 | valid | weekly distance 11.3 km vs 30.6 km (x0.37) |
| gpt-oss-20b-MXFP4-Q8--high | seasons/30.2 | valid | weekly distance 24.1 km vs 64.7 km (x0.37) |
| claude-haiku-5-5--high | seasons/31.2 | valid | weekly distance 19.3 km vs 12.9 km (x1.50) |
| claude-haiku-5-5--high | seasons/31.3 | valid | weekly distance 19.3 km vs 12.9 km (x1.50) |
| claude-opus-5-5--xhigh | seasons/22.2 | valid | weekly distance 16.1 km vs 30.6 km (x0.53) |
| claude-sonnet-5-5--xhigh | seasons/22.1 | valid | weekly distance 16.1 km vs 30.6 km (x0.53) |
| gpt-oss-20b-MXFP4-Q8--high | seasons/32.1 | valid | weekly distance 19.3 km vs 35.4 km (x0.55); day types match on 3/7 days |
| gpt-oss-20b-MXFP4-Q8--high | seasons/32.3 | valid | weekly distance 19.3 km vs 35.4 km (x0.55); day types match on 3/7 days |
| gpt-oss-20b-MXFP4-Q8--high | seasons/33.2 | valid | weekly distance 10.5 km vs 7.4 km (x1.42); quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/24.3 | valid | weekly distance 32.2 km vs 53.1 km (x0.61); day types match on 0/7 days; 1 of 7 days not filed (left out of the ratios) |
| claude-opus-4-7--high | seasons/31.1 | valid | weekly distance 8.0 km vs 12.9 km (x0.63) |
| claude-opus-4-7--high | seasons/31.3 | valid | weekly distance 8.0 km vs 12.9 km (x0.63) |
| claude-opus-5-5--xhigh | seasons/31.2 | valid | weekly distance 8.0 km vs 12.9 km (x0.63) |
| claude-opus-5-5--xhigh | seasons/31.3 | valid | weekly distance 8.0 km vs 12.9 km (x0.63) |
| claude-sonnet-5-5--xhigh | seasons/22.2 | valid | weekly distance 19.3 km vs 30.6 km (x0.63) |
| claude-sonnet-5-5--xhigh | seasons/22.3 | valid | weekly distance 19.3 km vs 30.6 km (x0.63); long run x0.75 |
| claude-haiku-5-5--high | seasons/32.3 | valid | weekly distance 22.5 km vs 35.4 km (x0.64) |
| claude-opus-5-5--xhigh | snapshot/06.1 | valid | weekly distance 30.6 km vs 46.7 km (x0.66) |
| claude-sonnet-5-5--xhigh | snapshot/06.2 | valid | weekly distance 32.2 km vs 46.7 km (x0.69) |
| claude-haiku-5-5--high | snapshot/06.1 | valid | weekly distance 33.8 km vs 46.7 km (x0.72) |
| claude-opus-4-7--high | snapshot/06.2 | valid | weekly distance 33.8 km vs 46.7 km (x0.72) |
| claude-haiku-5-5--high | seasons/32.1 | valid | weekly distance 25.7 km vs 35.4 km (x0.73) |
| claude-haiku-5-5--high | seasons/31.1 | valid | day types match on 2/7 days |
| claude-haiku-5-5--high | seasons/22.1 | valid | long run x0.75 |
| gpt-oss-20b-MXFP4-Q8--high | seasons/27.3 | valid | 0 answers vs 1 |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/06.1 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/26.1 | valid | long run x0.75 |
| claude-opus-4-7--high | seasons/33.1 | valid | day types match on 3/7 days |
| gpt-oss-20b-MXFP4-Q8--high | seasons/30.1 | valid | day types match on 3/7 days; no quality session where the baseline plans one |
| claude-haiku-5-5--high | seasons/24.1 | valid | 0 answers vs 1 |
| gpt-oss-20b-MXFP4-Q8--high | seasons/30.3 | valid | no quality session where the baseline plans one |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/06.3 | valid | quality session the baseline does not plan |
| claude-opus-4-7--high | seasons/24.2 | valid | no quality session where the baseline plans one |
| claude-opus-4-7--high | seasons/30.2 | valid | no quality session where the baseline plans one |
| claude-haiku-5-5--high | seasons/33.1 | valid | quality session the baseline does not plan |
| claude-haiku-5-5--high | seasons/37.3 | valid | quality session the baseline does not plan |
| claude-haiku-5-5--high | seasons/40.2 | valid | quality session the baseline does not plan |
| claude-haiku-5-5--high | seasons/40.3 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/35.2 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/35.3 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/37.1 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/37.2 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/37.3 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/40.1 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/40.2 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/40.3 | valid | quality session the baseline does not plan |

## 7. Per-input difficulty

| Input | Operation | Source | claude-opus-4-7--xhigh | claude-haiku-5-5--high | claude-opus-4-7--high | claude-opus-5-5--xhigh | claude-sonnet-5-5--xhigh | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|---|---|---|---|---|---|
| seasons/13 | weekly_reply | 3-return-w1.json | first try | first try | first try | first try | first try | first try |
| seasons/22 | weekly_reply | 4-marathon-w04.json | first try | after retry | first try | first try | first try | first try |
| seasons/24 | weekly_reply | 4-marathon-w06.json | first try | after retry | first try | first try | first try | first try |
| seasons/26 | weekly_reply | 4-marathon-w08.json | first try | first try | first try | first try | after retry | after retry |
| seasons/27 | weekly_reply | 4-marathon-w09.json | first try | failed (max_tokens) | first try | first try | first try | first try |
| seasons/28 | weekly_reply | 4-marathon-w10.json | first try | first try | first try | first try | after retry | after retry |
| seasons/30 | weekly_reply | 4-marathon-w12.json | first try | first try | first try | first try | first try | first try |
| seasons/31 | weekly_reply | 4-marathon-w13.json | failed (schema refusal) | first try | first try | first try | first try | first try |
| seasons/32 | weekly_reply | 4-marathon-w14.json | first try | after retry | first try | first try | first try | first try |
| seasons/33 | weekly_reply | 5-beginner-w1.json | first try | first try | first try | first try | first try | first try |
| seasons/35 | weekly_reply | 5-beginner-w3.json | first try | after retry | first try | first try | first try | first try |
| seasons/37 | weekly_reply | 5-beginner-w5.json | first try | first try | first try | first try | first try | first try |
| seasons/40 | weekly_reply | 5-beginner-w8.json | first try | first try | first try | first try | first try | first try |
| snapshot/06 | weekly_reply | snapshot call at 2026-09-13 20:00:46.851441+00 | first try | first try | first try | first try | first try | first try |

Inputs failing in at least half the self-hosted models that ran them: none.

## 8. Cost and speed

Per reply: time to first token (attempt 1) and total (retry included). Per attempt: tokens and thinking characters. Cells are median / p90 / worst.

| Configuration | Operation | Replies | First token | Total | Input tokens | Output tokens | Thinking chars | Thinking chars refused vs accepted (median) | r(thinking, refused) | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | all | 42 | 4.3 s / 5.3 s / 8.0 s | 51.2 s / 67.1 s / 86.7 s | 22673 / 24389 / 26629 | 2826 / 4476 / 5455 | 1359 / 3014 / 4505 | 632 vs 1395 | -0.24 | $7.25 |
|  | weekly_reply | 42 | 4.3 s / 5.3 s / 8.0 s | 51.2 s / 67.1 s / 86.7 s | 22673 / 24389 / 26629 | 2826 / 4476 / 5455 | 1359 / 3014 / 4505 | 632 vs 1395 | -0.24 | $7.25 |
| claude-haiku-5-5--high | all | 42 | 1.6 s / 3.5 s / 7.2 s | 64.2 s / 84.5 s / 182.3 s | 22281 / 24406 / 36124 | 13598 / 18851 / 20000 | 11222 / 16015 / 18005 | 11531 vs 10797 | 0.22 | $0.39 |
|  | weekly_reply | 42 | 1.6 s / 3.5 s / 7.2 s | 64.2 s / 84.5 s / 182.3 s | 22281 / 24406 / 36124 | 13598 / 18851 / 20000 | 11222 / 16015 / 18005 | 11531 vs 10797 | 0.22 | $0.39 |
| claude-opus-4-7--high | all | 42 | 4.3 s / 5.6 s / 6.1 s | 39.8 s / 51.6 s / 67.5 s | 22518 / 24389 / 24406 | 2176 / 3070 / 4403 | 811 / 1380 / 3290 | – vs 811 | – | $6.28 |
|  | weekly_reply | 42 | 4.3 s / 5.6 s / 6.1 s | 39.8 s / 51.6 s / 67.5 s | 22518 / 24389 / 24406 | 2176 / 3070 / 4403 | 811 / 1380 / 3290 | – vs 811 | – | $6.28 |
| claude-opus-5-5--xhigh | all | 42 | 3.5 s / 4.5 s / 7.6 s | 112.1 s / 146.6 s / 174.1 s | 22126 / 23997 / 24406 | 11396 / 14924 / 17484 | 10107 / 13354 / 16028 | – vs 10107 | – | $12.52 |
|  | weekly_reply | 42 | 3.5 s / 4.5 s / 7.6 s | 112.1 s / 146.6 s / 174.1 s | 22126 / 23997 / 24406 | 11396 / 14924 / 17484 | 10107 / 13354 / 16028 | – vs 10107 | – | $12.52 |
| claude-sonnet-5-5--xhigh | all | 42 | 3.4 s / 4.9 s / 8.0 s | 96.2 s / 144.9 s / 283.5 s | 22281 / 23997 / 24406 | 11990 / 18029 / 20000 | 10516 / 16266 / 18288 | 18277 vs 10379 | 0.42 | $6.95 |
|  | weekly_reply | 42 | 3.4 s / 4.9 s / 8.0 s | 96.2 s / 144.9 s / 283.5 s | 22281 / 23997 / 24406 | 11990 / 18029 / 20000 | 10516 / 16266 / 18288 | 18277 vs 10379 | 0.42 | $6.95 |
| gpt-oss-20b-MXFP4-Q8--high | all | 42 | 1.0 s / 21.2 s / 29.0 s | 29.4 s / 50.3 s / 75.8 s | 15908 / 17257 / 17546 | 1503 / 2003 / 2718 | 3716 / 5399 / 8738 | 3649 vs 3716 | -0.02 | – |
|  | weekly_reply | 42 | 1.0 s / 21.2 s / 29.0 s | 29.4 s / 50.3 s / 75.8 s | 15908 / 17257 / 17546 | 1503 / 2003 / 2718 | 3716 / 5399 / 8738 | 3649 vs 3716 | -0.02 | – |

measures.json per root (cost as the replay priced it; a reply count below the files now present means it is stale):

| Configuration | Root | measures.json replies | Files now | Cost (measures.json) |
|---|---|---|---|---|
| claude-opus-4-7--xhigh | seasons | 39 | 39 | $6.66 |
| claude-opus-4-7--xhigh | snapshot | 3 | 3 | $0.59 |
| claude-haiku-5-5--high | seasons | 39 | 39 | $0.37 |
| claude-haiku-5-5--high | snapshot | 3 | 3 | $0.58 |
| claude-opus-4-7--high | seasons | 39 | 39 | $5.69 |
| claude-opus-4-7--high | snapshot | 3 | 3 | $0.60 |
| claude-opus-5-5--xhigh | seasons | 39 | 39 | $12.03 |
| claude-opus-5-5--xhigh | snapshot | 3 | 3 | $0.61 |
| claude-sonnet-5-5--xhigh | seasons | 39 | 39 | $6.70 |
| claude-sonnet-5-5--xhigh | snapshot | 3 | 3 | $0.61 |
| gpt-oss-20b-MXFP4-Q8--high | seasons | 39 | 39 | – |
| gpt-oss-20b-MXFP4-Q8--high | snapshot | 3 | 3 | – |

Thinking characters are counted from the thinking blocks in each attempt's saved response (oMLX and vLLM report no thinking tokens). r is the point-biserial correlation between an attempt's thinking length and being refused.

## 9. Coaching

Judge `anthropic--claude-opus-5-5--high` (claude-opus-5-5, effort high). Calibration against the coach over 14 cases: pick agreement 32%, unsafe recall 80%, unsafe precision 57%, rating mean absolute difference 0.98 (within one point 83%); meets the bar (unsafe recall at least 60%, rating MAD at most 1.17).

Per configuration, over every reply the judge scored: the mean rating (1 to 5) over all repeats, each repeat's mean, and per input the highest rating minus the lowest over its repeats (median / p90 / worst). Unsafe: replies the judge flagged. No pick rate: the judge's calibration leaves picks out, as its ratings are too flat to rank replies; picks come from the coach's form answers only. Coach: the drafts he rated on the form, the judge's rating of the same drafts, and the judge minus the coach.

| Configuration | Replies scored | Judge failed | Mean rating | Repeat means | Range over repeats, per input | Unsafe | Unsafe share | Coach-rated drafts | Coach mean | Judge mean, same drafts | Judge - coach | Unsafe, coach / judge |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 42 | 0 | 3.31 | r1 3.36, r2 3.29, r3 3.29 | 0.50 / 1 / 1 | 10 | 24% | 6 | 3.33 | 3.67 | +0.33 | 0 / 0 of 7 |
| claude-haiku-5-5--high | 42 | 0 | 3.38 | r1 3.64, r2 3.21, r3 3.29 | 1 / 3 / 3 | 9 | 21% | 7 | 3.00 | 3.57 | +0.57 | 1 / 1 of 7 |
| claude-opus-4-7--high | 42 | 0 | 3.40 | r1 3.43, r2 3.43, r3 3.36 | 1 / 2 / 2 | 9 | 21% | 7 | 3.29 | 3.71 | +0.43 | 0 / 0 of 7 |
| claude-opus-5-5--xhigh | 42 | 0 | 3.71 | r1 3.79, r2 3.64, r3 3.71 | 0 / 1 / 1 | 6 | 14% | 7 | 3.29 | 3.57 | +0.29 | 1 / 2 of 7 |
| claude-sonnet-5-5--xhigh | 42 | 0 | 3.79 | r1 3.86, r2 3.79, r3 3.71 | 0 / 1 / 1 | 4 | 10% | 7 | 2.43 | 4.00 | +1.57 | 1 / 0 of 7 |
| gpt-oss-20b-MXFP4-Q8--high | 42 | 0 | 1.83 | r1 1.86, r2 2.00, r3 1.64 | 1 / 2 / 2 | 24 | 57% | 7 | 2.71 | 1.86 | -0.86 | 2 / 4 of 7 |

### Coaching per input

Each configuration's mean rating over its repeats on the input, and its unsafe replies.

| Input | claude-opus-4-7--xhigh | claude-haiku-5-5--high | claude-opus-4-7--high | claude-opus-5-5--xhigh | claude-sonnet-5-5--xhigh | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|---|---|---|---|
| seasons/13 | 3.67 | 4.00 | 3.33, 1 unsafe | 4.00 | 4.00 | 2.67 |
| seasons/22 | 4.00 | 4.00 | 4.00 | 4.33 | 4.00 | 1.00, 3 unsafe |
| seasons/24 | 2.00, 3 unsafe | 2.00, 3 unsafe | 2.33, 2 unsafe | 2.00, 3 unsafe | 2.67, 1 unsafe | 1.00, 3 unsafe |
| seasons/26 | 3.33 | 3.67 | 4.00 | 4.00 | 4.00 | 2.00, 2 unsafe |
| seasons/27 | 2.33, 2 unsafe | 2.00, 2 unsafe | 3.33, 1 unsafe | 4.00 | 3.67 | 2.67 |
| seasons/28 | 4.00 | 2.67 | 3.67 | 3.67 | 4.00 | 2.33, 1 unsafe |
| seasons/30 | 4.00 | 4.67 | 4.00 | 4.33 | 5.00 | 3.33 |
| seasons/31 | 1.67, 3 unsafe | 1.67, 3 unsafe | 2.00, 3 unsafe | 2.00, 3 unsafe | 2.00, 3 unsafe | 1.00, 3 unsafe |
| seasons/32 | 3.67 | 4.00 | 3.67 | 3.67 | 4.00 | 2.33 |
| seasons/33 | 4.00 | 4.00 | 4.00 | 4.00 | 4.00 | 1.67, 3 unsafe |
| seasons/35 | 2.33, 2 unsafe | 4.00 | 2.67, 2 unsafe | 4.00 | 4.00 | 1.00, 3 unsafe |
| seasons/37 | 4.00 | 3.67 | 3.33 | 4.00 | 3.67 | 1.67, 1 unsafe |
| seasons/40 | 3.33 | 3.33, 1 unsafe | 3.33 | 4.00 | 4.00 | 1.00, 3 unsafe |
| snapshot/06 | 4.00 | 3.67 | 4.00 | 4.00 | 4.00 | 2.00, 2 unsafe |
