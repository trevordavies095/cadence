# 0009: Each page has one job, and content has one home

**Status:** Accepted, 2026-11-26 (#76 to #80). Amends the "Fold by freshness" rule of ADR 0002. Respects ADR 0006: nothing here changes what the model is asked for.

## Context

A layout audit of a real instance on 2026-11-26, at 1280 px and at 390 px, found the app confusing and long for one reason: the same content lived in several places, and no page had one clear job.

| Measure | Seen |
|---|---|
| Today's session | Word for word on Home, on Plan, and in the conversation's change card |
| A past week's Your week | About 14,500 px on desktop and 21,000 px on a phone; about 60% was the week's conversation, printed open |
| Monday's row on this week's Plan | About 950 px down on desktop; on a phone the first screen was notices |
| A plan notice about Thursday's run | Still shown after Thursday's run was done |
| About you | 19 "Coach update" rows, seven with the same title, as peers of Schedule and Injuries |

ADR 0002 already meant this week's Plan to have "the week's first days on the first screen", and the conversation to get the headline and a link, not the whole read. Both had drifted.

## Decision

**Each page answers one question.** Home: what do I do now. Plan: what is this week. Coach Cade: the conversation. History and Your week: what happened. A page links to another page's content; it does not copy it.

**Fold by freshness goes one step further on this week's Plan** (amends ADR 0002):

- **Watching keeps only its titles** until "The full read" is opened; opening it shows each detail in place. With no full read and no answers to open, the details stay. On next week's plan and on Your week, where the read is fresh, everything is open as before.
- **A plan notice expires by date.** A notice from Cadence's own check of the plan carries the plan dates its body names. This week's Plan stops showing it once the last of those dates is before today. A notice naming no day (a volume jump) stays all week. Every notice stays on Your week and on the Sunday message's card, as a record.
- **Safety notices are never folded and never expire.** ADR 0002's rule is unchanged.

**Expiry is by the calendar, not by the running log.** A notice about today's session stays all day, whether or not the run is done: "done" is read from any run on the date, and a warm-up saved on its own would clear a warning too early.

**The conversation is folded on Your week** (#78), closed, with its message count. It is not deleted: ADR 0002's "relocate, do not delete" holds.

**The model contract does not move.** Structured session steps, a shorter read and a merged About you were each considered and each is a contract change under ADR 0006. This work is layout: what is shown where, and what is folded.

## Consequences

- A plan warning has a `dates` field. A rule added to the plan check must say which plan dates its body names, or its notice stays all week.
- Warnings stored before 2026-11-26 have no dates. They are given them when read, from the stored plan and by rule: the hard days for "quality with pain", the long run for "long-run jump". A stored "return from injury" warning is left without, since its body may or may not name the long run, so it stays all week.
- A day changed from the conversation after Sunday does not rewrite a stored notice's dates. The notice was true of the plan it was written for, and its body still names those days.
- With a safety notice and a three-line headline, Monday's row is still below the first screen on a phone (about 870 px at 390 px wide, from about 1,300). Getting it higher means moving the read below the days or shortening the headline, and neither is decided here.
- The pages that follow (#78 Your week, #79 Home, #80 About you) are held to the first rule: before adding content to a page, find its home and link to it.
