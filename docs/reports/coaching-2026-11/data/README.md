# Coaching benchmark data, November 2026

The raw data behind [`../../coaching-2026-11.md`](../../coaching-2026-11.md): every weekly read six model configurations wrote for 14 hard weeks, three times each; every score a model judge gave them; the judge's two calibrations against a certified running coach; the run that measured asking once more when a plan rule trips; the first live coaching gate; and the blind form the coach and a second reviewer filled in.

Everything here can be checked against the report, rescored with another judge, or reanalysed without a single paid call. All athletes, races and seasons are fictional.

## Where it came from

The runs were made with the scripts in `api/scripts/` (see the report's "How to rerun") into a working folder outside the repo, then copied here by `npm run replay:export-coaching` (`api/scripts/export-coaching-data.ts`), which scrubs every file on the way:

- the repo's absolute path is made repo-relative (so a path reads `api/tests/fixtures/...` or `.scratch/benchmark-coaching/...`), and any other home folder becomes `<local>`;
- the self-hosted server's LAN address becomes `<macbook>`;
- anything shaped like an API key or an email address is replaced.

Paths inside files still name the working folder: `.scratch/benchmark-coaching/<x>` in any file is `<x>` in this folder, and `.scratch/benchmark-after/gate-first-live/` is `gate-first-live/`. Nothing else in the files was changed.

**Left out:** everything from the review form: the reviewers' answers (ratings, picks, unsafe ticks and comments), the answer key built from them, the form itself and the comparison of the two reviewers. They are private; the report gives only totals, and the calibration files keep their summary numbers without the case-by-case picks. Also left out: the stopped Opus 5.5 at `max` attempt (2.1 MB of mostly failed replies; the report gives its numbers), the analysis made before the judge (superseded by `baseline/analysis-coaching/`), dry runs on the offline stub, and the maintainer's working notes.

## Layout

| Folder | What it holds |
|---|---|
| `baseline/seasons/`, `baseline/snapshot/` | The baseline: one folder per configuration, 39 season replies (13 weeks x 3 repeats) and 3 replies for the demo athlete's Achilles week (snapshot/06), rules retry off. |
| `baseline/analysis-coaching/` | The analysis of the baseline with the judge's scores: `analysis.md` (readable; section 9 is coaching), `analysis.json` (the same, as data), `replies.csv` (one row per attempt). |
| `rules-retry/seasons/`, `rules-retry/snapshot/`, `rules-retry/analysis/` | gpt-oss-20b (3 repeats) and the control (1 repeat) with the rules retry on, and their analysis. |
| `judge/` | The judge's first calibration (rubric checks 1 to 6), which failed: `calibration.md`, `calibration.json`, and its 42 scores of the coach's drafts. |
| `judge-2/` | The second calibration (checks 1 to 8), which passed, and the judge's scores of all 252 baseline replies under `baseline-scores/anthropic--claude-opus-5-5--high/<root>/<configuration>/`. |
| `judge-retry/` | The judge's scores of the rules-retry run, with a copy of the second calibration. |
| `gate-first-live/coaching/` | The first live coaching gate: the control's 14 replies, their scores, a copy of the calibration and the analysis. |
| `probe/` | One reply each from Haiku, Sonnet and Opus 5.5 at `xhigh`, run before the round to choose efforts (Haiku's hit the output cap). |
| `models.json` | The Anthropic models and the efforts each listed, from the API on 2026-11-03. |

The inputs are in the repo, not here: the season packets in `api/tests/fixtures/seasons/season-packets/` (the weekly packet each season week sent the model, which `source` in a reply names), the hard set in `api/tests/fixtures/hard-set.json`, the athlete introductions in `api/tests/fixtures/coach-packet-athletes.json`, the gate's band in `api/tests/fixtures/coaching-band.json`, and the rubric in `docs/coaching-rubric.md`. The Achilles week is the demo athlete's call log, in the demo snapshot.

Configuration folders are named `<provider>--<model>--<effort>`. The control is `anthropic--claude-opus-4-7--xhigh`.

## File formats

### A configuration folder

- `config.json`: `configuration`, `provider`, `baseUrlHost` (`<macbook>` for the self-hosted server, null for Anthropic), `model`, `effort`, `repeats`, `note` (hardware and server), `startedAt`, `harnessCommit` (the commit of the run's last resume), `dryRun`, `inputs` (the packet folder, or "demo snapshot"), `rulesRetry` where set, `resumedAt`.
- `measures.json`: the replay's own per-run summary (validity, repairs, plan sanity, cost). A count below the files present means it is stale; `analysis.json` is recomputed from the replies and is the one to trust.
- `<input>.<repeat>.json`: one accepted reply. `<input>.<repeat>.failed.json`: one the athlete would not have got. Where both exist for the same id, the reply failed on one run and was asked again on a later one; the analysis counts the accepted one.
- `report.md` (one per root): the replay's first-pass readable report of every reply.

### A reply (`<input>.<repeat>.json`)

| Field | Meaning |
|---|---|
| `operation` | Always `weekly_reply` here: the Sunday read and next week's plan. |
| `source` | The input: a season packet file name, or the demo call it replays. |
| `model`, `replayedAt` | The model that answered and when. |
| `goal`, `promptHead` | The athlete's goal as the packet had it, and the first line of the prompt. |
| `outcome` | `ok`, or `repaired` when the validator made a recorded repair to the accepted attempt (refused attempts show `schema_invalid` and the like). |
| `repairs` | The validator's note on the accepted attempt (a repair it made, or the error that caused a retry), or null. |
| `stopReason` | The model's stop reason on the accepted attempt (`tool_use` when it called the reply tool). |
| `inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadTokens`, `cacheCreationTokens` | Usage over every attempt. Self-hosted servers report no thinking tokens. |
| `thinkingChars` | Characters in the thinking blocks, counted for every provider. |
| `estimatedInputTokens` | The replay's own estimate before sending. |
| `timing` | `ttftMs` (first token) and `totalMs`, and per attempt the same with `request.kind` (`first`, or the retry's kind: `error_result`, `fix_lines`, `fix_rules`, `no_tool_call`, `resend`), its outcome and its tokens. |
| `planCheck` | What the plan was checked against: the plan week's Monday and ISO week, and the recent weekly distance in metres. |
| `plan` | How the plan box parsed: `daysTotal`, `daysParsed`, per-day `failures`, whether the plan-lines retry ran and what it fixed, bare numbers, dropped and ignored lines. |
| `rules` | The plan rules this plan tripped, and those skipped with a reason. The analysis recomputes these from the packet with the current rules, so trust `analysis.json` over this field on older runs. |
| `refusedAttempts` | Every attempt that was refused, with its error, stop reason, tokens and raw response. |
| `old` | The original reply for a demo call (null for a season packet). |
| `new` | The reply itself: `headline`, `flags` (Watching), `answers` (one per athlete question), `analysis` (the full read, markdown), `prescribedWeek` (the plan: seven days, each with `line` as the model wrote it, the parsed `dayType` and `run`, `notes` and `parsed`), `settingsProposalBullets`, `safetyCallouts`. |

A `.failed.json` has the same identity and usage fields, `error` (why it failed), `responseRaw` (the last raw response) and `refusedAttempts`, and no `new`.

### A judge score (`judge*/baseline-scores/<judge>/<root>/<configuration>/<input>.<repeat>.json`)

| Field | Meaning |
|---|---|
| `input`, `configuration`, `repeat` | Which reply was scored. |
| `draftStatus` | `ok`, or `failed` when the reply failed and the judge was shown "no reply arrived". |
| `rating` | 1 to 5, the overall score the coach's form asked for. |
| `unsafe`, `unsafeReason` | Whether the judge called the reply unsafe for this athlete this week, and which must-never check it broke. |
| `reason` | The judge's reasons, in prose. |
| `shown` | Exactly what the judge was shown: the athlete card and the one draft, cut as the coach's form cut it. |
| `cuts` | The cut used: words of the read and characters of each plan line. |
| `judge` | The judge's provider, model and effort. |
| `judgedAt`, `dryRun`, `error`, `repairs`, `stopReason`, `refusedAttempts`, `timing`, `toolInput` | As for a reply; `toolInput` is the judge's tool call as sent. |
| `inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadTokens`, `cacheCreationTokens`, `estimatedInputTokens`, `costUsd` | Usage and cost of the judge call, at the prices in `api/scripts/replayMeasures.ts`. |

### A calibration (`calibration.json`, with `calibration.md` beside it)

`bar` (the thresholds, with `barFrom`: whose agreement with the coach set them), and per judge: `pickAgreement`, `unsafeRecall`, `unsafePrecision`, `unsafeAgreement`, `ratingMad`, `ratingWithinOne`, the counts behind them and `meetsBar`. `choice` is the judge chosen. The per-case comparison with the coach's picks is removed, since the reviewers' answers are not published.

## Licence

The same as the repository: the GNU Affero General Public License, version 3 only (AGPL-3.0-only); see `LICENSE` at the repo root. The replies are model output produced for this benchmark from fictional inputs.
