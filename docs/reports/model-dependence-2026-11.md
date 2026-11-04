# Coach Cade depends on one model, November 2026

**Written:** 2026-11-02
**For:** the maintainer and anyone picking up the coaching harness next.
**Builds on:**
- the self-hosted benchmark in [`local-models-2026-11.md`](local-models-2026-11.md);
- ADR 0002, on the reading flow.

## Summary

Coach Cade works reliably on one model only: Claude Opus 4.7 at `xhigh`. The app asks for every coaching reply as one large structured tool call. Opus 4.7 fills that structure correctly almost every time, so the app never had to handle a model that doesn't.

Three rounds of measurement in November 2026 showed how narrow that is:

- **Other capable models coach reasonably, but lose whole replies on format.** A single wrong field name or unit is enough.
- **Opus 4.7 itself is fragile.** Small changes to the schema cost it valid replies.
- **Forcing the format makes things worse.** Anthropic's strict tool use made Opus run away to its output limit.

*Corrected later on 2026-11-02:* the second point overstated the reshape's effect. Three baseline runs put Opus's normal spread at 18 to 19 of 20, so most of the drop it describes was run-to-run variance. Opus's own recurring failure was the nested plan's packaging. See [Since this report](#since-this-report-2026-11-02).

If Opus 4.7 is retired, or an athlete picks any other model, Coach Cade stops producing weekly plans in a large share of weeks. The fix is not one setting. Cadence has to ask for less structure, ask for it in a shape models write naturally, recover from mistakes, and measure every model change before it ships.

## How Coach Cade replies today

Every coach operation ends in exactly one tool call:

| Operation | Tool |
|---|---|
| Weekly read | `submit_weekly_reply` |
| Mid-week chat | `submit_mid_week_chat_reply` |
| About you first draft | `submit_about_you` |
| About you fix | `submit_about_you` |
| About you tidy-up | `submit_about_you` |

The weekly reply carries the most in a single object:

- a headline and a long prose analysis, both for the athlete;
- answers to the athlete's questions;
- "watching" flags and safety callouts;
- proposed settings changes;
- a seven-day plan, with a date, a day type, and a run with its distance in metres, duration in seconds, run type, structure, pace and shoes.

Cadence's validator checks every field. A reply that fails is sent once more with the identical request, and if it fails again the athlete gets no read that week.

The prose is for the athlete. Only the plan, and to a lesser degree the flags and answers, has to be machine-readable. Today both travel in the same structure and fail together.

## What was measured

### 1. The self-hosted benchmark, 2026-11-01

Six configurations each answered the same 35 coach calls once:

| Model | Where it ran | Valid as sent, of 35 |
|---|---|---|
| Claude Opus 4.7 `xhigh` | Anthropic | 35 |
| Qwen3.8-27B, full precision, `medium` | rented H100, vLLM | 35 |
| gpt-oss-120b | rented H100, vLLM | 27 |
| Gemma 4 26B-A4B, full precision | rented H100, vLLM | 16 |
| Gemma 4, 4-bit and pruned | 24 GB MacBook, oMLX | 14 |
| gpt-oss-20b | 24 GB MacBook, oMLX | 14 |

What the failures had in common:

- **They were format failures, not coaching failures.** Models wrote the run in their own dialect: `{"distance": 7, "time": 40}`, `{"distanceKm": 5, "durationMin": 30}`, `{"name": "Easy Run"}`. The packet they had just read shows the week in miles and minutes. The schema asks for metres and seconds, and asks for the day's type twice: once on the day and again on the run.
- **The most common error was a missing `run.type`.** Field aliases such as `distance`, `distanceKm` and `pace` came next.
- **The retry barely helped.** It fixed 10 of 73 refused replies and repeated the same error in 49, because it sends the identical request and never says what was wrong.
- **Most failures are recoverable.** With every candidate repair applied, 62 of the 68 failed replies that could be read back would pass.

### 2. Reshaping the schema, 2026-11-02

To prepare for strict tool use, the seven-day limit on the weekly plan (`minItems` and `maxItems` of 7) was moved out of the schema and into the description. Nothing else in the request changed. On a set of 20 hard inputs, Opus 4.7 dropped to 17 valid.

Every failure was a malformed tool call:

- a missing headline;
- a plan that was not an object;
- tool-call markup such as `<parameter name="days">` inside text fields.

The five inputs involved were replayed on the code from before the reshape, and all five passed first try. A change that looked harmless to the schema was not harmless to the model.

*Corrected later on 2026-11-02:* the replay of five inputs was one run each, and it was not enough. The same 20 inputs were then run three times on the code from before the reshape, and Opus 4.7 scored 19, 18 and 18. The reshape's 17 is one reply under that band, and its failures were the same kinds the baseline runs showed. Most of the drop was ordinary variance, not the reshape. The baseline runs also showed Opus's own recurring failure: five of its six failed or retried replies sent the plan as a string of JSON holding the bare days, with no wrapper.

### 3. Strict tool use, 2026-11-02

Next, every tool was sent with `strict: true`, which makes Anthropic constrain the model's output to the schema.

| Measure, same 20 inputs | Schema reshaped | Plus strict |
|---|---|---|
| Opus 4.7 valid | 17 of 20 | 2 of the 12 that ran |
| Opus 4.7 weekly reads valid | 13 of 16 | 0 of the 8 that ran |
| Opus replies that hit the 64,000-token limit | 0 | 6 |
| Cost of the same 11 inputs | $2.98 | $14.14 |
| gpt-oss-20b on oMLX valid | 8 of 20 | 6 of 20 |

In each runaway, Opus wrote a few thousand characters of tool input, stopped inside a text field, and spent the rest of its 64,000 output tokens without producing parseable input. The retry ran away the same way.

oMLX accepted the strict flag and did not enforce it. gpt-oss-20b made the same mistakes as before.

ADR 0002 had already recorded one strict-mode runaway, during the reading-flow work. This was the second time, at a larger scale.

## Findings

1. **The product works on one model.** Only Opus 4.7 and one large open model passed every call. Every other model failed between a quarter and three fifths of its replies on format, almost all of them weekly plans.
2. **Capable models are not the bottleneck.** The failing models coached reasonably and wrote plausible plans in their own words. They failed on field names, units and repeated facts.
3. **The contract was shaped around one model's habits.** Metres and seconds, the duplicated type, and fields with no description all work only for a model that copies the schema exactly.
4. **Opus 4.7's reliability is narrower than it looks.** Its 35 of 35 depends on the exact schema. Moving one limit into a description cost three replies.
   *Corrected later on 2026-11-02:* the first half holds and the second does not. The 35 of 35 was one draw: on the 20 hard inputs Opus lost 5 of 60 replies over three runs on the old form. The three lost replies sit within that spread. Its recurring failure was the nested plan's packaging, and later, on the flat form, lists of strings.
5. **Enforcement is not the answer on Anthropic.** Strict tool use turned a rare slip into a costly runaway on the model it was meant to protect. On oMLX it did nothing. Constrained decoding varies by server and model, so Cadence cannot build on it.
6. **Recovery is weak.** The retry carries no error, so it rarely fixes anything. Only the weekly read has a retry at all.
7. **Prose and data fail together.** A good read is thrown away because one day in the plan has the wrong field name.
8. **There was no way to measure any of this until now.** The replay harness, the regression set and the gate are new. A model change can now be measured before it ships.

## Problem statement

**Who is affected.** Every athlete:

- **Anthropic users** depend on Opus 4.7 staying available and behaving as it does today. A retirement or a behaviour change in a successor model is an outage with no warning.
- **Self-hosted users** get a coach that fails a large share of weekly plans, on hardware they can actually run.

**The problem.** Coach Cade asks for each reply as one large, strictly shaped tool call. The shape was tuned to a single model's habits. Cadence then rejects the whole reply when any field is off, and asks again without saying what was wrong. As a result, the product's reliability is a property of one model, not of the harness.

**Why it matters now.**
- Models are retired on a schedule Cadence doesn't control.
- The self-hosted provider is built but can't be recommended.
- Every model the benchmark measured, except Opus 4.7 and one model that needs a data-centre GPU, would leave athletes without a plan in many weeks.

**What success looks like.** These are proposed and still to be settled:

- **Capable models pass.** Any capable reasoning model, from at least two families besides Claude, returns a valid weekly read on the regression set at a rate close to Opus 4.7's.
- **Opus 4.7 does not regress.** The cost per reply stays about the same.
- **A model change is a measured decision.** It is a Settings change plus a gate run, never an outage.
- **The athlete sees no difference.** Nothing the athlete sees changes because of how the reply was parsed.

**Constraints.**
- **Stored data stays as it is.** The stored plan, the frontend and the demo snapshot do not change shape.
- **The provider setting decides the model.** Model choice stays per call, from the saved setting (ADR 0004).
- **Repairs never change meaning.** No repair maps one model's dialect, drops content, or alters what the model wrote.
- **No model-specific code paths.**

**Not in scope.**
- Ranking or recommending models in Settings.
- Making small local models coach as well as Opus.
- A second, OpenAI-style adapter.

## Directions to explore

These are options for a design session, not decisions. They are ordered by how much they reduce the chance of failure. What was decided and measured for each is under [Since this report](#since-this-report-2026-11-02).

1. **Ask for less structure.** Only the plan needs to be data, so separate it from the prose. Two options to weigh:
   - **Two steps:** the model writes the read freely, then a small, focused call or tool turns the plan into data.
   - **A plain line format:** the plan is written the way a coach writes it, for example "Tue: easy, 5 mi, HR under 150", and Cadence parses it.

   Either way, a format slip costs the plan at most, never the read. This is the largest change and is not yet in any spec.
2. **Ask in the shape models already write.** Distances go in the athlete's own unit, each fact is asked once, and every field has a description. This is tickets 05 and 06 of the reply-contract work.
3. **Say what was wrong.** A refused reply is sent back with the validator's exact error, once, for every operation. This is tickets 07 and 08.
4. **Repair only what is mechanical.** Drop null optional fields, rebuild a malformed week id, and match day types ignoring case. This is ticket 09.
5. **Gate every change.** Run the regression set on Opus 4.7 and on the weakest usable local model for every schema, prompt or model change. This is built. It needs a preflight for keys and credit, and a spend cap for runaways.

Constrained decoding stays an option only for servers where it is measured to help. It is never the foundation.

## Decisions waiting

All three were decided on 2026-11-02.

- **Revert tickets 03 and 04** (the schema reshape and strict mode) on `feat/model-independence`. Recommended: both are measured to make Opus worse. *Decided: reverted. Request bodies were then byte-identical to the code before the reshape.*
- **Pause tickets 05 to 09** until direction 1 is settled, because it may shrink or split the schema those tickets reshape. *Decided: superseded. Direction 1 replaced them.*
- **Hold a design session** on direction 1 before writing more tickets. *Decided: held. It chose the plain line format, recorded in ADR 0006.*

## Open questions

- Does splitting prose from the plan cost coaching quality? The plan should follow from the read, and a second step might lose that link.
- Is a second call acceptable on slow local hardware? A weekly read already takes 1 to 10 minutes there.
- How close to Opus 4.7 is "close enough" for a local model to be usable?
- Should the mid-week reply and the About you tools change the same way, or only the weekly read?
- What does the next Claude model do on today's schema? It is worth one gate run as soon as one is available.

## Since this report (2026-11-02)

The design session chose direction 1, the plain line format, and folded directions 2 to 4 into it. ADR 0006 records the decision. Every Opus 4.7 run below is the 20-input regression set at `xhigh`, one repeat; gpt-oss-20b ran at `high` on oMLX.

**First, the spread.** Opus 4.7 ran three times on the code from before the reshape: 19, 18 and 18 valid of 20, first try 18, 17 and 17, at $3.51 to $4.08 a run. The band later gates are judged against is 18 to 19. This corrects section 2 and finding 4 above.

1. **Ask for less structure.** *Taken, as the plain line format.* The plan is one box of seven lines, and Cadence parses each line for its date, day type, and distance or duration. A day it cannot parse keeps the coach's sentence and is marked "Not yet filed"; the other days still file. The first gate on the new form: gpt-oss-20b 20 of 20 valid with 94.6 percent of days filed (106 of 112); Opus 20 of 20 with every day filed. The plan box never failed on Opus.
2. **Ask in the shape models already write.** *Taken, further than planned.* Every box on the weekly and mid-week forms is plain text, distances are written in the athlete's unit, and every box has a description. Lists of strings were tried first and were where Opus slipped: 14 of 20 first try, all six refusals in a list, with tool-call markup in `flags` or items spilled into numbered keys. With no lists at all, Opus passed 20 of 20 on the first try for the first time on this harness, at $3.11, and gpt-oss-20b filed every day (112 of 112). A box holding tool-call markup now refuses the reply.
3. **Say what was wrong.** *Taken.* The one retry lives in the adapter for every operation. For plan lines that did not parse it sends back each failed date and its reason and takes only those dates from the answer; for any other refusal it sends the validator's message; for a reply with no tool call it asks for the call. On the flat form it fixed 8 of gpt-oss-20b's 14 failed days and all six of Opus's refused replies. The identical-request retry it replaces had repeated Opus's packaging mistake in 4 of 6 attempts.
4. **Repair only what is mechanical.** *Folded into the parser.* The week id is set by Cadence from the plan week and never asked for, and optional boxes sent as null read as absent. The grammar grew by six recorded decisions (race names, "interval" and "hill", walk-run, a week on one line, escaped newlines, repeat patterns), never by mapping a model's field names. Not measured on its own.
5. **Gate every change.** *Built, with the caps it needed.* Every coach call is capped at 20,000 output tokens instead of 64,000, and the gate refuses a run estimated above $5 unless told otherwise. The gate prints reads valid and structured days against the band and the local thresholds.

Opus 4.7's mis-packaged plan was also recovered on `develop` as a stopgap (PR #60) for the old nested form, ahead of this work.

**The final run** on all 35 inputs: Opus 4.7 35 of 35 valid, all on the first try, every day filed, $5.43; gpt-oss-20b 35 of 35 valid (34 first try), every day filed, against 14 of 35 in the benchmark; pruned Gemma 4 34 of 35 valid (33 first try), every day filed, against 14 of 35, its one failure the server ending the stream. Both open models still plan the injury week unsafely. Results are in the after-block of [`local-models-2026-11.md`](local-models-2026-11.md). Opus spend across the work: $23.90.

**Usable is not coachable.** gpt-oss-20b's plans now arrive and file, but its injury-week plan still added a goal-pace session and a 12-mile long run where Opus planned only easy running and a 10-mile long run. Making other models coach well is the next phase, starting with a plan sanity check (#58).

**The open questions, as far as they are answered.** The read and the plan stay in one call, so the plan still follows from the read and there is no second call on slow hardware. "Close enough" for a local model is written down as at least 19 of 20 valid and 90 percent of days filed. The mid-week reply changed the same way; About you did not, since it passed everywhere.

## Sources

- [`local-models-2026-11.md`](local-models-2026-11.md): the full benchmark, failure taxonomy, rescue simulation and plan comparison.
- [ADR 0002](../adr/0002-reading-flow.md): the first strict-mode attempt and the current retry.
- [ADR 0005](../adr/0005-self-hosted-provider.md): the self-hosted provider.
- [ADR 0006](../adr/0006-plan-is-the-coachs-text.md): the plan as the coach's text, and the gate numbers.
- The maintainer's working notes hold the gate runs, per-input tables, the runaway's details and the reply-contract spec. They are not checked in.
