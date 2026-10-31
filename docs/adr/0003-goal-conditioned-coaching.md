# 0003: The goal is data, and the report follows it

**Status:** Accepted, 2026-10-31, after two live replays over three non-marathon seasons (see Evidence).

## Context

Cadence was built and tuned on one athlete's marathon block. That block shaped the weekly report, the check-in and the plan, and nothing else could steer them, because the athlete's goal was a sentence. Onboarding asked "What are you training for? Race/event + target date, or general fitness / base building." and kept the answer as free text. The text reached Coach Cade only as prose inside About you. The report never read it, and the prompts did not open with it.

Measured on the report as it was at `4194cec`, these are the lines a runner who only wants to stay fit saw every week:

| Section | Line |
|---|---|
| Zones | "Target for marathon base phase: **≥80% in Z1+Z2**. This week: **N%**." |
| Zones, when under 80% | "**Below** typical marathon base target (≥80% Z1+Z2)." |
| Long run | "Last ~5 km window at marathon-pace effort? No" ("Last 3 mi" in miles) |
| Trends | "**Long-run distance** (max long-typed, else max run in week): … (improving)" or "(declining)" |

The report could tell an easy run only by searching the label for "easy" or "long", and an untyped run counted toward the easy heart-rate trend only when its average heart rate sat under the zone 2 ceiling. The check-in asked every athlete the same questions: no race result, no pain score, strength work only. The offline stub planned the same week for everyone, with a threshold session and an 18 km long run, under the headline "Protect easy days and land the long run."

None of this was wrong for a marathoner. For anyone else, the report judged them against a goal they did not have, and the model read that judgement as its steer.

## Decision

**The goal is a structured, versioned record.** A goal has a kind (race, speed, fitness or return), a distance for a race (5K, 10K, half, marathon or other), and optional race name, race date, free-text target, and for a return, a free-text starting point and a since date. It is stored in `training_goals` and appended, never edited; the latest row is current (`api/src/goal/types.ts`, `api/src/goal/store.ts`). `GET /goal` returns it with its sentence and `PUT /goal` appends a new one (`api/src/routes/goal.ts`). The target and starting point are never parsed.

**Onboarding sets the first goal; only Settings changes it.** This is "What you're training for" in CONTEXT.md, the question in onboarding and the section in Settings (`frontend/app/(app)/settings/page.tsx`, `frontend/components/GoalFields.tsx`). Saving there also tells Coach Cade "My goal is now …" through Fix something, and the goal is stored only once that correction succeeds, so the goal and About you never disagree. Chat never changes the goal.

**The phase is derived, not asked.** `resolveGoalContext` (`api/src/goal/context.ts`) turns the goal and the week's Monday into a phase, the weeks to the race, whether the race has passed, and the report knobs. A dated race, or a speed goal with a test race, takes its phase from the weeks left; the two weeks after a race are recovery; an undated goal takes a fixed phase by kind. An athlete with no goal stored resolves to general fitness in base. The phase is a hint to the report and the model. The athlete never sets it, and the home banner never says the word.

**The report gives a verdict only where the goal sets a target.** A knobs table maps each goal to one of four columns (endurance, speed, fitness, return) and says, per column and phase, which lines carry a target or verdict and at what value: the easy-share target, the drift caps, whether the long-run section appears and whether its trend is judged, the fast-finish line, the hard-minutes checks, threshold minutes, the volume-change warning and what the summary leads with (`resolveRecapThresholds` in `api/src/recap/goalKnobs.ts`). Every value that varies by goal lives in that file beside its research source. Measurement constants that are the same for every goal, such as the fast-finish pickup, the threshold-minutes band and its 30-second window, and the pace margin for detecting reps, live beside the code that measures. Where the goal sets no target, the report shows the number and stays quiet about it. A target can also be a reference with no verdict: the 5K, 10K and speed column shows its 75% easy share "counted by session" but never calls a week below it, because heart-rate time in zones 1 and 2 runs in the 60s on a normal two-quality-session week. A stay-fit week now reads "Easy-running share: N% (zones 1 and 2 of time with heart rate)." with no target, no long-run section, and a "Longest run" line on the summary instead. The recap JSON carries the resolved context as `goalContext`.

**The run-type label is trusted as the athlete set it.** Tempo's ten run types are grouped into families in one place (`api/src/recap/runTypes.ts`). An Easy Run is easy because the athlete called it easy: there is no heart-rate or pace gate on a label. Untyped runs belong to the easy family. Walk-Run stands alone, as in Tempo's own easy-run heart rate, because walk breaks distort easy pace, easy heart rate and drift. If the label is wrong, the athlete fixes it in Tempo.

**The prompts are told the goal.** Every weekly read and conversation prompt opens with "Athlete goal: …", then "Training phase: …", then, after a race, how long ago it was (`api/src/llm/goalLines.ts`). These lines come from the model packet's `goal` and `coaching` fields, so the model never has to dig the goal out of About you's prose. The check-in follows the goal too: a run typed Race is asked how it went against the target, and a returning runner is asked for pain from 0 to 10. The offline stub plans the week by goal kind.

**Coach Cade gets a method per kind, after a replay.** Telling the model the goal does not tell it how to coach that goal. The weekly system prompt carries no coaching philosophy, so until now the report's marathon framing was its only steer. One short block per kind (race, speed, fitness, return) says how to coach each (`api/src/llm/coachingBlocks.ts`). It sits between the read-shape rules and the safety rules in both the weekly and the conversation system prompts, so a chat reply cannot plan what the weekly read just ruled out. The race block adds a long-run sentence for the half and the marathon only. Values the blocks share with the report, such as the return column's weekly step, come from the knobs table, so the prompt and the report agree.

## Evidence: the replay gate

The replay script (`api/scripts/replay-weekly-reads.ts`, ADR 0002) now takes a folder of packets with `--packets`, and every report opens with three goal checks (`api/scripts/replayChecks.ts`):

- a packet with no goal line, either no goal or a rebuilt prompt that does not open with "Athlete goal:";
- the word "marathon" in a read whose goal is not a marathon ("half marathon" does not count);
- a long-run verdict, such as "fast finish" or a long run called improving or declining, in a read whose goal is stay fit.

The script exits non-zero when any check fails. A dry run over the packet fixtures (`api/tests/fixtures/replay-packets/`) uses the offline stub only.

The evidence is two live replays over three synthetic six-week seasons that are not marathon blocks: a stay-fit runner, a 10K runner and a returning runner (`api/tests/fixtures/seasons/`, regenerated with `api/scripts/regenerate-replay-seasons.ts`). A person read every read.

The first replay passed all three goal checks, and reading it found what the checks cannot:

| Found | Changed |
|---|---|
| The return reads counted pain-free weeks differently from week to week, and one used two pain cutoffs in the same read | The return block defines a pain-free week: every run at 0 of 10 and quiet the next morning; any pain restarts the count |
| One return week jumped from 5 to 14 minutes of continuous running | The return block caps the step: total running minutes by the return column's weekly warning, the longest continuous run by 2 to 3 minutes |
| The 10K reads flagged easy share below 75% in all six weeks, at 56 to 69% | The race and speed blocks say 80/20 counts sessions; the report shows the 75% as a reference with no verdict |
| Stay-fit reads judged the Sunday run as a long run | The fitness block calls the longest run a longer easy run, not a key session |
| Walk-run sessions counted toward easy heart rate | Walk-Run left the easy family |
| A metric athlete's read mixed kilometres and miles for shoes | Shoe distance follows the athlete's unit |

The second replay, over regenerated packets, ran all 18 calls (one refused for its shape and returned when asked once more) and passed the three checks. The pain-free count ran the same way every week, the return step stayed within its cap, and the 10K easy-share flag appeared once, in the one week with three hard sessions. What remained was small: one early return read misstated a weekly percentage, and stay-fit reads repeated the same note about Sunday's zone 3 time.

## Consequences

- A report line that judges the athlete needs a knob. A new verdict, or a new goal column, means a change to `goalKnobs.ts`, with the source beside the constant, and a check that the stay-fit and return columns stay quiet.
- The knobs table's values come from published coaching and injury research, not from Cadence's own data. Retuning one is a change to that file alone.
- The goal record is the source of truth for the goal. About you still describes it in prose for the model, and the Settings correction keeps the two in step. Code must read the record, never About you.
- Because labels are trusted, a mislabelled run skews the easy-family lines and trends. That is accepted: the athlete owns the label and can fix it in Tempo.
- Any change to the weekly prompt, its goal lines or the coaching blocks is replayed through the three goal checks before it ships.
- An athlete with no stored goal gets the fitness column until they set one in Settings.
- The goal-relevant metrics left out of this work (session-RPE load and monotony, week-over-week load change, efficiency factor, race-pace minutes and a pain trend) are tracked in cadence issue #32. Most need check-in data that is not reliably collected yet, or a parsed target, which the goal record leaves as free text on purpose.
