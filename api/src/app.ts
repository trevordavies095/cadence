import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolveAthleteTimezone } from "./clock/athleteTimezone.js";
import { createDefaultClock, type Clock } from "./clock/clock.js";
import {
  resolveDefaultLlmPort,
  type LlmPort,
} from "./llm/index.js";
import {
  createLlmCallLogRoutes,
  createPostgresLlmCallRecorder,
  type LlmCallRecorder,
} from "./llmCallLog/index.js";
import { disclaimerRoutes } from "./routes/disclaimer.js";
import { createDossierAuditRoutes } from "./routes/dossierAudit.js";
import { createDossierCorrectionRoutes } from "./routes/dossierCorrection.js";
import { createDossierRoutes } from "./routes/dossier.js";
import { createGoalRoutes } from "./routes/goal.js";
import { healthRoutes } from "./routes/health.js";
import { createHomeRoutes } from "./routes/home.js";
import { createOnboardingRoutes } from "./routes/onboarding.js";
import { createPacketRoutes } from "./routes/packet.js";
import { createPrescribedRoutes } from "./routes/prescribed.js";
import { privacyRoutes } from "./routes/privacy.js";
import { createRecapDepthRoutes } from "./routes/recapDepth.js";
import { createRecapRoutes } from "./routes/recap.js";
import { createRecapSubjectiveRoutes } from "./routes/recapSubjective.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createTempoRoutes } from "./routes/tempo.js";
import { createMidWeekChatRoutes } from "./routes/midWeekChat.js";
import { createThreadRoutes } from "./routes/thread.js";
import { createLoopStatusRoutes } from "./routes/loopStatus.js";
import { createWeekRoutes } from "./routes/week.js";
import { createReplyRunRoutes } from "./routes/replyRun.js";
import {
  createReplyRunner,
  createWeeklyReplyRoutes,
} from "./routes/weeklyReply.js";
import {
  createExportTempoPort,
  resolveTempoExportPath,
} from "./tempo/exportZip.js";
import { resolveLlmProvider, type RuntimeSources } from "./settings/sources.js";
import { createLiveTempoPort } from "./tempo/liveHttp.js";
import type { TempoPort } from "./tempo/port.js";

export type CreateAppOptions = {
  corsOrigin?: string;
  /** Injectable clock for ISO week / future week-loop code. */
  clock?: Clock;
  /** IANA athlete timezone; defaults to ATHLETE_TIMEZONE (else UTC). */
  athleteTimezone?: string;
  /** Override DATA_PROTECTION_SECRET_KEY for tests. */
  dataProtectionKey?: string;
  /** Injectable Tempo reads (tests / export stub). Defaults to live HTTP. */
  tempoPort?: TempoPort;
  /** Injected fetch for the default live TempoPort (tests). */
  tempoFetch?: typeof globalThis.fetch;
  /**
   * Path to a Tempo export zip. When set (or via TEMPO_EXPORT_PATH), the default
   * TempoPort is export-backed instead of live HTTP.
   */
  tempoExportPath?: string;
  /**
   * Injectable LLM. Defaults from LLM_PROVIDER (`stub` | `anthropic`);
   * stub remains the CI default.
   */
  llmPort?: LlmPort;
  /** Injected fetch for the default Anthropic LlmPort (tests). */
  llmFetch?: typeof globalThis.fetch;
  /** LLM call log sink (tests inject a failing one). Defaults to Postgres. */
  llmCallRecorder?: LlmCallRecorder;
  /**
   * Override the sources Home and Settings report (tests). Defaults to what the app
   * wired: injected ports count as saved connections.
   */
  sources?: RuntimeSources;
};

export function createApp(options?: CreateAppOptions): Hono {
  const corsOrigin =
    options?.corsOrigin ?? process.env.CORS_ORIGIN ?? "http://localhost:3001";
  const clock = options?.clock ?? createDefaultClock();
  const athleteTimezone = options?.athleteTimezone ?? resolveAthleteTimezone();
  // Prefer an injected port. Else: explicit tempoExportPath, else env zip —
  // but if tests inject tempoFetch for the live adapter, ignore TEMPO_EXPORT_PATH
  // so a shell leftover from manual E2E does not load a huge athlete zip.
  const exportPath = options?.tempoPort
    ? undefined
    : options?.tempoExportPath !== undefined
      ? options.tempoExportPath.trim() || undefined
      : options?.tempoFetch
        ? undefined
        : resolveTempoExportPath();
  const tempoPort =
    options?.tempoPort ??
    (exportPath
      ? createExportTempoPort({
          exportPath,
          // Demo instance: the pinned clock may sit before the export's last run.
          ...(process.env.CADENCE_DEMO === "1"
            ? { asOf: () => clock.now() }
            : {}),
        })
      : createLiveTempoPort({
          dataProtectionKey: options?.dataProtectionKey,
          fetchImpl: options?.tempoFetch,
        }));
  const llmCallRecorder =
    options?.llmCallRecorder ?? createPostgresLlmCallRecorder();
  const llmPort =
    options?.llmPort ??
    resolveDefaultLlmPort({
      dataProtectionKey: options?.dataProtectionKey,
      fetchImpl: options?.llmFetch,
      recorder: llmCallRecorder,
    });

  // An export or the stub model needs no saved connection (#6).
  const sources: RuntimeSources = options?.sources ?? {
    tempo: exportPath ? "export" : "connection",
    model: options?.llmPort ? "anthropic" : resolveLlmProvider(),
    demo: process.env.CADENCE_DEMO === "1",
  };

  const replyRunner = createReplyRunner({
    llmPort,
    tempoPort,
    clock,
    athleteTimezone,
    llmCallRecorder,
  });

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: corsOrigin,
    }),
  );

  app.route("/", healthRoutes);
  app.route("/", disclaimerRoutes);
  app.route("/", privacyRoutes);
  app.route("/", createSettingsRoutes({ dataProtectionKey: options?.dataProtectionKey, sources }));
  app.route("/", createTempoRoutes({ tempoPort }));
  app.route("/", createThreadRoutes({ clock }));
  app.route("/", createLlmCallLogRoutes({ recorder: llmCallRecorder }));
  app.route("/", createDossierCorrectionRoutes({ llmPort, clock }));
  app.route("/", createDossierAuditRoutes({ llmPort, clock }));
  app.route("/", createDossierRoutes({ clock }));
  app.route("/", createOnboardingRoutes({ tempoPort, llmPort, clock }));
  app.route("/", createGoalRoutes({ clock, llmPort }));
  app.route("/", createWeekRoutes(clock, athleteTimezone, tempoPort));
  app.route("/", createLoopStatusRoutes(clock, athleteTimezone, sources));
  app.route("/", createHomeRoutes({ clock, athleteTimezone, tempoPort, sources }));
  app.route("/", createPrescribedRoutes({ tempoPort, clock }));
  app.route("/", createRecapRoutes({ tempoPort }));
  app.route("/", createRecapDepthRoutes({ tempoPort }));
  app.route("/", createRecapSubjectiveRoutes({ tempoPort, runner: replyRunner, clock }));
  app.route("/", createPacketRoutes({ tempoPort, clock, athleteTimezone }));
  app.route("/", createWeeklyReplyRoutes({
      llmPort,
      tempoPort,
      clock,
      athleteTimezone,
      llmCallRecorder,
      runner: replyRunner,
    }));
  app.route("/", createReplyRunRoutes({ runner: replyRunner, clock }));
  app.route("/", createMidWeekChatRoutes({ llmPort, tempoPort, clock, llmCallRecorder }));

  return app;
}
