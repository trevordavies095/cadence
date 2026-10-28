# Cadence: domain glossary

Two vocabularies live in this repo. The **internal** vocabulary names things in the API, database and tests. The **athlete-facing** vocabulary is what appears on screen, in coach messages the system writes, and in any copy the athlete reads. Code may use either; the athlete sees only the right-hand column.

## Terms

| Internal | Athlete-facing | Meaning |
|---|---|---|
| dossier, dossier version | **About you** (the page), "what Coach Cade knows about you" (in copy) | The versioned document holding the athlete's profile, history, protocols and the coach's learnings. The model reads it every call. |
| dossier proposal, settings proposal | "Coach Cade noted…" (a **note card**) | A set of changes to About you produced by a coach call. `settings` and `correction` kinds apply immediately; `onboarding` and `audit` kinds wait for **Looks right**. |
| accept / reject | **Looks right** / **Fix something** / **Undo** | Accept installs a pending proposal. Undo restores the version before an applied one. Fix sends a sentence that becomes a correction. |
| correction | **Fix something** | An athlete sentence that rewrites part of About you. |
| audit | "Coach Cade tidied what it knows about you" | The periodic trim of About you. |
| week session | **week**, **this week**, **past week** | The Monday to Sunday unit in the athlete timezone. |
| ISO week (2026-W43) | "Oct 19 – 25" | Never show the ISO label. |
| archived week | **past week** | A week before the current one. Chat is read-only there. |
| recap, weekly recap, recap gate | **Your week** (the report), **weekly check-in** (the interview) | The report is built from Tempo data plus the check-in answers. |
| subjective, subjective answers, needs_subjective | **weekly check-in**, "your check-in answers" | The athlete's own account of the week. |
| data-only recap, skipped subjective | "You skipped this week's check-in" | A report built without check-in answers. |
| weekly reply | "Coach Cade’s read" (the analysis), **next week's plan** (the plan) | The Sunday coach call: analysis of week N and a plan for N+1. Its read has parts the pages lay out on their own (the rows below), stored together as the plan's read sections. |
| headline | (no label: the first, bold line of Coach Cade’s read) | The one or two sentences Coach Cade would say if it could say only one thing. Also the Sunday message in the conversation and the "From Coach Cade" line on History. |
| flags | **Watching** | What Coach Cade is watching: up to five, each a short title and one line of detail. Corrections come first. |
| answers | **Your questions** | One answer per question the athlete asked in the check-in or the conversation, under the question in their own words. |
| analysis | **The full read** | The rest of Coach Cade’s reasoning. Folded on this week's plan, together with the answers, under **Your questions and the full read**; open on next week's plan and on Your week. |
| day notes | (no label: the muted line under a day on the plan) | Why this session, this week: one or two sentences beside the session. |
| weekly_read message | the Sunday message, with **Open the plan** | The headline posted into the reviewed week's conversation instead of the whole read. Its link opens the plan, or that week's Your week page once the planned week is over. |
| reply run | "Coach Cade is reading your week" | One server-side execution of the weekly reply, with status pending, ok or failed. |
| prescribed week, prescribed day | **plan**, **next week's plan**, **today's session** | The seven-day plan stored on a week session. |
| day patch | a card under the reply: **Coach Cade changed Thu and Sun** | A change to the remaining days made by the coach from chat. The reply keeps a snapshot of the days as they were changed then, so a later change never rewrites an old card. |
| mid-week chat, thread | **Coach Cade** (the page), "the conversation" | The current week's conversation with the coach. |
| athlete / coach (roles) | **You** / **Coach Cade** | Message labels. |
| coach, the coach | **Coach Cade** | The coach persona. Always written in full: never "Coach" or "Cade" alone, and never "your coach" in conversational copy. Legal and privacy text keeps the role wording "your coach". Code, routes and tables keep "coach". |
| the product | **Cadence** | The product name (header, title, welcome, disclaimer, privacy). Tempo, the running log, keeps its own name. |
| attachment, attach workout | **Add a run** | A Tempo run attached to a message, without GPS. |
| RPE, apiRpe | "How hard did it feel?" | Effort 1–10. Tempo's value prefills it. |
| felt | "How did it go?" | Feel 1–10. |
| onboarding, interview, questionnaire, prompt N of M | "a few questions", "3 of 8" | The first-run questions and the check-in questions. |
| loop status, phase, stepper | the home **banner** | The one line on Home that says what, if anything, needs the athlete. Never show the phase name. |
| safety callout | a **notice** titled by the callout | Rendered once, styled; never as a `⚠ Safety (caution):` text prefix. |
| packet, model packet, last outbound packet | "what was sent to Coach Cade" | The redacted context sent to the model; shown under Privacy. |
| Tempo | "your running log", "your watch" (for data that came from the watch) | The athlete's running log and the source of run data. Tempo may be named where the athlete connected it (Settings). |
| Anthropic, LLM, stub | (never shown outside Settings) | The model provider. |
| settings (page) | **Settings**, behind the gear icon | Connections, appearance, privacy. Never "Setup". |

## Never on screen

dossier · proposal · soft-gate · dirty · artifact · packet · prescribed · recap · subjective · ISO · week session · archived · stub · installed · phase · stepper · mid-week · interview · prompt · RPE · data-only · regenerate · 409 · any raw error code or JSON. · AI Coach · "Cade" on its own

## Writing rules

Plain sentences. No exclamation marks. No "Let's" openers. No emoji or decorative Unicode in interface copy. Dates as "Mon Oct 19" and ranges as "Oct 19 – 25"; the year only when it changes. Distances in the athlete's Tempo units. Durations as "36 min" or "1 h 12 min".
