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
  /** The model call that wrote this coach message; links a reply to its run. */
  llmCallId?: string | null;
  /** The note this reply produced, as it stands now; null when it produced none. */
  dossierProposal?: ThreadNote | null;
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
  distanceM: number;
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

export type PrescribedWeekRecord = {
  weekSessionId: string;
  plan: PrescribedWeek;
  analysis: string;
  settingsProposalBullets: string[] | null;
  safetyCallouts: SafetyCallout[] | null;
  /** The parts of the read laid out on their own; null on plans made before them. */
  readSections?: ReadSections | null;
  createdAt: string;
  updatedAt: string;
};

/** The headline Coach Cade opens the read with (flags and answers come later). */
export type ReadSections = {
  headline: string;
};

export type PrescribedWeekArtifact = {
  kind: "prescribed_week";
  weekSessionId: string;
  plan: PrescribedWeek;
  safetyCallouts: SafetyCallout[];
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
};

export type LastOutboundPacket = {
  savedAt: string;
  summary: LastOutboundPacketSummary;
  packet: unknown;
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

/** Plan for the ISO week after `weekSessionId` (null until one is generated). */
export async function fetchNextWeekPrescribed(
  weekSessionId: string,
): Promise<{
  weekSession: WeekSession;
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
  answers: OnboardingAnswers,
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
    anthropicConfigured: boolean;
    systemStance: "coach_running_no_diagnose";
  };
}> {
  return readJson(
    await fetch("/api/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        weekSessionId ? { answers, weekSessionId } : { answers },
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
  per_run: { rpe: string; felt: string; pain: string };
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
  | "unknown";

export type HomeWeekDay = {
  date: string;
  dayType: PrescribedDay["dayType"] | null;
  plannedDistanceM: number | null;
  actualDistanceM: number | null;
  state: HomeDayState;
  isToday: boolean;
};

export type HomeRead = {
  weekSessionId: string | null;
  isoWeek: string | null;
  banner: HomeBanner | null;
  today: PrescribedDay | null;
  week: HomeWeekDay[];
  totals: { actualDistanceM: number; plannedDistanceM: number };
  units: UnitPreference;
  tempoUnavailable: boolean;
};

export async function fetchHome(): Promise<HomeRead> {
  return readJson(await fetch("/api/home"));
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
