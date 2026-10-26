/**
 * Phase / goal depth knobs for the weekly recap skeleton.
 * Section order is stable; knobs only change depth/emphasis.
 */

export const RECAP_SKELETON_ORDER = [
  "summary",
  "zones",
  "runByRun",
  "quality",
  "longRun",
  "trends",
  "notable",
  "subjective",
  "questions",
] as const;

export type RecapSkeletonSection = (typeof RECAP_SKELETON_ORDER)[number];

export type RecapPhase = "recovery" | "base" | "build" | "peak" | "taper";
export type RecapGoal = "general" | "5k" | "10k" | "half" | "marathon";

/** How much detail a section emits (order never changes). */
export type SectionDepth = "brief" | "standard" | "detailed";

export type RecapSectionDepths = {
  summary: SectionDepth;
  zones: SectionDepth;
  runByRun: SectionDepth;
  quality: SectionDepth;
  longRun: SectionDepth;
  trends: SectionDepth;
  notable: SectionDepth;
  subjective: SectionDepth;
  questions: SectionDepth;
};

export type RecapDepthKnobs = {
  phase: RecapPhase;
  goal: RecapGoal;
  sections: RecapSectionDepths;
  /**
   * When true and no typed Long Run exists, the week's longest run may fill
   * the Long run section (phase-aware; recovery never invents a long run).
   */
  longestAsLongRun: boolean;
};

const PHASES = new Set<RecapPhase>([
  "recovery",
  "base",
  "build",
  "peak",
  "taper",
]);

const GOALS = new Set<RecapGoal>([
  "general",
  "5k",
  "10k",
  "half",
  "marathon",
]);

export function parseRecapPhase(
  raw: string | undefined,
): RecapPhase | undefined | "invalid" {
  if (raw === undefined || raw.trim() === "") return undefined;
  const t = raw.trim().toLowerCase() as RecapPhase;
  return PHASES.has(t) ? t : "invalid";
}

export function parseRecapGoal(
  raw: string | undefined,
): RecapGoal | undefined | "invalid" {
  if (raw === undefined || raw.trim() === "") return undefined;
  const t = raw.trim().toLowerCase() as RecapGoal;
  return GOALS.has(t) ? t : "invalid";
}

function allStandard(): RecapSectionDepths {
  return {
    summary: "standard",
    zones: "standard",
    runByRun: "standard",
    quality: "standard",
    longRun: "standard",
    trends: "standard",
    notable: "standard",
    subjective: "standard",
    questions: "standard",
  };
}

/**
 * Resolve depth knobs from phase + goal.
 * Skeleton order is fixed; only per-section depth and long-run eligibility change.
 */
export function resolveRecapDepthKnobs(args?: {
  phase?: RecapPhase;
  goal?: RecapGoal;
}): RecapDepthKnobs {
  const phase = args?.phase ?? "base";
  const goal = args?.goal ?? "general";
  const sections = allStandard();

  switch (phase) {
    case "recovery":
      sections.longRun = "brief";
      sections.trends = "brief";
      sections.notable = "brief";
      sections.runByRun = "brief";
      break;
    case "base":
      sections.longRun = "standard";
      sections.trends = "standard";
      sections.notable = "standard";
      break;
    case "build":
      sections.longRun = "detailed";
      sections.trends = "detailed";
      sections.notable = "standard";
      sections.zones = "detailed";
      break;
    case "peak":
      sections.longRun = "detailed";
      sections.trends = "standard";
      sections.notable = "detailed";
      sections.runByRun = "detailed";
      break;
    case "taper":
      sections.longRun = "brief";
      sections.trends = "brief";
      sections.notable = "standard";
      sections.runByRun = "brief";
      break;
  }

  // Race goals emphasize long-run / notable a notch in build+peak.
  if (
    (goal === "half" || goal === "marathon") &&
    (phase === "build" || phase === "peak")
  ) {
    sections.longRun = "detailed";
    sections.notable = "detailed";
  }
  if (goal === "5k" || goal === "10k") {
    if (phase === "build" || phase === "peak") {
      sections.trends = "detailed";
    }
  }

  const longestAsLongRun =
    phase !== "recovery" &&
    (goal !== "general" ||
      phase === "base" ||
      phase === "build" ||
      phase === "peak" ||
      phase === "taper");

  return { phase, goal, sections, longestAsLongRun };
}
