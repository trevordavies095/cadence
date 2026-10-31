# Demo instance

A season of sample data for screenshots and for trying Cadence without Tempo or an API key. The athlete, Johnny Morrissey, is fictional: a recreational marathoner training for the (also fictional) Lakeshore Marathon on Sun Nov 15 2026, aiming for 3:30. The demo is frozen at Wed Oct 14 2026, 7:30 pm New York, in week 11 of the block.

## Run it

```bash
scripts/demo.sh up
```

This backs up the local `ai_coach` database to `.scratch/backups/`, replaces it with [`snapshot.sql`](snapshot.sql), and starts the stack with the clock pinned, the sample running log mounted and the stub model. The app is at http://localhost:3001.

Ports are taken? Set `POSTGRES_HOST_PORT`, `API_HOST_PORT` and `FRONTEND_HOST_PORT` (for example `15433`, `15002`, `13001`).

## What is here

| File | What it is |
|---|---|
| `generate-tempo-export.mjs` | Writes `tempo-export.zip`, Johnny's running log: four easy base weeks from Jul 6, then the block from Aug 3 to the morning of Oct 14, with an Achilles setback in weeks 6 to 8. Deterministic: reruns give a byte-identical zip. |
| `tempo-export.zip` | The generated log, mounted into the API by `docker-compose.demo.yml`. |
| `generate-season-export.mjs`, `lib/tempoExport.mjs` | The same export machinery for any season script; used for the replay seasons in `api/tests/fixtures/seasons/`. |
| `athlete-script.json` | Everything Johnny says: onboarding answers, ten weekly check-ins, and the week 11 chat. |
| `build.mjs`, `lib/` | Plays the script through the real API and writes the snapshot. |
| `snapshot.sql` | The published season, produced by a live build. |

## Rebuild it

Rebuild when the coach prompts, the screens or the schema change enough that the snapshot no longer shows the app as it is.

```bash
read -s ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY
scripts/demo.sh build --live
```

The build plays onboarding, weeks 1 to 10 (check-in, then Coach Cade's read and plan) and the week 11 chat, restarting the API with the clock moved for each step. Effort is `medium` for the early weeks and `xhigh` for weeks 9 to 11, which the screenshots show. It takes about half an hour and a few dozen model calls.

- `--from-week N` resumes from the checkpoint taken after week N-1 (in `.scratch/demo-checkpoints/live/`), so a bad week does not cost the whole season.
- Without `--live` it runs on the stub, for free, and writes the gitignored `snapshot.stub.sql`. Use it to test changes to the build.
- A rejected model reply (for example a safety notice over the length limit) is retried twice before the build stops.

Before it writes the snapshot, the build:

- checks every model call came from the provider it was meant to use;
- moves each stored timestamp from the time of the build into the fictional week it belongs to;
- deletes the saved Anthropic key and Tempo credentials, keeping the model call log;
- fails if the dump contains an Anthropic key, the data protection key, your home directory or your user name.

Then read the season before publishing it: every weekly read, the chat, About you and the note cards.

### Hand edits in the current snapshot

Rebuilt live on 2026-10-28 for the reading-flow changes (headline, Watching, Your questions, day notes, plan-change cards, run card splits). Three words in the plan rows were edited; the model call log keeps what the model wrote:

- Two day notes: "Standard mid-week easy" changed to "Standard midweek easy".
- One answer, in the week of Sep 28: "Your physio prescribed them" changed to "Your physio set them".

## Screenshots

With the demo running:

```bash
cd frontend
npm run demo:shots
```

This writes the light set to `docs/images/` and the dark set to `docs/images/dark/`, 1440 px wide at 2x, with the browser clock pinned to the demo evening. The README uses the dark set. LinkedIn crops (`linkedin-*.png`, 1200 × 627) are written alongside and gitignored. `DEMO_URL` points the script at another address; `DEMO_SHOTS_THEMES=light` or `dark` takes one set.
