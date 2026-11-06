import { ApiError } from "./errors";

export type TempoConnection = {
  configured: boolean;
  baseUrl: string | null;
  maskedKey: string | null;
  updatedAt: string | null;
};

export type AnthropicConnection = {
  configured: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
};

/** What the API is running with (#6): an export or the offline coach needs no saved key. */
export type SettingsSources = {
  tempo: "export" | "connection";
  model: "stub" | "anthropic";
  demo: boolean;
};

export type SettingsSummary = {
  tempo: TempoConnection & { source: SettingsSources["tempo"] };
  anthropic: AnthropicConnection & { source: SettingsSources["model"] };
  demo: boolean;
};

/** Compact coaching workout summary stored on a thread message (no GPS). */
export type WorkoutAttachment = {
  workoutId: string;
  startedAt: string;
  durationS: number;
  distanceM: number;
  avgPaceS: number;
  elevGainM?: number | null;
  avgHeartRateBpm?: number | null;
  maxHeartRateBpm?: number | null;
  relativeEffort?: number | null;
  rpe?: number | null;
  runType?: string | null;
  activityName?: string | null;
  notes?: string | null;
  hasRoute?: boolean;
  splitsCount?: number;
  /** Per-split numbers the coach was shown; pace is seconds per kilometre. */
  splits?: Array<{
    idx?: number;
    kind?: string | null;
    distanceM?: number | null;
    durationS?: number | null;
    paceS?: number | null;
    avgHeartRateBpm?: number | null;
  }>;
};

export type TempoWorkoutSummary = {
  id: string;
  startedAt: string;
  durationS: number;
  distanceM: number;
  avgPaceS: number;
  avgHeartRateBpm?: number | null;
  runType?: string | null;
  name?: string | null;
  hasRoute?: boolean;
};

export type ThreadMessage = {
  id: string;
  role: "athlete" | "coach" | "system";
  /** "weekly_read" is the short Sunday message that points at the plan. */
  kind?: "chat" | "weekly_read";
  /**
   * Where a weekly_read message's link goes: "plan" while the week it planned is
   * this week or next, "week" (that week's Your week page) after that.
   */
  readLink?: "plan" | "week";
  body: string;
  createdAt: string;
  weekSessionId: string | null;
  attachment?: WorkoutAttachment | null;
  /** Safety callouts that came with a coach message; empty otherwise. */
  safetyCallouts?: SafetyCallout[];
  /** On the Sunday message: the notices on the plan it points at; empty when none. */
  planWarnings?: PlanWarning[];
  /** The model call that wrote this coach message; links a reply to its run. */
  llmCallId?: string | null;
  /** The note this reply produced, as it stands now; null when it produced none. */
  dossierProposal?: ThreadNote | null;
  /** The plan days this reply changed, as they were then; null when it changed none. */
  planChanges?: PrescribedDay[] | null;
};

/** What a thread message shows of the note it produced. */
export type ThreadNote = {
  id: number;
  kind: "settings" | "audit" | "correction" | "onboarding";
  status: "pending" | "accepted" | "rejected" | "undone";
  summaryBullets: string[];
  appliedVersionId: number | null;
  previousVersionId: number | null;
  createdAt: string;
};

export type UnitPreference = "metric" | "imperial";

export type PrescribedRun = {
  type: string;
  /** 0 when the run is prescribed by duration only. */
  distanceM: number;
  /** Planned seconds, when the run is prescribed by time. */
  durationS?: number | null;
  structure?: string | null;
  paceOrHr?: string | null;
  shoes?: string | null;
};

export type PrescribedDay = {
  date: string;
  dayType: string;
  run?: PrescribedRun | null;
  strength?: string | null;
  notes?: string | null;
  /** Coach Cade's sentence for the day, as written; null when none was given. */
  line?: string | null;
  /** False when Cadence could not derive the day's structure; absent reads as parsed. */
  parsed?: boolean;
};

export type PrescribedWeek = {
  week: string;
  days: PrescribedDay[];
};

export type SafetyCallout = {
  title: string;
  body: string;
  severity?: "info" | "caution" | "urgent";
};

/**
 * A notice on the plan from Cadence's own check of it against the athlete's
 * recent training: a title and body in Coach Cade's voice. `rule` names the
 * check for the log and is never shown.
 */
export type PlanWarning = {
  rule: string;
  title: string;
  body: string;
  figures?: Record<string, number>;
};

export type PrescribedWeekRecord = {
  weekSessionId: string;
  plan: PrescribedWeek;
  analysis: string;
  settingsProposalBullets: string[] | null;
  safetyCallouts: SafetyCallout[] | null;
  /** The parts of the read laid out on their own; null on plans made before them. */
  readSections?: ReadSections | null;
  /** Notices from Cadence's check of the plan; null on plans made before the check. */
  planWarnings?: PlanWarning[] | null;
  createdAt: string;
  updatedAt: string;
};

/** The parts of Coach Cade's read laid out on their own. */
export type ReadSections = {
  headline: string;
  /** What Coach Cade is watching, shown as "Watching". */
  flags?: Array<{ title: string; detail: string }>;
  /** Answers to the athlete's own questions, shown as "Your questions". */
  answers?: Array<{ question: string; answer: string }>;
};

export type PrescribedWeekArtifact = {
  kind: "prescribed_week";
  weekSessionId: string;
  plan: PrescribedWeek;
  safetyCallouts: SafetyCallout[];
  planWarnings?: PlanWarning[];
  createdAt: string;
  updatedAt: string;
};

/** Weekly recap markdown document in the coach thread (#25). */
export type WeeklyRecapArtifact = {
  kind: "weekly_recap";
  weekSessionId: string;
  markdown: string;
  subjective: "skipped" | "present";
  createdAt: string;
  updatedAt: string;
};

export type ThreadArtifact = PrescribedWeekArtifact | WeeklyRecapArtifact;

export type WeeklyReplyResult = {
  reply: {
    analysis: string;
    prescribedWeek: PrescribedWeek;
    settingsProposalBullets?: string[];
    safetyCallouts?: SafetyCallout[];
  };
  packetWeek: unknown;
  prescribed: PrescribedWeekRecord | null;
  coachMessage: ThreadMessage | null;
  threadArtifact: PrescribedWeekArtifact | null;
};

export type WeekSession = {
  id: string;
  isoWeek: string;
  timezone: string;
  start: string;
  end: string;
  createdAt: string;
  /** True once a later ISO week session has been started. */
  archived: boolean;
  archivedAt: string | null;
  created?: boolean;
};

export type DossierVersion = {
  id: number;
  body: string;
  createdAt: string;
};

export type DossierProposal = {
  id: number;
  summaryBullets: string[];
  proposedBody: string;
  kind?: "settings" | "audit" | "correction" | "onboarding";
  status: "pending" | "accepted" | "rejected" | "undone";
  /** The version this note installed; null while pending or rejected. */
  appliedVersionId?: number | null;
  /** The version it replaced; null when there was none. */
  previousVersionId?: number | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type PrivacyCopy = {
  title: string;
  intro: string;
  sent: { heading: string; items: string[] };
  local: { heading: string; items: string[] };
  disclosure: string;
  /** Who coaching context is sent to. */
  provider: "anthropic" | "self_hosted";
  /** The self-hosted model server's host; null for Anthropic. */
  host: string | null;
  /** Whether that host is on the athlete's own network; null when there is no host. */
  onNetwork: boolean | null;
};

export type OnboardingFieldKey =
  | "goal"
  | "schedule"
  | "injuries_constraints"
  | "preferences";

export type OnboardingAnswers = {
  goal: string;
  schedule: string;
  injuries_constraints?: string;
  preferences?: string;
};

/** What the athlete is training for, as the API stores it. */
export type TrainingGoal = {
  kind: "race" | "speed" | "fitness" | "return";
  distance?: "5k" | "10k" | "half" | "marathon" | "other";
  raceName?: string;
  /** YYYY-MM-DD. */
  raceDate?: string;
  target?: string;
  startingPoint?: string;
  since?: string;
};

/** The answers the page sends: the goal goes as a record and the API writes its sentence. */
export type OnboardingSubmission = {
  answers: Omit<OnboardingAnswers, "goal">;
  goal: TrainingGoal;
};

export type OnboardingQuestionnaire = {
  order: OnboardingFieldKey[];
  fields: Record<OnboardingFieldKey, string>;
  all_fields_optional: boolean;
  required: OnboardingFieldKey[];
};

export type OnboardingPrefills = {
  available: boolean;
  unitPreference?: "metric" | "imperial";
  heartRateZones?: {
    calculationMethod: string;
    zones: Array<{ zoneNumber: number; minBpm: number; maxBpm: number }>;
  };
  defaultShoeId?: string | null;
  shoes?: Array<{
    id: string;
    brand: string;
    model: string;
    isRetired: boolean;
  }>;
  recentTraining?: Array<{
    id: string;
    startedAt: string;
    name: string | null;
    distanceM: number;
    durationS: number;
    runType: string | null;
  }>;
  reason?: string;
};

export type OnboardingGate =
  | {
      status: "needs_onboarding";
      note: string;
      questionnaire: OnboardingQuestionnaire;
      prefills: OnboardingPrefills;
    }
  | {
      status: "ready";
      note: string;
      answers: OnboardingAnswers;
      questionnaire: OnboardingQuestionnaire;
      prefills: OnboardingPrefills;
      createdAt: string;
      updatedAt: string;
    }
  | {
      /** About you exists: the first answers are done. */
      status: "complete";
      note: string;
      answers: OnboardingAnswers | null;
      dossierVersionId: number;
    }
  | {
      status: "complete";
      note: string;
      answers: OnboardingAnswers | null;
      dossierVersionId: number;
    };

export type LastOutboundPacketSummary = {
  isoWeek: string | null;
  weekSessionId: string | null;
  dossierVersionId: number | null;
  threadMessageCount: number;
  attachmentCount: number;
  hasRecap: boolean;
  attachmentWorkoutIds: string[];
  /** Prior weeks in the lean recent-history window (#34). */
  recentHistoryCount?: number;
  recentHistoryLimit?: number;
  /** The plan for that week went along; absent on packets saved before it was counted. */
  hasPlan?: boolean;
};

/** The training goal as it went to Coach Cade (API `TrainingGoal`). */
export type SentGoal = {
  kind: "race" | "speed" | "fitness" | "return";
  distance?: "5k" | "10k" | "half" | "marathon" | "other";
  raceName?: string;
  /** YYYY-MM-DD. */
  raceDate?: string;
  target?: string;
  startingPoint?: string;
  /** YYYY-MM-DD. */
  since?: string;
};

/** Where the athlete is in training for the week that was sent (API `ModelPacketCoaching`). */
export type SentCoaching = {
  phase: "recovery" | "base" | "build" | "peak" | "taper";
  weeksToRace?: number;
  racePassed?: boolean;
  /** Return goals: whole weeks since the return began. */
  weeksIntoReturn?: number;
  /** The running log's distance unit; threshold paces print in it. */
  unitPreference?: UnitPreference;
  /** Seconds per km, athlete-set. */
  thresholdPaceS?: number;
  thresholdHeartRateBpm?: number;
  /** Seconds per km, suggested by the running log from a recent best. */
  suggestedThresholdPaceS?: number;
  maxHeartRateBpm?: number;
  observedMaxHeartRateBpm?: number;
};

export type LastOutboundPacket = {
  savedAt: string;
  summary: LastOutboundPacketSummary;
  /** Full redacted packet; older packets may lack goal and coaching. */
  packet: {
    goal?: SentGoal | null;
    coaching?: SentCoaching | null;
    [key: string]: unknown;
  };
};

/** Plan hard-gate: check-in must be finished or skipped (#52). */
export type CheckInRequiredPayload = {
  error: "check_in_required";
  message: string;
  checkInStatus: "needed";
  weekSessionId: string;
};

export class CheckInRequiredError extends Error {
  readonly status = 409;
  readonly error = "check_in_required" as const;
  readonly checkInStatus = "needed" as const;
  readonly weekSessionId: string;

  constructor(payload: CheckInRequiredPayload) {
    super(payload.message);
    this.name = "CheckInRequiredError";
    this.weekSessionId = payload.weekSessionId;
  }
}

function parseCheckInRequired(text: string): CheckInRequiredPayload | null {
  try {
    const body = JSON.parse(text) as Partial<CheckInRequiredPayload>;
    if (
      body.error === "check_in_required" &&
      typeof body.message === "string" &&
      body.checkInStatus === "needed" &&
      typeof body.weekSessionId === "string"
    ) {
      return body as CheckInRequiredPayload;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    const checkIn = parseCheckInRequired(text);
    if (checkIn) throw new CheckInRequiredError(checkIn);
    throw new ApiError(res.status, text);
  }
  return (await res.json()) as T;
}

export async function fetchSettings(): Promise<SettingsSummary> {
  return readJson(await fetch("/api/settings"));
}

export async function putTempoConnection(
  baseUrl: string,
  apiKey: string,
): Promise<TempoConnection> {
  return readJson(
    await fetch("/api/settings/tempo", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey }),
    }),
  );
}

export async function deleteTempoConnection(): Promise<TempoConnection> {
  return readJson(await fetch("/api/settings/tempo", { method: "DELETE" }));
}

export async function putAnthropicConnection(
  apiKey: string,
): Promise<AnthropicConnection> {
  return readJson(
    await fetch("/api/settings/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }),
  );
}

export async function deleteAnthropicConnection(): Promise<AnthropicConnection> {
  return readJson(await fetch("/api/settings/anthropic", { method: "DELETE" }));
}

export type CoachEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type CoachModelChoice = { model: string; effort: CoachEffort };

/** Who serves Coach Cade: Anthropic, or the athlete's own model server. */
export type CoachProvider = "anthropic" | "self_hosted";

/** Coach Cade's model setting: the choice, what is in force, and what can be chosen. */
export type CoachModelSettings = {
  /** The provider this view lists; missing (an older API) means Anthropic. */
  provider?: CoachProvider;
  saved: CoachModelChoice | null;
  effective: CoachModelChoice;
  tested: CoachModelChoice;
  models: Array<{ id: string; displayName: string; tested: boolean; efforts: CoachEffort[] }>;
  /**
   * Why only a short list is offered: no Anthropic key saved, no self-hosted server
   * saved, or the list couldn't be loaded.
   */
  fallback: "no_key" | "no_connection" | "unavailable" | null;
};

/**
 * The saved provider's view, or with `provider` that provider's list, so the page can
 * show a self-hosted server's models before a self-hosted model is saved.
 */
export async function fetchCoachModel(provider?: CoachProvider): Promise<CoachModelSettings> {
  const qs = provider ? `?provider=${provider}` : "";
  return readJson(await fetch(`/api/settings/coach-model${qs}`));
}

/** An omitted provider is Anthropic. */
export async function saveCoachModel(
  choice: CoachModelChoice & { provider?: CoachProvider },
): Promise<CoachModelSettings> {
  return readJson(
    await fetch("/api/settings/coach-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(choice),
    }),
  );
}

export async function resetCoachModel(): Promise<CoachModelSettings> {
  return readJson(await fetch("/api/settings/coach-model", { method: "DELETE" }));
}

/** The athlete's own model server: its address, and whether a key is saved. */
export type SelfHostedConnection = {
  configured: boolean;
  baseUrl: string | null;
  keyConfigured: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
};

export async function fetchSelfHostedConnection(): Promise<SelfHostedConnection> {
  return readJson(await fetch("/api/settings/self-hosted"));
}

/** An omitted key keeps the saved one; an empty string removes it. */
export async function putSelfHostedConnection(body: {
  baseUrl: string;
  apiKey?: string;
}): Promise<SelfHostedConnection> {
  return readJson(
    await fetch("/api/settings/self-hosted", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function deleteSelfHostedConnection(): Promise<SelfHostedConnection> {
  return readJson(await fetch("/api/settings/self-hosted", { method: "DELETE" }));
}

/** Why the saved server's model list couldn't be read. */
export type SelfHostedListingFailure = "unreachable" | "unauthorized" | "http_error";

/**
 * Test connection: the saved server's list is read, then a long test message goes to the
 * chosen model. `verdict` is set only when that message got an answer; a failed listing
 * leaves the probe `not_run`.
 */
export type SelfHostedTestResult = {
  listing: { ok: boolean; reason?: SelfHostedListingFailure };
  probe: {
    ok: boolean;
    verdict?: "ok" | "cut";
    sentTokens: number;
    reportedTokens: number | null;
    wordFound: boolean;
    reason?: SelfHostedListingFailure | "timeout" | "invalid_response" | "not_run";
  };
};

/** Only ever calls the saved server; can take a minute or two on home hardware. */
export async function testSelfHostedConnection(model: string): Promise<SelfHostedTestResult> {
  return readJson(
    await fetch("/api/settings/self-hosted/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }),
  );
}

export async function fetchThread(
  weekSessionId?: string,
): Promise<{ messages: ThreadMessage[]; artifacts: ThreadArtifact[] }> {
  const qs = weekSessionId
    ? `?weekSessionId=${encodeURIComponent(weekSessionId)}`
    : "";
  return readJson(await fetch(`/api/thread${qs}`));
}

export async function fetchPrescribedWeek(
  weekSessionId: string,
): Promise<{
  prescribed: PrescribedWeekRecord;
  unitPreference: UnitPreference;
  /** The athlete's local calendar date, YYYY-MM-DD. */
  todayYmd: string;
}> {
  return readJson(
    await fetch(`/api/weeks/${encodeURIComponent(weekSessionId)}/prescribed`),
  );
}

/**
 * "Add the details": asks Coach Cade for one line for an unread day of the
 * week's plan, on the model saved now. Resolves with the plan with that day
 * filled in; throws when Coach Cade could not fill it in (nothing changed).
 */
export async function postPlanDayDetails(
  weekSessionId: string,
  date: string,
): Promise<{ prescribed: PrescribedWeekRecord; day: PrescribedDay }> {
  return readJson(
    await fetch(`/api/weeks/${encodeURIComponent(weekSessionId)}/prescribed/details`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date }),
    }),
  );
}

/** Plan for the ISO week after `weekSessionId` (null until one is generated). */
export async function fetchNextWeekPrescribed(
  weekSessionId: string,
): Promise<{
  weekSession: WeekSession;
  checkInStatus: CheckInStatus;
  prescribed: PrescribedWeekRecord | null;
  unitPreference: UnitPreference;
  todayYmd: string;
}> {
  return readJson(
    await fetch(
      `/api/weeks/${encodeURIComponent(weekSessionId)}/prescribed/next`,
    ),
  );
}

export async function postWeeklyReply(input: {
  weekSessionId?: string;
  recapMarkdown?: string | null;
}): Promise<WeeklyReplyResult> {
  return readJson(
    await fetch("/api/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** Mid-week free chat on the current week — athlete message + coach reply (attach feedback / plan patches when set). */
export async function postMidWeekChat(
  weekSessionId: string,
  body: string,
  attachmentWorkoutId?: string | null,
): Promise<{
  athleteMessage: ThreadMessage;
  coachMessage: ThreadMessage;
  weekSessionId: string;
  /** Pending soft-gate proposal when mid-week memory update is significant (#39). */
  dossierProposal?: DossierProposal | null;
  /** Updated prescribed week when remaining-day patches were applied (#38). */
  prescribed?: PrescribedWeekRecord | null;
  threadArtifact?: PrescribedWeekArtifact | null;
}> {
  const payload: { body: string; attachmentWorkoutId?: string } = { body };
  if (attachmentWorkoutId) {
    payload.attachmentWorkoutId = attachmentWorkoutId;
  }
  return readJson(
    await fetch(`/api/weeks/${encodeURIComponent(weekSessionId)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

/** Recent / in-window workouts for mid-week attach picker (GPS stripped). */
export async function fetchTempoWorkouts(query?: {
  startDate?: string;
  endDate?: string;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: string;
}): Promise<{
  items: TempoWorkoutSummary[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}> {
  const params = new URLSearchParams();
  if (query?.startDate) params.set("startDate", query.startDate);
  if (query?.endDate) params.set("endDate", query.endDate);
  if (query?.pageSize != null) params.set("pageSize", String(query.pageSize));
  if (query?.sortBy) params.set("sortBy", query.sortBy);
  if (query?.sortOrder) params.set("sortOrder", query.sortOrder);
  const qs = params.toString();
  return readJson(await fetch(`/api/tempo/workouts${qs ? `?${qs}` : ""}`));
}

export async function ensureCurrentWeek(): Promise<WeekSession> {
  return readJson(await fetch("/api/weeks/current", { method: "POST" }));
}

/** A week as History lists it: the session plus what happened and what the coach said. */
export type WeekSummary = WeekSession & {
  /** "Oct 19 – 25". */
  localRange: string;
  /** Null when your running log could not be read. */
  actualDistanceM: number | null;
  runCount: number | null;
  coachHeadline: string | null;
};

export async function fetchWeeks(): Promise<{
  weeks: WeekSummary[];
  tempoUnavailable: boolean;
}> {
  return readJson(await fetch("/api/weeks"));
}

export type DossierAuditMeta = {
  lastAuditAt: string | null;
  nextAuditDueAt: string | null;
  intervalWeeks: number;
  due: boolean;
};

export async function fetchDossier(): Promise<{
  current: DossierVersion | null;
  audit?: DossierAuditMeta;
}> {
  return readJson(await fetch("/api/dossier"));
}

export async function putDossier(body: string): Promise<DossierVersion> {
  return readJson(
    await fetch("/api/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }),
  );
}

export async function fetchDossierProposals(): Promise<{
  proposals: DossierProposal[];
}> {
  return readJson(await fetch("/api/dossier/proposals"));
}

export async function acceptDossierProposal(
  id: number,
  options?: { proposedBody?: string },
): Promise<{ proposal: DossierProposal; version: DossierVersion }> {
  const proposedBody = options?.proposedBody;
  return readJson(
    await fetch(`/api/dossier/proposals/${id}/accept`, {
      method: "POST",
      ...(proposedBody !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ proposedBody }),
          }
        : {}),
    }),
  );
}

export async function rejectDossierProposal(
  id: number,
): Promise<{ proposal: DossierProposal }> {
  return readJson(
    await fetch(`/api/dossier/proposals/${id}/reject`, { method: "POST" }),
  );
}

/** Athlete fix/add note → pending soft-gate proposal (+ thread messages). */
export async function postDossierCorrection(input: {
  body: string;
  weekSessionId?: string;
}): Promise<{
  athleteMessage: ThreadMessage;
  coachMessage: ThreadMessage;
  dossierProposal: DossierProposal;
  dossierVersionId: number;
}> {
  return readJson(
    await fetch("/api/dossier/corrections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchPrivacy(): Promise<PrivacyCopy> {
  return readJson(await fetch("/api/privacy"));
}

export async function fetchOnboarding(): Promise<OnboardingGate> {
  return readJson(await fetch("/api/onboarding"));
}


export async function saveOnboardingAnswers(
  submission: OnboardingSubmission,
  weekSessionId?: string,
): Promise<{
  status: "ready";
  answers: OnboardingAnswers;
  createdAt: string;
  updatedAt: string;
  gate: OnboardingGate;
  proposal: DossierProposal;
  coachMessage: ThreadMessage;
  llm: {
    mode: "stub" | "anthropic";
    coachConfigured: boolean;
    systemStance: "coach_running_no_diagnose";
  };
}> {
  return readJson(
    await fetch("/api/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        weekSessionId ? { ...submission, weekSessionId } : submission,
      ),
    }),
  );
}

export async function fetchLastOutboundPacket(): Promise<{
  lastPacket: LastOutboundPacket | null;
}> {
  return readJson(await fetch("/api/settings/last-packet"));
}

/** Compact run row from needs_subjective gate. */
export type NeedsSubjectiveRun = {
  id: string;
  date: string | null;
  runType: string | null;
  distance: string | null;
  duration: string | null;
  distanceM: number | null;
  durationS: number | null;
  apiRpe: number | null;
};

export type SubjectiveQuestionnaire = {
  order: string[];
  per_run: { rpe: string; felt: string; pain: string; pain_score?: string };
  weekly: {
    sleep_avg_hrs: string;
    sleep_range_hrs: string;
    strength_sessions: string;
    stress_level: string;
    body_check: string;
    feeling_into_next_week: string;
    questions_for_coach: string;
  };
  all_fields_optional: true;
};

export type SubjectiveRunRow = {
  date: string;
  rpe?: number;
  felt?: number;
  pain?: string;
  /** 0 to 10; 0 means no pain. Asked when the goal is a return to running. */
  pain_score?: number;
  /** A Race run's answer to "How did it go against your target?". */
  result?: string;
};

export type SubjectiveAnswers = {
  week: string;
  runs: SubjectiveRunRow[];
  weekly?: {
    sleep_avg_hrs?: number;
    sleep_range_hrs?: [number, number];
    strength_sessions?: {
      completed?: number;
      planned?: number;
      notes?: string;
    };
    stress_level?: string;
    body_check?: string;
    feeling_into_next_week?: string;
    questions_for_coach?: string[];
  };
};

/** Plan hard-gate (#49 / #52): needed until finish or explicit Skip. */
export type CheckInStatus = "needed" | "finished" | "skipped";

export type RecapGate =
  | {
      status: "needs_subjective";
      weekSessionId: string;
      week: string;
      timezone: string;
      localRange: { start: string; end: string };
      note: string;
      runs: NeedsSubjectiveRun[];
      questionnaire: SubjectiveQuestionnaire;
      checkInStatus: "needed";
    }
  | {
      status: "report";
      weekSessionId: string;
      isoWeek: string;
      subjective: "skipped" | "present";
      subjectiveAnswers: SubjectiveAnswers | null;
      checkInStatus: "finished" | "skipped";
      reportMarkdown: string;
      sections: {
        summary: string;
        zones: string;
        runByRun: string;
        subjective?: string;
        questions?: string;
      };
      threadArtifact?: WeeklyRecapArtifact;
    };

export type SaveSubjectiveResult = {
  status: "saved";
  weekSessionId: string;
  answers: SubjectiveAnswers;
  createdAt: string;
  updatedAt: string;
  gate: RecapGate;
  threadArtifact?: WeeklyRecapArtifact | null;
};

export async function fetchWeekRecap(
  weekSessionId: string,
  opts?: { skipSubjective?: boolean; refreshSubjective?: boolean },
): Promise<RecapGate> {
  const params = new URLSearchParams();
  if (opts?.skipSubjective) params.set("skip_subjective", "true");
  if (opts?.refreshSubjective) params.set("refresh_subjective", "true");
  const qs = params.toString();
  const path = `/api/weeks/${encodeURIComponent(weekSessionId)}/recap${
    qs ? `?${qs}` : ""
  }`;
  return readJson(await fetch(path));
}

export async function saveSubjectiveAnswers(
  weekSessionId: string,
  answers: SubjectiveAnswers,
): Promise<SaveSubjectiveResult> {
  return readJson(
    await fetch(
      `/api/weeks/${encodeURIComponent(weekSessionId)}/recap/subjective`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(answers),
      },
    ),
  );
}
/** One server-side execution of the weekly reply for a reviewed week. */
export type ReplyRun = {
  id: string;
  weekSessionId: string;
  status: "pending" | "ok" | "failed";
  llmCallId: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  seenAt: string | null;
};

export async function fetchReplyRun(
  weekSessionId: string,
): Promise<{ run: ReplyRun | null }> {
  return readJson(
    await fetch(`/api/weeks/${encodeURIComponent(weekSessionId)}/reply-run`),
  );
}

export async function retryReplyRun(
  weekSessionId: string,
): Promise<{ run: ReplyRun }> {
  return readJson(
    await fetch(
      `/api/weeks/${encodeURIComponent(weekSessionId)}/reply-run/retry`,
      { method: "POST" },
    ),
  );
}

/** The athlete opened the plan: the "plan is ready" banner can go away. */
export async function markReplyRunSeen(
  weekSessionId: string,
): Promise<{ run: ReplyRun | null }> {
  return readJson(
    await fetch(
      `/api/weeks/${encodeURIComponent(weekSessionId)}/reply-run/seen`,
      { method: "POST" },
    ),
  );
}

export type HomeBanner = {
  kind: string;
  text: string;
  cta:
    | { label: string; href: string }
    | { label: string; action: "retry_reply_run" }
    | null;
};

export type HomeDayState =
  | "done"
  | "today"
  | "upcoming"
  | "rest"
  | "missed"
  | "unknown"
  /** Coach Cade wrote the day but Cadence could not read it, or the plan left the date out. */
  | "not_filed";

export type HomeWeekDay = {
  date: string;
  dayType: PrescribedDay["dayType"] | null;
  plannedDistanceM: number | null;
  /** Planned seconds, when the day's run is prescribed by time. */
  plannedDurationS?: number | null;
  actualDistanceM: number | null;
  state: HomeDayState;
  isToday: boolean;
  /** False when Cadence has no structure for the day; absent reads as parsed. */
  parsed?: boolean;
  /** On a day Cadence could not read, Coach Cade's line; null when the plan gave none. */
  line?: string | null;
};

export type HomeRead = {
  weekSessionId: string | null;
  isoWeek: string | null;
  banner: HomeBanner | null;
  today: PrescribedDay | null;
  week: HomeWeekDay[];
  totals: {
    actualDistanceM: number;
    plannedDistanceM: number;
    /** Planned seconds on days with a duration and no distance. */
    plannedDurationS?: number;
  };
  units: UnitPreference;
  tempoUnavailable: boolean;
};

export async function fetchHome(): Promise<HomeRead> {
  return readJson(await fetch("/api/home"));
}

/** Where the athlete is in the week's loop; only the parts a page reads. */
export type LoopStatusRead = {
  phase:
    | "setup_incomplete"
    | "needs_onboarding"
    | "onboarding_review"
    | "needs_check_in"
    | "needs_plan"
    | "mid_week"
    | "week_ending";
};

export async function fetchLoopStatus(): Promise<LoopStatusRead> {
  return readJson(await fetch("/api/loop-status"));
}

/** Fetch one JSON section of a week's report (summary, zones, run-by-run, trends, notable). */
export async function fetchRecapSection<T>(
  weekSessionId: string,
  section: "summary" | "zones" | "run-by-run" | "trends" | "notable",
): Promise<T> {
  return readJson(
    await fetch(
      `/api/weeks/${encodeURIComponent(weekSessionId)}/recap/${section}`,
    ),
  );
}

/** Put back what an applied note replaced; the old text becomes a new version. */
export async function undoDossierProposal(
  id: number,
): Promise<{ proposal: DossierProposal; version: DossierVersion }> {
  return readJson(
    await fetch(`/api/dossier/proposals/${id}/undo`, { method: "POST" }),
  );
}

/** Notes the coach applied (or the athlete undid), newest first. */
export async function fetchDossierChanges(): Promise<{
  changes: DossierProposal[];
}> {
  return readJson(await fetch("/api/dossier/changes"));
}

/** What the athlete is training for; "return" is getting back to running. */
export type GoalKind = "race" | "speed" | "fitness" | "return";

/** The current goal's kind, or null when no goal is stored. */
export async function fetchGoalKind(): Promise<GoalKind | null> {
  const res = await fetch("/api/goal");
  if (res.status === 404) return null;
  const body = await readJson<{ goal: { kind: GoalKind } }>(res);
  return body.goal.kind;
}

/** The current goal as stored, with the sentence Settings shows (null when it cannot be worded). */
export type StoredGoal = {
  id: number;
  goal: TrainingGoal;
  source: "onboarding" | "settings";
  createdAt: string;
  sentence: string | null;
};

/** The current goal, or null when none is stored yet (before the first answers). */
export async function fetchGoal(): Promise<StoredGoal | null> {
  const res = await fetch("/api/goal");
  if (res.status === 404) return null;
  return readJson<StoredGoal>(res);
}

/**
 * Store a new goal. Once About you exists, the API also tells Coach Cade "My goal is now …"
 * through Fix something in the same request and returns that note; null before then.
 */
export async function saveGoal(goal: TrainingGoal): Promise<
  StoredGoal & {
    correction: {
      athleteMessage: ThreadMessage;
      coachMessage: ThreadMessage;
      dossierProposal: DossierProposal;
      dossierVersionId: number;
    } | null;
  }
> {
  return readJson(
    await fetch("/api/goal", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal }),
    }),
  );
}
