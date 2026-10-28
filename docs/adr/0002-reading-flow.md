# 0002: Coach Cade's read has parts, and nothing is cut to make it shorter

**Status:** Accepted, 2026-10-27

## Context

After the palette work (ADR 0001), Plan and Coach Cade still read as walls of text, because the words had no shape. Coach Cade's weekly read was one free-form string of up to 4,000 characters, described to the model only as "headline, concerns/flags, and answers". The model chose its own headings every week, so the page could only render the whole thing as markdown.

Measured on the demo's ten weekly reads:

| Measure | Range |
|---|---|
| Length | 1,760 to 3,641 characters, 333 to 679 words |
| Longest paragraph | 111 to 172 words |
| "Why each session" list, repeating the day rows | 600 to 900 characters of each read |

The whole read was also copied into the week's conversation, so a past week's Your week page printed it twice.

The substance was good. The demo reads are careful coaching. The tempting fix, a lower character cap, would have cut that coaching to fit.

## Decision

**Relocate, do not delete.** Each kind of content moves to where it is read:

- The read gains parts the page lays out on its own: a **headline**, **flags** shown as "Watching", and **answers** shown as "Your questions", each under the athlete's own question. The rest stays as markdown, shown as "The full read".
- The reason for each session moves into that day's **notes**, beside the session. The read no longer lists the days.
- The conversation gets the **headline** and a link, not the whole read.
- The parts are stored together in one nullable column beside the read. Plans made before them render as they did.

**Cap only the short parts.** The headline is capped at 280 characters, flag titles at 80 and flag details at 280, with at most five flags and eight answers. Day notes are asked for in 200 characters and kept to 400. The read keeps its 4,000-character ceiling, and answers are never cut.

**Repair and log rather than refuse.** A headline, flag or day note that runs long is cut at a word or sentence and the cut is recorded on the call, as safety callouts already were. Only a wrong shape, or too many flags or answers, refuses the reply. Losing a whole read over one long sentence would cost more than the sentence.

**Fold by freshness.** On next week's plan and on Your week, where the read is fresh, everything is open. On this week's plan, the answers to last Sunday's questions fold away with the full read, so the week's first days are on the first screen. Safety notices are never folded.

**Shape the writing.** The prompt asks for the conclusion first, one idea per paragraph, at most three sentences per paragraph, sentences under 25 words, and tables for more than three related numbers. Reasoning stays as sentences, because a list carries one relationship at a time and the "why" needs more. Corrections come first: when the athlete ran a session differently from the plan, it is flagged and explained. Flags and answers stand on their own, since the read below them may be folded.

**Ask once more for a reply refused for its shape.** A plan that arrives as a string of JSON is parsed when it can be. A weekly reply refused for its shape is requested once more before the athlete sees a failed read.

**A plan change shown in the conversation is a snapshot, not a reference.** When Coach Cade changes days from chat, the message keeps the days as they were changed then, so a later change does not rewrite an old message. (Built in the reading-flow third PR.)

## Evidence: the replay gate

Before the read's parts shipped, every weekly call in the demo snapshot was replayed through the live model with the new prompt and schema, and each old and new pair was read in full. The verdicts were kept in the maintainer's working notes; the findings that shaped this decision are below.

- **First run:** substance held in eight of ten weeks, and several new reads were clearer than the old ones. One week lost its most important correction. Four format rules were broken: an answer pointing to "the table above", a session table in the read, an answer's table repeated in the read, and internal words. The prompt was fixed for each.
- **Second run:** substance held in every week that came back, and every first-run problem was gone. One reply sent its plan as a malformed string of JSON and was refused. Across the replays, two of about twenty-one did this.
- **Strict tool use was tried for that and rejected.** It constrained the plan's shape, but one reply ran to the 64,000-token output limit and was cut off: about seven times the cost of a normal reply, and still a failure. It was reverted in favour of parsing a string plan and asking once more.

## Consequences

- The read's parts are fields the model must fill and the validator must check. Changing one means changing the tool schema, the validator, the stub and the page together.
- A cap on the read itself should not come back. If reads grow too long, move content to a part or to the day notes, and replay the demo calls to check nothing is lost.
- The replay script (`api/scripts/replay-weekly-reads.ts`) is the check for any future prompt or schema change to the weekly reply. It reuses the app's own Anthropic code and writes a first-pass report a person still has to read.
- A weekly reply that fails for its shape now costs up to two model calls. Each call keeps its own log row, so the call log shows how often the second attempt is needed.
- The model still sometimes writes internal words, such as "mid-week" or "dossier", into coaching text. Nothing in the app filters model text for them. That is separate work.
