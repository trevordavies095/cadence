/**
 * Coach Cade's method by goal (coaching-bias 26): one short block of coaching
 * method per goal kind, placed in the weekly and conversation system prompts
 * between the shape rules and the safety rules. The goal line (ticket 11) says
 * what the goal is; this says how to coach it. Model-only text: the writing
 * rules govern what the athlete reads, not these blocks. Sources stay in the
 * comments; the prompt never names them. Pure.
 */
import type { GoalDistance, GoalKind, TrainingGoal } from "../goal/types.js";
import { VOLUME_WARNING_PCT_RETURN } from "../recap/goalKnobs.js";

// Sources: Seiler (polarized intensity distribution, ~80/20 counted by session
// goal; heart-rate time in zone reads lower because of warm-ups, recoveries and
// heart-rate lag),
// Fitzgerald (80/20 Running), Daniels (Daniels' Running Formula: phases I–IV,
// base, threshold/race-specific, sharpening, taper), Pfitzinger (cutback weeks
// every three to four weeks).
const RACE_BLOCK = [
  "Coaching method for a race goal: make about 80 percent of the week's sessions easy, and put the hard work in one or two quality sessions that never fall on consecutive days.",
  "Heart-rate time in zones 1 and 2 runs lower than that on a week with two quality sessions, because their warm-ups, cool-downs and recoveries count as harder time; a share in the 60s on such a week is expected, not a problem.",
  "Follow the training phase: base builds easy volume with strides, build adds threshold work, peak adds work at and around race pace, and taper cuts volume while keeping some faster running.",
  "Grow volume gradually and plan a lighter week every three or four weeks.",
].join(" ");

// Source: Pfitzinger (Faster Road Racing: half-marathon long runs of 90 min to
// 2 h, threshold as the second key session, tempo segments inside long runs).
const HALF_LONG_RUN =
  "For the half marathon, the long run and a threshold session are the two key sessions of the week: build the long run toward 90 minutes to 2 hours, and in the build phase put threshold segments in some of them.";

// Source: Pfitzinger (Advanced Marathoning: long run as the key session,
// mid-week medium-long run, marathon-pace segments late in the build).
const MARATHON_LONG_RUN =
  "For the marathon, the long run is the key session of the week: build it toward 2.5 to 3 hours, add a mid-week medium-long run, and in the build and peak phases put marathon-pace segments in some long runs.";

/** Only the half and the marathon change the method: long-run emphasis. */
const RACE_DISTANCE_LINE: Partial<Record<GoalDistance, string>> = {
  half: HALF_LONG_RUN,
  marathon: MARATHON_LONG_RUN,
};

// Sources: Seiler and Fitzgerald (most running easy so quality can be run well),
// Daniels (threshold, interval and repetition paces from current fitness, not
// goal time; long run at most about a quarter of weekly volume).
const SPEED_BLOCK = [
  "Coaching method for getting faster: make about 80 percent of the week's sessions easy so the one or two quality sessions can be run well.",
  "Heart-rate time in zones 1 and 2 runs lower than that on a week with two quality sessions, because their warm-ups, cool-downs and recoveries count as harder time; a share in the 60s on such a week is expected, not a problem.",
  "Work in blocks of a few weeks: threshold running to raise the pace the athlete can hold, then intervals near 5K pace, with short fast repetitions or strides for speed and form.",
  "Set paces from current fitness, such as a recent race or the threshold pace, not from the target, and move them only after a race or a test shows the athlete is faster.",
  "Keep the long run easy and no more than about a quarter of the week's running.",
].join(" ");

// Sources: Seiler and Fitzgerald (low-intensity base, one moderate session is
// enough for health and fitness gains); no peaking schedule (no race date).
const FITNESS_BLOCK = [
  "Coaching method for general fitness: consistency matters most, so plan a week the athlete can repeat, on regular days, with nothing that needs extra recovery to absorb.",
  "Keep about 80 percent of the running time easy, with one moderate session a week such as strides, hills or a short tempo, and add a second only if the athlete wants it.",
  "Grow volume slowly and hold each step for a few weeks before the next, since there is no race to peak for.",
  "The week's longest run is a longer easy run, not a key session: do not build it toward a target distance or judge the week by it.",
].join(" ");

// Sources: Warden (return-to-run progression after bone stress injury: time and
// frequency before pace or distance, walk-run intervals by minutes, intensity
// only after weeks of symptom-free running), Silbernagel (pain-monitoring model:
// pain during activity and the next morning sets the next step). The weekly cap
// is the return column's volume-change warning, so the prompt and the report
// agree on what too big a step is.
const RETURN_BLOCK = [
  "Coaching method for a return to running: progress run minutes and how often the athlete runs before pace or distance, and plan walk-run sessions by minutes, such as 5 rounds of 2 min running and 1 min walking.",
  `Raise the week's total running minutes by no more than about ${VOLUME_WARNING_PCT_RETURN} percent, and the longest continuous run by no more than 2 to 3 minutes at a time.`,
  "Keep every run easy, with no intervals, hills or strides, until the athlete has had four pain-free weeks in a row.",
  "A pain-free week is one in which every run stayed at 0 of 10 and was quiet the next morning; any pain, even pain that settled, starts the count again.",
  "Pain above 3 of 10 during a run, or pain that is worse the next morning, means a smaller next step: repeat or shorten the last session instead of adding to it.",
  "Pain at 3 of 10 or below that settles by the next morning allows the next small step.",
].join(" ");

const BLOCK: Record<GoalKind, (goal: TrainingGoal) => string> = {
  race: (goal) => {
    const line = goal.distance ? RACE_DISTANCE_LINE[goal.distance] : undefined;
    return line ? `${RACE_BLOCK} ${line}` : RACE_BLOCK;
  },
  speed: () => SPEED_BLOCK,
  fitness: () => FITNESS_BLOCK,
  return: () => RETURN_BLOCK,
};

/** The coaching block for the athlete's goal, or null with no goal stored. */
export function coachingBlock(goal: TrainingGoal | null | undefined): string | null {
  return goal ? BLOCK[goal.kind](goal) : null;
}
