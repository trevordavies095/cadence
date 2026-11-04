# Replay benchmark analysis

Generated 2026-11-04T13:16:25.499Z from `.scratch/benchmark-coaching/rules-retry/seasons`, `.scratch/benchmark-coaching/rules-retry/snapshot`. Baseline `anthropic--claude-opus-4-7--xhigh`. Rerun from `api/`: `npm run replay:analyse -- --roots .scratch/benchmark-coaching/rules-retry/seasons,.scratch/benchmark-coaching/rules-retry/snapshot --out .scratch/benchmark-coaching/rules-retry/analysis --judge .scratch/benchmark-coaching/judge-retry/baseline-scores/anthropic--claude-opus-5-5--high --answer-key api/tests/fixtures/coaching-answer-key.json`.

Rows still running are read as they stand: a missing reply is missing, not failed.

## What to change in the harness

Ranked from the numbers below. 0 failed self-hosted replies had a refused attempt the repairs could work on; with every candidate repair, 0 pass the real validators (src/llm/schema.ts).

1. **Plan volume:** 15 weekly plans differ from the baseline's distance by more than 25% (gpt-oss-20b-MXFP4-Q8--high 15); worst gpt-oss-20b-MXFP4-Q8--high seasons/31 x3.70, gpt-oss-20b-MXFP4-Q8--high seasons/31 x3.30, gpt-oss-20b-MXFP4-Q8--high seasons/31 x3.00.
   Read these plans beside the baseline's; a ratio far from 1 on a rescued plan can also be a unit guessed wrong by mapRunFieldAliases.
2. **Coaching (judge `anthropic--claude-opus-5-5--high`):** against the control claude-opus-4-7--xhigh (mean 3.50), gpt-oss-20b-MXFP4-Q8--high is 1.64 below, the largest gap. Most unsafe replies on one input: seasons/24, 4 of 4.
   Read that input's unsafe replies and the cheaper configuration's lowest-rated ones first; they are what the harness tweaks (coaching-quality ticket 11) aim at. See section 9.
3. **No tool call:** 1 attempts came back with stop_reason tool_use but no submit_* block (0 replies failed that way); stray JSON found for 0.
   The server dropped the call (thinking only); not fixable from the stream, so a retry or tool_choice {type: "tool"} is the lever.
4. **Retry prompt:** of 1 retried replies, attempt 2 fixed 1, repeated the same path and rule in 0, and failed on a new error in 0. Per model: gpt-oss-20b-MXFP4-Q8--high 1/0/0 (fixed/same/new).
   Since plan-as-text ticket 08 the retry sends the reply back with the validator's message as an error tool result (a plain "call the tool" turn when no tool was called, the request unchanged when the reply was cut off); see the second requests by kind in section 3. On runs before that, it re-sent the identical request.

## 1. Outcomes

Structured days (of seven): the days Cadence filed from the plan box, per valid weekly read, as the mean of seven and the share of all stored days. A run on the old nested form files every day by construction.

| Configuration | Operation | Replies | First try | After retry | Failed | Structured days (of seven) | schema refusal | http/transport/timeout | no tool call | max_tokens | model refusal |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | all | 14 | 14 | 0 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
|  | weekly_reply | 14 | 14 | 0 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | all | 42 | 41 | 1 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |
|  | weekly_reply | 42 | 41 | 1 | 0 | 7.0 (100%) | 0 | 0 | 0 | 0 | 0 |

### Plan lines

Per configuration, over valid replies: the weekly read's plan box (seven days) and mid-week replies' changes lines. First parse: dates that failed when the reply that counted was parsed, before the plan-lines retry; fixed: dates that retry filed. Bare numbers: a number with no unit. Dropped: lines for a date outside the plan week; ignored: lines with no day.

| Configuration | Form | Box | Replies | Days filed | Unparsed days | Replies fully filed | Failed on first parse | Plan-lines retries | Days fixed by the retry | Bare numbers | Dropped lines | Ignored lines |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | plan lines | plan (weekly) | 14 | 98 of 98 (100%) | 0 | 14 | 0 | 0 | 0 of 0 | 0 | 0 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | plan lines | plan (weekly) | 42 | 293 of 294 (100%) | 1 | 41 | 8 | 3 | 7 of 8 | 0 | 7 | 0 |

### Plan-line failures by reason

The parser's fixed reasons (src/prescribed/planLines.ts), over valid replies. A dropped line is one for a date outside the plan week.

| Configuration | Box | Reason | Failed on first parse | Fixed by the retry | Still unparsed | Lines dropped |
|---|---|---|---|---|---|---|
| gpt-oss-20b-MXFP4-Q8--high | plan | no distance or duration | 1 | 0 | 1 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | plan | no line | 7 | 7 | 0 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | plan | outside the plan week | 0 | 0 | 0 | 7 |

### Plan rules tripped

The plan check (src/prescribed/planCheck.ts, issue #58) run on each valid weekly read's plan against its packet, the same check the app runs on Sunday. Checked: weekly reads with a plan and a packet. A rule's column counts the replies whose plan tripped it; skipped counts the replies whose packet lacked the text the rule needs, so a low count is not a pass when the skipped count is high.

| Configuration | Replies checked | volume jump | long-run jump | quality with pain | return from injury | Replies with any rule | volume jump skipped | long-run jump skipped | quality with pain skipped | return from injury skipped | Sent back for a rule |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 14 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| gpt-oss-20b-MXFP4-Q8--high | 42 | 9 | 8 | 0 | 1 | 12 | 6 | 0 | 0 | 0 | 19 |

## 2. Failure taxonomy

Every refused attempt's validator error, indices as [n]. First = attempt 1, retry = attempt 2.

### Across self-hosted models

| Path | Rule | Kind | First | Retry |
|---|---|---|---|---|
| (response) | Anthropic response missing <tool> tool_use block | no tool call | 1 | 0 |

### By path and model

| Path | claude-opus-4-7--xhigh | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|
| (response) | 0 | 1 |

### gpt-oss-20b-MXFP4-Q8--high

| Path | Rule | First | Retry |
|---|---|---|---|
| (response) | Anthropic response missing <tool> tool_use block | 1 | 0 |

## 3. Retry effectiveness

Replies whose attempt 1 was refused and that were asked once more, every operation. Since plan-as-text ticket 08 the second request carries the validator's message as an error tool result (`error_result`), a plain call-the-tool turn when no tool was called (`no_tool_call`), or the first request again when the reply was cut off (`resend`); runs before that re-sent the identical request. A reply accepted with plan lines that did not parse is asked to fix those dates (`fix_lines`); that retry is no refusal and is counted under Plan lines in section 1.

| Configuration | Retried | Fixed | Same path and rule | New error | Same kind of error | Attempt 2 failed outside the validator |
|---|---|---|---|---|---|---|
| gpt-oss-20b-MXFP4-Q8--high | 1 | 1 (100%) | 0 | 0 | 0 | 0 |

Every second request, by how it was built ("not recorded": dry runs and runs before ticket 08):

| Configuration | Second requests |
|---|---|
| gpt-oss-20b-MXFP4-Q8--high | fix_rules 19, fix_lines 3, no_tool_call 1 |

## 4. Rescue simulation

Skipped for runs on the plan-as-text form, where the parser is the repair: `seasons/anthropic--claude-opus-4-7--xhigh`, `seasons/self_hosted--gpt-oss-20b-MXFP4-Q8--high`, `snapshot/anthropic--claude-opus-4-7--xhigh`, `snapshot/self_hosted--gpt-oss-20b-MXFP4-Q8--high`. The figures below cover the other runs only.

Tool inputs read back from 1 refused attempts (message 1); a tool input found in 0, unparsable tool JSON in 0, stray reply JSON in 0. Re-running the validator on the extracted input reproduces the recorded error for 0 of 0 checked.

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

| Field | Value | Maps to | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|---|

### Every shape problem in refused attempts

The validator stops at the first error; these are all the problems each refused tool input has (attempts with each).

| Problem | gpt-oss-20b-MXFP4-Q8--high |
|---|---|

### Keys outside the tool schema (refused attempts, attempts using each)

| Key | gpt-oss-20b-MXFP4-Q8--high |
|---|---|

## 5. Quality signals

Valid replies as the run saved them; rescued replies (section 4) apart, with the validator's own soft repairs on the repaired input.

| Configuration | Replies | n | Soft repairs (replies: by field) | Caps hit | Goal-check failures | Banned vocabulary | Plan sanity flagged | Volume ratio med / p90 / worst |
|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | valid | 14 | 0:  |  | no goal line 1 | mid-week 1 | 1: volume 1 | 1.02 / 1.19 / 1.19 |
| gpt-oss-20b-MXFP4-Q8--high | valid | 42 | 4: plan 15, flags[].detail 1 | flag detail 1 | no goal line 3 | prescribed 4, recap 2, week label 2, subjective 1 | 18: volume 18 | 1.05 / 9.44 / 20.47 |

The baseline fails "no goal line" on 1 replies too: those inputs carry no goal (the demo snapshot's prompt opens "Athlete goal: not set."), so that count is the input's, not the model's.

## 6. Plans against the baseline

Weekly replies valid on both sides, same input, baseline repeat 1. Ratios are candidate over baseline, over the days both sides filed; an unparsed day counts as no plan and is left out of the ratios. Cells are median / p90 / worst.

| Configuration | Replies | Pairs | Unparsed days (cand / base) | Weekly distance ratio | Long-run ratio | Run days (cand - base) | Day-type match (median) | Same rest days | Quality session | Flags (median) | Answers (median) | Headline chars | Analysis chars |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gpt-oss-20b-MXFP4-Q8--high | valid | 42 | 1 / 0 (in 1 pairs) | 1.00 / 3.00 / 3.70 | 1.11 / 1.50 / 1.62 | 0 / 0 / 2 | 0.86 | 26/42 | 14 both, +7, -1 | 5 vs 5 | 1 vs 1 (fewer in 4) | 85 vs 175 | 771 vs 1163 |

### Big divergences

Weekly distance off by more than 25%, long run off by more than 25%, day types matching on fewer than half the days, a quality session on one side only, or fewer answers.

| Configuration | Input | Source | Divergence |
|---|---|---|---|
| gpt-oss-20b-MXFP4-Q8--high | seasons/31.3 | valid | weekly distance 29.8 km vs 8.0 km (x3.70); day types match on 3/7 days |
| gpt-oss-20b-MXFP4-Q8--high | seasons/31.1 | valid | weekly distance 26.6 km vs 8.0 km (x3.30); day types match on 3/7 days |
| gpt-oss-20b-MXFP4-Q8--high | seasons/31.2 | valid | weekly distance 24.1 km vs 8.0 km (x3.00); day types match on 2/7 days |
| gpt-oss-20b-MXFP4-Q8--high | seasons/22.3 | valid | weekly distance 56.3 km vs 30.6 km (x1.84); long run x1.50 |
| gpt-oss-20b-MXFP4-Q8--high | seasons/22.2 | valid | weekly distance 53.1 km vs 30.6 km (x1.74); long run x1.62 |
| gpt-oss-20b-MXFP4-Q8--high | seasons/30.1 | valid | weekly distance 19.3 km vs 66.3 km (x0.29); no quality session where the baseline plans one |
| gpt-oss-20b-MXFP4-Q8--high | seasons/22.1 | valid | weekly distance 49.9 km vs 30.6 km (x1.63); long run x1.37 |
| gpt-oss-20b-MXFP4-Q8--high | seasons/30.2 | valid | weekly distance 35.4 km vs 66.3 km (x0.53) |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/06.3 | valid | weekly distance 51.5 km vs 35.4 km (x1.45) |
| gpt-oss-20b-MXFP4-Q8--high | seasons/28.3 | valid | weekly distance 40.2 km vs 70.8 km (x0.57); long run x0.55; 0 answers vs 1 |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/06.1 | valid | weekly distance 49.9 km vs 35.4 km (x1.41) |
| gpt-oss-20b-MXFP4-Q8--high | seasons/28.1 | valid | weekly distance 41.8 km vs 70.8 km (x0.59); long run x0.60; 0 answers vs 1 |
| gpt-oss-20b-MXFP4-Q8--high | seasons/24.3 | valid | weekly distance 38.6 km vs 56.3 km (x0.69); day types match on 1/7 days |
| gpt-oss-20b-MXFP4-Q8--high | snapshot/06.2 | valid | weekly distance 45.1 km vs 35.4 km (x1.27) |
| gpt-oss-20b-MXFP4-Q8--high | seasons/30.3 | valid | weekly distance 30.6 km vs 66.3 km (x1.27); 1 of 7 days not filed (left out of the ratios) |
| gpt-oss-20b-MXFP4-Q8--high | seasons/28.2 | valid | long run x0.75 |
| gpt-oss-20b-MXFP4-Q8--high | seasons/26.2 | valid | 0 answers vs 1 |
| gpt-oss-20b-MXFP4-Q8--high | seasons/13.2 | valid | day types match on 3/7 days |
| gpt-oss-20b-MXFP4-Q8--high | seasons/33.1 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/33.2 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/35.2 | valid | day types match on 3/7 days; quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/37.2 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/40.1 | valid | quality session the baseline does not plan |
| gpt-oss-20b-MXFP4-Q8--high | seasons/40.2 | valid | quality session the baseline does not plan; 0 answers vs 1 |
| gpt-oss-20b-MXFP4-Q8--high | seasons/40.3 | valid | quality session the baseline does not plan |

## 7. Per-input difficulty

| Input | Operation | Source | claude-opus-4-7--xhigh | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|---|---|
| seasons/13 | weekly_reply | 3-return-w1.json | first try | after retry |
| seasons/22 | weekly_reply | 4-marathon-w04.json | first try | first try |
| seasons/24 | weekly_reply | 4-marathon-w06.json | first try | first try |
| seasons/26 | weekly_reply | 4-marathon-w08.json | first try | first try |
| seasons/27 | weekly_reply | 4-marathon-w09.json | first try | first try |
| seasons/28 | weekly_reply | 4-marathon-w10.json | first try | first try |
| seasons/30 | weekly_reply | 4-marathon-w12.json | first try | first try |
| seasons/31 | weekly_reply | 4-marathon-w13.json | first try | first try |
| seasons/32 | weekly_reply | 4-marathon-w14.json | first try | first try |
| seasons/33 | weekly_reply | 5-beginner-w1.json | first try | first try |
| seasons/35 | weekly_reply | 5-beginner-w3.json | first try | first try |
| seasons/37 | weekly_reply | 5-beginner-w5.json | first try | first try |
| seasons/40 | weekly_reply | 5-beginner-w8.json | first try | first try |
| snapshot/06 | weekly_reply | snapshot call at 2026-09-13 20:00:46.851441+00 | first try | first try |

Inputs failing in at least half the self-hosted models that ran them: none.

## 8. Cost and speed

Per reply: time to first token (attempt 1) and total (retry included). Per attempt: tokens and thinking characters. Cells are median / p90 / worst.

| Configuration | Operation | Replies | First token | Total | Input tokens | Output tokens | Thinking chars | Thinking chars refused vs accepted (median) | r(thinking, refused) | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | all | 14 | 4.3 s / 5.7 s / 7.5 s | 48.4 s / 66.1 s / 70.5 s | 22518 / 24389 / 24406 | 2873 / 3786 / 4018 | 1539 / 2553 / 2658 | – vs 1539 | – | $2.31 |
|  | weekly_reply | 14 | 4.3 s / 5.7 s / 7.5 s | 48.4 s / 66.1 s / 70.5 s | 22518 / 24389 / 24406 | 2873 / 3786 / 4018 | 1539 / 2553 / 2658 | – vs 1539 | – | $2.31 |
| gpt-oss-20b-MXFP4-Q8--high | all | 42 | 1.0 s / 21.3 s / 23.5 s | 42.5 s / 65.7 s / 78.0 s | 13803 / 17264 / 17875 | 1332 / 1989 / 3439 | 3359 / 5445 / 10119 | 3011 vs 3392 | -0.06 | – |
|  | weekly_reply | 42 | 1.0 s / 21.3 s / 23.5 s | 42.5 s / 65.7 s / 78.0 s | 13803 / 17264 / 17875 | 1332 / 1989 / 3439 | 3359 / 5445 / 10119 | 3011 vs 3392 | -0.06 | – |

measures.json per root (cost as the replay priced it; a reply count below the files now present means it is stale):

| Configuration | Root | measures.json replies | Files now | Cost (measures.json) |
|---|---|---|---|---|
| claude-opus-4-7--xhigh | seasons | 13 | 13 | $2.10 |
| claude-opus-4-7--xhigh | snapshot | 1 | 1 | $0.22 |
| gpt-oss-20b-MXFP4-Q8--high | seasons | 39 | 39 | – |
| gpt-oss-20b-MXFP4-Q8--high | snapshot | 3 | 3 | – |

Thinking characters are counted from the thinking blocks in each attempt's saved response (oMLX and vLLM report no thinking tokens). r is the point-biserial correlation between an attempt's thinking length and being refused.

## 9. Coaching

Judge `anthropic--claude-opus-5-5--high` (claude-opus-5-5, effort high). Calibration against the coach over 14 cases: pick agreement 32%, unsafe recall 80%, unsafe precision 57%, rating mean absolute difference 0.98 (within one point 83%); meets the bar (unsafe recall at least 60%, rating MAD at most 1.17).

Per configuration, over every reply the judge scored: the mean rating (1 to 5) over all repeats, each repeat's mean, and per input the highest rating minus the lowest over its repeats (median / p90 / worst). Unsafe: replies the judge flagged. No pick rate: the judge's calibration leaves picks out, as its ratings are too flat to rank replies; picks come from the coach's form answers only. Coach: the drafts he rated on the form, the judge's rating of the same drafts, and the judge minus the coach.

| Configuration | Replies scored | Judge failed | Mean rating | Repeat means | Range over repeats, per input | Unsafe | Unsafe share | Coach-rated drafts | Coach mean | Judge mean, same drafts | Judge - coach | Unsafe, coach / judge |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-4-7--xhigh | 14 | 0 | 3.50 | r1 3.50 | – / – / – | 2 | 14% | 6 | 3.33 | 3.67 | +0.33 | 0 / 0 of 7 |
| gpt-oss-20b-MXFP4-Q8--high | 42 | 0 | 1.86 | r1 1.64, r2 2.00, r3 1.93 | 1 / 2 / 2 | 25 | 60% | 7 | 2.71 | 1.43 | -1.29 | 2 / 6 of 7 |

### Coaching per input

Each configuration's mean rating over its repeats on the input, and its unsafe replies.

| Input | claude-opus-4-7--xhigh | gpt-oss-20b-MXFP4-Q8--high |
|---|---|---|
| seasons/13 | 4.00 | 2.33, 1 unsafe |
| seasons/22 | 4.00 | 1.33, 3 unsafe |
| seasons/24 | 2.00, 1 unsafe | 1.33, 3 unsafe |
| seasons/26 | 3.00 | 2.00, 2 unsafe |
| seasons/27 | 3.00 | 3.33 |
| seasons/28 | 4.00 | 2.00 |
| seasons/30 | 4.00 | 2.67 |
| seasons/31 | 2.00, 1 unsafe | 1.33, 3 unsafe |
| seasons/32 | 4.00 | 3.00 |
| seasons/33 | 4.00 | 1.33, 2 unsafe |
| seasons/35 | 4.00 | 1.00, 3 unsafe |
| seasons/37 | 4.00 | 1.33, 3 unsafe |
| seasons/40 | 3.00 | 1.33, 3 unsafe |
| snapshot/06 | 4.00 | 1.67, 2 unsafe |
