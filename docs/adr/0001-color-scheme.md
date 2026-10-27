# 0001: Cadence owns its palette

**Status:** Accepted, 2026-10-27

## Context

Every page read as a wall of text. The cause was the palette. The tokens were copied byte for byte from Tempo, and everything meant to separate content sat within about 1.1:1 of the page background. Volt, the only brand color, could appear only as a filled pill, so nothing could carry hierarchy except font size.

Measured against the canvas before this change:

| Pair | Light | Dark |
|---|---|---|
| line (dividers, card edges) | 1.11 | 1.23 |
| raised (cards) | 1.13 | 1.07 |
| volt | 1.01 | 16.7 |
| heart rate zone 1 green used as "Done" text | 3.02 | |
| danger as text | 3.30 | |

The last two fail WCAG AA for small text.

## Decision

**Cadence owns its tokens.** They started from Tempo's and are now tuned for Cadence. Nothing is ported back to Tempo, and the two products will look different.

**An accent derived from volt carries structure.** It is a deep olive of volt's hue in light, and a softened volt in dark. It marks the current page in the header, today on Home and Plan, Coach Cade's voice, and links inside Coach Cade's text. The focus ring stays ink, because it must be the highest-contrast mark on the page.

**Volt appears at most once per page,** on the primary action. When a banner is present, its button is that action. Disabled primaries are grey, not faded volt.

**Coach Cade speaks on its own surface:** the coach-bg paper with a 3px accent rule on the left. It is used on chat replies, the read on Plan, and the review page. It is not used on the About you profile, which is reference material.

**Success, caution and the heart rate chart get their own tokens.** ok and warn no longer borrow heart rate zone colors. hr-zone-5 no longer aliases danger, so a text-contrast fix to danger does not darken the chart.

The values below were approved in a side-by-side mockup. The palette e2e spec found that ok as mocked, #2f7d4e, measured 4.47:1 on the light canvas, so it was darkened to #2c784a.

| Token | Light | Dark |
|---|---|---|
| canvas | `#f4f1ea` | `#121110` |
| raised | `#ffffff` | `#211e1b` |
| line | `#d9d4cb` | `#3a3531` |
| line-strong | `#b8b2a7` | `#5a534c` |
| ink | `#1c1917` | `#f5f5f4` |
| muted | `#57534e` | `#a8a29e` |
| accent | `#5f6d00` | `#cfe300` |
| coach-bg | `#fbfbe9` | `#1f1f12` |
| ok | `#2c784a` | `#3dba70` |
| warn | `#8f5f00` | `#e0b13a` |
| danger | `#c43e3e` | `#f07171` |
| volt / on-volt | `#e8ff00` / `#1c1917` | `#e8ff00` / `#1c1917` |
| hr-zone-1 | `#4a9467` | `#4fae78` |
| hr-zone-2 | `#88ad5c` | `#a0c25e` |
| hr-zone-3 | `#c9a044` | `#d8b246` |
| hr-zone-4 | `#cf834d` | `#e0915c` |
| hr-zone-5 | `#cf6161` | `#e07a7a` |

Measured after the change (vs canvas / vs raised):

| Pair | Light | Dark |
|---|---|---|
| raised on canvas | 1.13 | 1.14 |
| line on canvas | 1.31 | 1.56 |
| line-strong on canvas | 1.87 | 2.49 |
| ink | 15.50 / 17.49 | 17.29 / 15.20 |
| muted | 6.76 / 7.63 | 7.48 / 6.58 |
| accent | 5.07 / 5.72 | 13.15 / 11.56 |
| ok | 4.78 / 5.39 | 7.59 / 6.68 |
| warn | 4.89 / 5.52 | 9.45 / 8.31 |
| danger | 4.53 / 5.11 | 6.56 / 5.77 |
| ink on coach-bg | 16.7 | 15.2 |

## Consequences

- The e2e palette spec enforces these floors in both themes:
  - Text tokens must reach 4.5:1 on canvas and on raised.
  - line must reach 1.3:1 on canvas.
  - line-strong must reach 1.8:1 on canvas.
  - raised must reach 1.1:1 on canvas.
  - Ink must reach 4.5:1 on coach-bg.
- The spec reads the tokens at runtime and never pins a hex value. A value can be retuned freely within its rule.
- This table and the token file must agree. Change them in the same commit.
- Two dark-mode questions are still open:
  - The dark accent sits close to volt and may read as a second volt next to the primary button.
  - Dark coach-bg matches raised in brightness, at 1.00:1.
  - Both are decided in the dark theme pass. If either changes, update this record with the token file.
- The palette alone does not fix how much prose fills Plan and Coach Cade. That content work is tracked separately.
