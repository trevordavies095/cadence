# 0007: Coaching is scored against a coach's rubric, by a judge calibrated against the coach, on a hard set

**Status:** Accepted, 2026-11-04 (the coaching-quality phase; ships in the PR from `feat/coaching-quality` into `develop`, which closes #58 and #59). Builds on ADR 0006, which made other models' replies usable; this decides how Cadence tells whether they coach well. The numbers are in [`docs/reports/coaching-2026-11.md`](../reports/coaching-2026-11.md).

## Context

**Format is solved.** After ADR 0006, every configuration measured gets its weekly read through: on the 14 hard weeks below, each of six configurations was valid on 41 or 42 of 42 replies, and every plan day filed but one of gpt-oss-20b's (293 of 294, on a 24 GB MacBook).

**The open models planned the injury week unsafely.** On the demo athlete's Achilles week, where the athlete reported pain all week and asked whether to stop running, Opus 4.7 planned only easy running and a physio visit, gpt-oss-20b planned a goal-pace session and a 12-mile long run, and a pruned Gemma 4 raised the week from 31 to 42 miles with marathon-pace repeats. All three passed every check Cadence had.

**Nobody could say how well a model coaches** except by reading replies one at a time. An athlete choosing a cheaper model could not know what they gave up, and a change to the prompts could only be shown to make the coaching different, not better or worse.

## Decision

- **A coach's rubric.** What counts as good and unsafe coaching is set by a certified running coach, not by the developer or a model. The rubric is [`docs/coaching-rubric.md`](../coaching-rubric.md): eight must-never checks (any one makes a reply unsafe), five qualities as guidance for one overall score from 1 to 5, and what weighs most, in the coach's order. It is generated from the coach's answers by `npm run replay:answers` and never edited by hand; checks 7 (rest after a marathon) and 8 (back off when the athlete is run down) are drawn from the coach's written comments.
- **The coach's answers are the answer key.** He scored 14 cases on a short blind form, three anonymous drafts each: an overall score, unsafe or not, and which draft to send. A second reviewer (the developer) answered the same form first, blind to his answers. The answers are kept privately (the answer key is never committed); only totals are published.
- **A judge calibrated against the coach.** A model judge scores one reply at a time, blind, with the rubric verbatim. Its scores are used only when it agrees with the coach at least as well as the second reviewer does: rating mean absolute difference at most 1.17, and unsafe recall at least 60 percent. Picks are not part of the bar: one-reply-at-a-time ratings are too flat to rank a case's drafts. The judge is Opus 5.5 at `high`.
- **A hard set of weeks that demand judgement.** Fourteen Sunday reads (`api/tests/fixtures/hard-set.json`): a niggle, heat and poor sleep, an overrun week, a request to double the mileage, a race moved closer, taper, race week, the week after, a beginner's first week, illness, nothing run, two missed weeks, the first week back from injury, and the Achilles week. Each carries the history that makes it real. They are fictional.
- **The plan check is a floor for every model.** Four deterministic rules (volume jump, long-run jump, quality with pain, return from injury) run on every plan from every provider before it is stored, and a tripped rule is shown to the athlete as a notice in Coach Cade's voice. The plan is never changed. When a rule trips, the model is asked once more with the warnings, on the same model, effort and server (ADR 0004), and the second plan is kept only if it trips fewer rules. `COACH_RULES_RETRY=off` turns the retry off.
- **The coaching gate on harness changes.** A change to the prompts, the packet or the form runs `npm run replay:gate -- --set coaching`: the hard set on the control with the judge, against the band in `api/tests/fixtures/coaching-band.json`. It passes when the mean rating is at least the band's mean minus its spread and the unsafe replies a repeat are no more than the band's worst. The format gate of ADR 0006 stays beside it.

## Consequences

- **What the score can say.** It ranks configurations on the hard set by how close their replies come to one coach's judgement, with run-to-run noise measured: it separates gpt-oss-20b (1.83, 57 percent judged unsafe) from the Anthropic configurations (3.31 to 3.79) with no doubt, and it gives the gate a number to hold a harness change to.
- **What it cannot say.** It cannot order configurations that sit within a few tenths of each other: the coach and the second reviewer disagreed most on exactly those (the coach rated Sonnet 5.5 lowest at 2.43, the judge and the second reviewer near the top), with only 7 drafts per configuration each. It is one coach's taste, on 14 fictional weeks harder than an average week. It does not prove a reply safe: a reply the judge passes can still be wrong for a real athlete.
- **The judge's bias is part of the number.** It rates Anthropic replies 0.3 to 0.6 above the coach (1.6 on Sonnet 5.5) and gpt-oss-20b 0.9 below, leaning towards the second reviewer's taste. It is an Opus 5.5 judging 5.5 models among others. Every report shows the coach's ratings beside the judge's on the drafts both scored.
- **The calibration is partly circular.** Checks 7 and 8 were written from the coach's comments on the same 14 cases the passing calibration was measured on. A fresh set of coach-scored cases is the way to remove that.
- **The plan check is narrower than unsafe.** Every configuration, the control included, was judged unsafe on race week (the read after the marathon, when the coach wanted a week off running) and almost all on the heat-and-poor-sleep week, and no rule covers either. The rules retry cleared the "quality with pain" warning from gpt-oss-20b's plans entirely, but the judge called 6 of the 8 plans it made rule-clean still unsafe. Passing the check is not coaching well.
- **The cost of a round.** Six configurations, three repeats, 14 weeks: $33.39 of replies and $8.05 of judging, both calibrations included; with the stopped `max` attempt, the probes, the rules-retry run and the first gate, the phase came to about $57. The ceiling is $40 a round of replies, estimated before any run. A coaching gate run costs about $3. gpt-oss-20b costs nothing but time.
- **What a rubric change costs.** A new check, a new coach or new cases means: the answer key and rubric regenerated, the judge calibrated again (and abandoned if it no longer meets the bar), every reply scored again, the analysis rerun, the band rewritten, and the report's blocks published again. Scores made under one rubric are never compared with scores under another. The steps are in the report's "How to rerun".
- **Efforts are capped per model.** At `max`, Opus 5.5 thinks past Cadence's 20,000-token output cap and never writes the reply; Haiku 5.5 does the same at `xhigh`. Settings hides efforts above each model's ceiling.

## The numbers that justified it

All on the hard set, 2026-11-03 and 2026-11-04, three repeats per configuration, judged by Opus 5.5 at `high`.

| Configuration | Judge mean | Judged unsafe | Coach mean (drafts) | Second reviewer mean (7 drafts) | Cost per weekly read |
|---|---|---|---|---|---|
| Opus 4.7 `xhigh` (control) | 3.31 | 24% | 3.33 (6) | 3.57 | $0.17 |
| Opus 4.7 `high` | 3.40 | 21% | 3.29 (7) | 3.43 | $0.15 |
| Opus 5.5 `xhigh` | 3.71 | 14% | 3.29 (7) | 4.29 | $0.30 |
| Sonnet 5.5 `xhigh` | 3.79 | 10% | 2.43 (7) | 4.29 | $0.17 |
| Haiku 5.5 `high` | 3.38 | 21% | 3.00 (7) | 3.29 | $0.01 |
| gpt-oss-20b `high`, self-hosted | 1.83 | 57% | 2.71 (7) | 1.71 | – |

- The coach and the second reviewer: the same pick in 6 of 14 cases, the same unsafe answer on 33 of 42 drafts, ratings 1.17 apart on average; the second reviewer found 2 of the coach's 5 unsafe drafts.
- The judge's first calibration, on checks 1 to 6, failed: it found 1 of the coach's 5 unsafe drafts. The second, with checks 7 and 8, passed: unsafe recall 80 percent (4 of 5), precision 57 percent, rating mean absolute difference 0.98.
- The rules retry on gpt-oss-20b: plans tripping a rule 17 to 12 of 42, "quality with pain" 5 to 0; judged mean 1.83 to 1.86 and unsafe 57 to 60 percent; median time per reply 29 to 43 seconds. The control tripped no rule, so the retry never fired on it.
- The control's band: four repeats at 3.36, 3.29, 3.29 and 3.50, floor 3.14, worst unsafe 4. The first live gate on the unchanged harness: 3.36, 3 unsafe, pass.
