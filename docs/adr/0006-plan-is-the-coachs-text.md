# 0006: The plan is the coach's text, and Cadence derives its structure per day

**Status:** Accepted, 2026-11-02 (#61, with #54; ships in the PR from `feat/model-independence` into `develop`). Supersedes the ask-once-more retry of ADR 0002. Respects ADR 0004 (a retry never switches model, effort, server or key) and ADR 0005 (one adapter, two request shapes).

## Context

Coach Cade's weekly read arrived as one large tool call: the headline, Watching, Your questions, the full read and next week's plan. The plan was nested three deep: seven days, each with a run, each run with a type, a distance in metres and a duration in seconds. One wrong field in one day refused the whole reply, and the athlete got no read and no plan that week.

**The November benchmark (2026-11-01).** Six configurations answered the same 35 coach calls once. Valid as sent: Opus 4.7 35, Qwen3.8-27B at `medium` 35, gpt-oss-120b 27, Gemma 4 full 16, Gemma 4 pruned 14, gpt-oss-20b 14. Every validator error of consequence was in the plan's run objects: a missing run type, the model's own field names, the wrong unit. The About you tool, two text boxes, passed 5 of 5 on every model. The identical-request retry fixed 10 of 73 refused replies and repeated the same error in 49.

**The reshape and strict results (2026-11-02, 20 hard inputs).** Moving the seven-day limit out of the schema left Opus 4.7 at 17 of 20. Sending `strict: true` on every tool then gave 2 valid of the 12 replies that ran, with six running to the 64,000-token output limit. Eleven replies cost $14.14 against $2.98 without strict. oMLX accepted the flag and did not enforce it. ADR 0002 had recorded the same runaway once before.

**The baseline spread (2026-11-02).** Three runs of the 20 inputs on the reverted code gave Opus 19, 18 and 18 valid, so the band later gates are judged against is 18 to 19. The reshape's 17 sits one reply under it, and its failures were the same kinds, so most of that drop was ordinary variance. Opus's own recurring failure was the nested plan's packaging: five of the six failures and retries were "prescribedWeek must be an object", the plan sent as a string of JSON for the bare days with no wrapper. The identical retry repeated it in 4 of the 6 attempts where it occurred. PR #60, merged into `develop` as a stopgap, moves such a plan into place before checking it, for the nested form.

**The athlete's criterion.** On Sunday the athlete wants to know what Coach Cade thought of the week and what to do each day of the next one, in words they can act on. The calendar on Home and the Plan page are how they carry it out, so it is kept as full as possible, but it is not required to have the same structure every week.

## Decision

- **The plan is the coach's text.** The plan box holds seven lines, one per day, written the way a coach writes a week: "Tue 2026-11-10: easy, 5 mi, HR under 150, flat." The same grammar carries a mid-week change, in a `changes` box of zero or more lines.
- **Structure is derived per day, and may be absent.** A Cadence-owned grammar and synonym table derive the date, the day type, and a distance or a duration from each line. The rest of the line is the day's notes. The stored day keeps its shape and gains `line` (the sentence as written) and `parsed`. A day that does not parse keeps its line, and the other six still file.
- **Every form box is a string.** No objects and no lists on the weekly or mid-week form; a box of items holds one item per line. The mid-week form keeps its one boolean. About you is unchanged. Lists of strings were tried first: on gate 12 (2026-11-02) Opus's plan box never failed, but 6 of 20 first attempts broke in a list (tool-call markup in `flags`, items spilled into numbered keys, or a list sent as one string). With no lists, Opus passed 20 of 20 first try. A list still sent is joined and noted as a repair.
- **Tool-call markup in any box refuses the reply.** A weekly or mid-week box holding `<parameter`, `<invoke`, `<function_calls` or an `antml` tag is refused, so leaked call syntax never reaches the athlete as a Watching title, and the retry's error names the box.
- **A bare number is never resolved to a unit.** "easy 5" fails that day with "no distance unit". The prompt and the plan box's description name the athlete's unit.
- **The grammar grows only by decision.** Each addition is recorded in the synonym table's comment or the parser's notes, with its date and reason. Those taken so far, all on 2026-11-02:
  - a race named with no number files its distance (half marathon 21,098 m, marathon 42,195 m), never when the name is an intensity ("marathon pace");
  - the singulars "interval" and "hill" are quality;
  - "walk-run" and "run-walk" are easy runs, not other;
  - a whole week written on one line is split where a new day starts (a date and a colon, after the end of a sentence);
  - an escaped newline (backslash and n) is a line break;
  - two durations joined by a slash, a comma or "and", each naming what it is ("3 min run / 1 min walk"), are a repeat pattern and never the session's length.
- **One retry, on the same target, that says what was wrong.** The retry lives in the adapter, in one function for all five operations, the replay and the smoke script. Two attempts at most, both logged and linked. The second request is one of:
  - `fix_lines`: the plan or change lines had dates that did not parse. The assistant turn goes back as received, then an error tool result listing each failed date and its reason, and "Send the plan box again with these lines fixed. Change nothing else." Only the failed dates are taken from the second reply; a good day is never rewritten.
  - `error_result`: the tool call was refused. The same turns carry the validator's message.
  - `no_tool_call`: no call to the tool. A plain "You did not call the tool. Call it now with your full answer."
  - `resend`: the reply stopped at the output cap, was a model refusal, or had no message. The first request is sent again unchanged, because a cut tool call cannot be answered.
- **An unparsed day is shown as the coach's line, never as a number.** On the Plan page it carries a "Not yet filed" mark; a date with no line reads "Coach Cade gave no plan for this day". On Home it has nothing planned and is never missed.
- **"Add the details".** On the Plan page, an unparsed day offers one more try for that date alone, on the model saved now (ADR 0004 resolves the target per call). It sends a short fresh prompt with the date, its line, its reason and the other six days' lines, not the packet. The read is never regenerated and the other days never change. A failure leaves the day as it was.
- **Caps.** Every coach call, on Anthropic and self-hosted, sends an output cap of 20,000 tokens: twice the highest valid Opus reply in the saved runs (9,264), floored at 16,000. The replay gate estimates a run's cost before it starts and refuses above $5 unless `--allow-cost` is passed.
- **Every contract change passes the gate** on Opus 4.7 and on the weakest usable local model (gpt-oss-20b) before it ships: Opus inside the baseline band with every day structured; gpt-oss-20b at least 19 of 20 valid and at least 90 percent of days structured.

## Evidence: the gates

All on the 20-input regression set, one repeat each, 2026-11-02.

| Run | Opus 4.7 `xhigh` valid (first try) | Opus days structured | Opus cost | gpt-oss-20b valid (first try) | gpt-oss-20b days structured |
|---|---|---|---|---|---|
| Baseline, nested form, 3 runs | 18 to 19 (17 to 18) | not measured | $3.51 to $4.08 | not run | not measured |
| Flat form, lists of strings | 20 (14) | 100% (112 of 112) | $3.84 | 20 (19) | 94.6% (106 of 112) |
| No lists | 20 (20) | 100% (112 of 112) | $3.11 | 20 (19) | 100% (112 of 112) |

On the flat form, gpt-oss-20b's six unfiled days were one week whose days were separated by escaped newlines; the parser now splits on them, and re-parsing that run's saved lines files 111 of 112. Before this work it was valid on 8 of 20 of these inputs after the reshape, and on 14 of 35 in the benchmark.

The final run on all 35 inputs, on the finished code:

- Opus 4.7 `xhigh`: 35 of 35 valid, all on the first try; 196 of 196 days filed; $5.43.
- gpt-oss-20b on oMLX: 35 of 35 valid, 34 on the first try and 1 after the retry; 196 of 196 days filed. In the November benchmark it was 14 of 35.
- Gemma 4 pruned 4-bit on oMLX: 34 of 35 valid, 33 on the first try and 1 after the retry; 189 of 189 days filed. Its one failure was the server ending the stream, not a refused reply. In the November benchmark it was 14 of 35.
- Opus spend across the work: $23.90 ($11.52 for the baseline spread, $3.84 and $3.11 for the two gates, $5.43 for the final run), against a ceiling of about $20. The overrun is the extra gate that measured the removal of the lists.

The H100 rows of the benchmark (gpt-oss-120b, Gemma 4 full, Qwen3.8-27B) were not rerun.

## Consequences

- **A schema edit is a contract change.** Any change to a tool's boxes, their descriptions, the prompt's plan instructions or the grammar passes the gate before it ships. The reshape showed that a change that looks harmless to the schema can still move a model.
- **The calendar can hold a day without numbers.** Home, the Plan page, the plan change card and any future grading treat an unparsed day as having nothing planned, never as missed, and skip it in totals.
- **The stored run type is vestigial.** It is copied from the day type (other for other) so old consumers keep working, and it is never asked of the model.
- **Strict tool use and constrained decoding are not used.** Strict tool use made Opus run away twice (ADR 0002 and above), and oMLX ignored it. A server-side JSON-schema mode is not a foundation either; if a local server is shown to drop tool calls, a markdown reply is the next option.
- **Field-name aliases are never mapped.** Cadence does not learn any model's dialect. The form has no field names inside the plan for a model to get wrong.
- **The synonym table grows only by decision**, never by observing what a model writes. A word a model uses that is not in the table leaves that day unparsed and visible, which is the intended cost.
- **A retry costs at most one more call**, logged as its own row and linked to the first. "Add the details" is one further call, made only when the athlete asks.
- **About you keeps its list.** It passed everywhere and was not changed. Changing it would be a contract change like any other.
