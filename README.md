# Cadence

Cadence is a self-hosted running coach. **Coach Cade** reads your training from Tempo (a privacy-first running log), writes a weekly recap, talks the week through with you, and plans the next one. Everything lives in your own Postgres database. The only thing that leaves your machine is a lean, redacted packet sent to the model you choose (Anthropic, with your own API key), and you can see exactly what was sent.

![Cadence Home: today's run, this week's plan, and a note from Coach Cade](docs/images/dark/hero.png)

- Weekly loop: check-in, recap, coach analysis, next week's plan
- A living "About you" profile that Coach Cade updates only with your approval
- Mid-week chat, with a Tempo workout attached if you like
- Works offline with a stub model and a Tempo export zip, so you can try it without spending anything
- No login: run it on your home network or behind a VPN

## Try the demo

See Cadence with a season of sample data: Johnny Morrissey, a fictional runner ten weeks into a marathon block, frozen on the evening of Wed Oct 14 2026. No Tempo instance or API key needed.

```bash
git clone https://github.com/trevordavies095/cadence.git
cd cadence
scripts/demo.sh up
```

Open http://localhost:3001. The weekly reports, Coach Cade's replies and About you were produced by the real app and the live model from Johnny's runs and check-ins. New messages you send in the demo are answered by the offline stub, not the live coach.

**The demo replaces the data in your local Cadence database.** It backs the database up to `.scratch/backups/` first and stops if the backup fails, but don't point it at an instance you use. How the demo is built: [`demo/README.md`](demo/README.md).

## Get started

You need Docker (with Compose). To use a live coach you also need a Tempo instance and an Anthropic API key; neither is needed to look around.

```bash
git clone https://github.com/trevordavies095/cadence.git
cd cadence
cp .env.example .env
# set DATA_PROTECTION_SECRET_KEY in .env (openssl rand -base64 32)
docker compose up -d --build
./scripts/smoke.sh
```

Open http://localhost:3001, accept the disclaimer, and follow the first-run onboarding. Add your Tempo address and API key and your Anthropic key under **Settings**. Until you set `LLM_PROVIDER=anthropic` the coach is a stub that needs no key.

| Service  | URL                          |
|----------|------------------------------|
| Frontend | http://localhost:3001        |
| API      | http://localhost:5002        |
| Health   | http://localhost:5002/health |
| Postgres | localhost:5433 (`ai_coach`)  |

Ports are offset from Tempo's defaults (3000 / 5001 / 5432) so both can run side by side. Stop with `docker compose down`.

To run it on a home server, use `docker-compose.homelab.yml` with `.env.homelab.example` (copy it to `.env.homelab`): `docker compose -f docker-compose.homelab.yml --env-file .env.homelab up -d --build`. It keeps Postgres and the API on the internal network and exposes only the web page.

## What it costs

Cadence is free. The live coach uses your own Anthropic API key, so you pay Anthropic per call. Rough figures on the defaults (Opus 4.7, effort `xhigh`):

| Usage | Per week |
|-------|----------|
| Weekly reply only | ~$0.30 |
| Reply + a few chat messages | ~$1 |
| Chatting most days | ~$2 |

## How it works

Each week follows the same loop. Coach Cade builds the recap from your Tempo data, you add a short check-in, and the coach replies with an analysis and next week's plan. During the week you can chat and attach a run. Anything worth remembering is proposed as a change to "About you", and nothing is saved until you accept it.

```mermaid
stateDiagram-v2
    [*] --> Onboarding
    Onboarding --> CheckIn

    CheckIn --> Plan: weekly recap + reply
    Plan --> MidWeek
    MidWeek --> ReviewNotes: end of week
    ReviewNotes --> CheckIn: next week

    ReviewNotes --> EndOfBlock: goal race done
    EndOfBlock --> [*]
```

| State | What happens |
|---|---|
| **Onboarding** | A short interview, prefilled from Tempo, drafts your "About you" profile |
| **CheckIn** | From Saturday on, you answer a few questions about the week; the recap is built from Tempo |
| **Plan** | Coach Cade analyses the week and plans the next one, day by day |
| **MidWeek** | Chat, attach a run, and get feedback; the plan is adjusted if needed |
| **ReviewNotes** | Coach Cade's suggested changes to "About you" wait for you to accept or reject them |

**Your week.** The report built from your running log and your check-in: mileage against recent weeks, heart rate zones, and every run with what you said about it.

![Your week: mileage, heart rate zones and runs for Oct 5 – 11](docs/images/dark/your-week.png)

**The plan.** Coach Cade's read opens with its headline and what it is watching, with the answers to your questions and the full read a click away. Each day carries the reason for its session.

![Plan: Coach Cade's headline and what it is watching, above this week's days](docs/images/dark/plan.png)

**Coach Cade.** Chat during the week and attach a run. The run card shows its numbers and splits, and Coach Cade says what they mean. When the week changes, the changed days appear under the reply.

![Coach Cade: a run attached to a message, with its splits a click away, and Coach Cade's reply](docs/images/dark/coach-chat.png)

**About you.** What Coach Cade knows about you. Changes it suggests wait for **Looks right**, and you can fix anything in your own words.

![About you: a tidy-up waiting for approval](docs/images/dark/about-you.png)

<details>
<summary>Detailed lifecycle</summary>

Onboarding, the weekly loop with its mid-week sub-loop, and the race and end-of-block flows. The "About you" audit is a variant of the review step, not a separate state.

```mermaid
stateDiagram-v2
    [*] --> Onboarding

    state Onboarding {
        direction LR
        Intro --> Questions
        Questions --> TempoPrefill
        TempoPrefill --> DraftAboutYou
        DraftAboutYou --> Accepted
    }

    Onboarding --> Week

    state "Weekly loop" as Week {
        CheckIn --> Plan: recap + reply
        Plan --> MidWeek: analysis + plan + suggested notes

        state MidWeek {
            Idle --> Feedback: run attached / question
            Feedback --> Idle: adjust rest of week
        }

        MidWeek --> ReviewNotes: end of week
        ReviewNotes --> CheckIn: accepted or rejected
    }

    note right of ReviewNotes
        Every few weeks: "About you" audit
    end note

    Week --> Race: final week

    state Race {
        direction LR
        RacePlan --> Taper
        Taper --> RaceDay
        RaceDay --> PostRace
    }

    Race --> Week: more races in block
    Race --> EndOfBlock: goal race done
    EndOfBlock --> [*]
```

</details>

## Stack

- **API**: Hono (Node 22), PostgreSQL 16
- **Frontend**: Next.js 16, React 19, TypeScript
- **Deploy**: Docker Compose

## Local development

Run Postgres in Docker and the two apps on the host:

```bash
docker compose up -d postgres

# API (http://localhost:5001; set PORT=5002 to match Compose)
cd api
npm install
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ai_coach \
  DATA_PROTECTION_SECRET_KEY=change-me-local-dev-only-not-for-prod \
  npm run dev

# Frontend (second terminal)
cd frontend
npm install
npm run dev -- -p 3001
```

The schema migrates on API startup.

To develop without a Tempo instance, point the API at a Tempo export zip with `TEMPO_EXPORT_PATH` (see [Offline Tempo export](#offline-tempo-export)).

## Tests

API tests need Postgres up and a database whose name ends in `_test` (the suite deletes all tables and refuses any other name):

```bash
docker exec cadence-postgres psql -U postgres -c 'CREATE DATABASE ai_coach_test'   # once
cd api
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ai_coach_test npm test
```

Browser tests (Playwright) drive the real UI against the stub model, the mini Tempo export and a pinned Sunday clock. They boot their own API (port 5102) and frontend (port 3101) against a throwaway `ai_coach_e2e` database, which is dropped and recreated on every run:

```bash
cd frontend
npm install
npx playwright install chromium   # once
npm run e2e
```

Set `E2E_DATABASE_URL` to use a different server and `E2E_CLOCK_NOW` to pin another moment. CI (`.github/workflows/ci.yml`) runs both suites on every pull request and on pushes to `develop` and `main`.

## Configuration

| Setting | Env | Notes |
|---------|-----|--------|
| Coach DB | `DATABASE_URL` | Own database (`ai_coach`), not Tempo’s |
| Database connect timeout | `DATABASE_CONNECT_TIMEOUT_MS` | How long to wait for a database connection, in ms. Default `10000`. Invalid value stops the API at startup |
| Database idle timeout | `DATABASE_IDLE_TIMEOUT_MS` | How long an unused connection stays open, in ms. Default `300000` (5 min), so pages after a long coach reply reuse warm connections |
| API port | `PORT` | Default `5001` (Compose maps host `5002`) |
| CORS | `CORS_ORIGIN` | Browser origin allowed by the API (default `http://localhost:3001`) |
| Frontend → API | `API_SERVICE_URL` | Used by Next rewrites inside Compose (`http://api:5001`) |
| Secret wrapping key | `DATA_PROTECTION_SECRET_KEY` | HKDF → AES-256-GCM for Tempo + Anthropic keys at rest |
| Dev clock | `DEV_CLOCK_NOW` | ISO instant; fixes “now” when not `NODE_ENV=production`, or in production when `CADENCE_DEMO=1`. Read once at startup |
| Demo mode | `CADENCE_DEMO` | `1` for the demo instance only: honours `DEV_CLOCK_NOW` in the production image, hides export runs after that clock, and labels Settings as sample data. Set by `scripts/demo.sh` |
| Host ports | `POSTGRES_HOST_PORT`, `API_HOST_PORT`, `FRONTEND_HOST_PORT` | Compose host ports, default `5433` / `5002` / `3001` |
| Athlete timezone | `ATHLETE_TIMEZONE` | IANA name (e.g. `America/New_York`), default `UTC`. One timezone for every route and page: current week, week boundaries, loop status. An explicit `?timezone=` still overrides. An invalid name stops the API at startup. |
| LLM provider | `LLM_PROVIDER` | `stub` (default; offline, CI) or `anthropic` (live, uses the encrypted Anthropic key) |
| Model | `ANTHROPIC_MODEL` | Live model id (default `claude-opus-4-7`) |
| Thinking effort | `ANTHROPIC_EFFORT` | `low` \| `medium` \| `high` \| `xhigh` \| `max` (default `xhigh`). Live coach calls use adaptive thinking (summarized) at this effort; an invalid value stops the API at startup. |
| Coach call cap | `ANTHROPIC_TIMEOUT_MS` | Overall cap per live coach call, default `900000` (15 min). Calls stream; a call also aborts after 60 s with no data. |
| Proxy timeout | `FRONTEND_PROXY_TIMEOUT_MS` | Frontend (Next) → API proxy timeout, default `960000` (16 min); keep it above the coach call cap |
| App version | `APP_VERSION` | Stamped on every LLM call log row. `npm run dev` sets it to the git SHA; falls back to `CADENCE_GIT_COMMIT`, then `dev` |
| Tempo export (offline) | `TEMPO_EXPORT_PATH` | Absolute path to a Tempo full-export `.zip`. When set, TempoPort reads workouts/splits/time-series from the zip instead of live Tempo HTTP (no API key). GPS/route geometry is never exposed on coach APIs. Keep exports gitignored (e.g. `.scratch/`). |

Copy [`.env.example`](./.env.example) to `.env` for optional compose overrides.

### Offline Tempo export

Point the API at a local Tempo export to develop/recap without a running Tempo instance:

```bash
# From a Tempo export downloaded to a gitignored path, e.g.:
export TEMPO_EXPORT_PATH="$PWD/.scratch/tempo-export.zip"
cd api && npm run dev
```

`GET /tempo/workouts`, `GET /tempo/workouts/:id`, `GET /tempo/settings`, `GET /tempo/shoes`, and `GET /tempo/best-efforts` then serve from the zip (same TempoPort seam as live HTTP). First load streams the zip and caches an in-memory index (raw FIT/GPX blobs and route GeoJSON are discarded while streaming).

**CI / tests** use the committed scrubbed mini pack [`api/tests/fixtures/tempo-export-mini.zip`](./api/tests/fixtures/tempo-export-mini.zip) (few workouts, no route geometry, no media, no identity PII) — not the full `.scratch/` export. Rebuild or slice from a real export: [`api/tests/fixtures/README.md`](./api/tests/fixtures/README.md).

## API surfaces

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness — process is accepting HTTP |
| GET | `/ready` | Readiness — Postgres reachable (503 if not) |
| GET | `/disclaimer` | Disclaimer text + acceptance status |
| POST | `/disclaimer/accept` | Persist first-run Accept (idempotent) |
| GET | `/privacy` | Privacy transparency copy (sent vs local) |
| GET | `/settings` | Tempo + Anthropic summary — **403** until disclaimer accepted |
| GET/PUT/DELETE | `/settings/tempo` | Encrypted Tempo base URL + API key (GET masked only) |
| GET/PUT/DELETE | `/settings/anthropic` | Encrypted Anthropic API key (GET masked only) |
| GET | `/settings/last-packet` | Last redacted outbound model packet summary + JSON — **403** until accepted |
| POST | `/packet` | Assemble lean redacted model packet (current dossier + last N prior week summaries/plans + focus-week thread + Tempo attachments); persists last-packet for transparency — **403** until accepted. N via `recentHistoryLimit` or `PACKET_RECENT_HISTORY_LIMIT` (default 4). Archived mid-week chatter is excluded. |
| GET | `/tempo/workouts` | List workouts via TempoPort (live HTTP or `TEMPO_EXPORT_PATH` zip; query: page, pageSize, startDate, endDate, …) — **403** until accepted; GPS/route stripped |
| GET | `/tempo/workouts/:id` | Get one workout (splits + time-series when available; no GPS/route) — **403** until accepted |
| GET | `/tempo/settings` | Athlete unit preference + HR zones (+ default shoe id) via TempoPort — **403** until accepted |
| GET | `/tempo/shoes` | Shoes list (`?status=active\|retired\|all`, default active) — **403** until accepted |
| GET | `/tempo/best-efforts` | Best efforts (`{ distances: [...] }`) via TempoPort — **403** until accepted |
| GET | `/thread` | List coach thread messages — **403** until accepted (`?weekSessionId=`) |
| POST | `/thread/messages` | Post an athlete message (optional `weekSessionId`) |
| POST | `/weeks/:weekSessionId/chat` | Mid-week free chat on the current week (optional `attachmentWorkoutId` via TempoPort; stores coaching summary, no GPS). Phrases like “audit my settings” create an audit/trim soft-gate proposal — **403** until accepted; **409** if week archived |
| GET | `/dossier` | Current dossier version (`current: null` if none) + audit cadence meta (`lastAuditAt` / `nextAuditDueAt` / `due`) |
| PUT | `/dossier` | Append a new dossier version |
| GET | `/dossier/versions` | List version ids (newest first) |
| GET | `/dossier/versions/:id` | Read a specific version |
| GET | `/dossier/proposals` | List pending soft-gate dossier proposals |
| POST | `/dossier/proposals` | Create a pending proposal (`summaryBullets` + `proposedBody`) |
| POST | `/dossier/proposals/:id/accept` | Accept → new dossier version; clears that pending proposal (audit proposals also stamp `lastAuditAt` / next due) |
| POST | `/dossier/proposals/:id/reject` | Reject → clears pending; dossier unchanged |
| POST | `/dossier/corrections` | Athlete fix/add note → stub/live LLM rewrite as pending soft-gate proposal (+ thread messages); optional `weekSessionId` |
| GET | `/dossier/audit` | Dossier audit cadence meta only (`lastAuditAt`, `nextAuditDueAt`, `due`, `intervalWeeks`) |
| POST | `/dossier/audits` | Coach-initiated audit/trim soft-gate proposal when due (or `force: true`); the LlmPort (stub or live) folds coach updates into Current Status |
| GET | `/onboarding` | Onboarding interview gate (`needs_onboarding` \| `ready` \| `complete`) + questionnaire + Tempo prefills — **403** until accepted |
| POST | `/onboarding/answers` | Persist onboarding answers and the `goal` record (the API writes the goal sentence and a goal row, source `onboarding`); the LlmPort (stub or live) drafts the dossier v1 soft-gate proposal + coach thread summary — **403** until accepted |
| GET | `/week` | Current ISO week Mon–Sun for injectable/dev clock (`?timezone=`, default `ATHLETE_TIMEZONE`) |
| POST | `/weeks/current` | Get-or-create week session for clock “now” (`?timezone=`, default `ATHLETE_TIMEZONE`). Archives only weeks that started *before* it; a week that becomes current is un-archived — **403** until accepted |
| GET | `/weeks` | List week sessions newest-first — **403** until accepted |
| GET | `/loop-status` | This-week dashboard state: `needs_check_in` (Saturday onward) → `needs_plan` (check-in done, next week has no plan) → `week_ending` / `mid_week`; `hasPlan` is **next** week's plan, `currentWeekHasPlan` this week's — **403** until accepted |
| POST | `/week/reply` | Weekly reply for the **reviewed** week N: analysis posts in N's thread, the plan is for **N+1** and is saved on N+1's session. Needs the check-in finished or skipped (**409** otherwise) and no pending dossier proposal (**409** `dirty_dossier`) |
| GET | `/weeks/:weekSessionId/prescribed` | Plan stored on that week session |
| GET | `/weeks/:weekSessionId/prescribed/next` | `{ weekSession, prescribed }` for the following week (`prescribed: null` until planned); creates that session if missing, never archives |
| GET | `/llm-calls` | LLM call log, newest first, summaries only (no bodies). Filters: `weekSessionId`, `operation`, `outcome` — **403** until accepted |
| GET | `/llm-calls/:id` | One logged call in full: request, raw response, outcome, usage (incl. `thinkingTokens`), latency |
| GET | `/llm-calls/export` | Every logged call as NDJSON (`application/x-ndjson`), oldest first |

The weekly recap, prescribed-week patch, and other week-loop routes are not all listed here; see the routes under `api/src/routes/`.

Without acceptance, the UI redirects gated pages to `/disclaimer`. GET responses for connection settings never include plaintext API keys (only `configured` + `maskedKey`).

## Smoke test

After `docker compose up -d --build`, `./scripts/smoke.sh` checks the API `/health` and `/ready`, the frontend `/health`, and the Next rewrite to the API.

## License

[AGPL-3.0](./LICENSE). If you run a modified version of Cadence as a network service, you must make your changes available to its users.
