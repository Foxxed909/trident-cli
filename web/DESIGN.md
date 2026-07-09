# TRIDENT Web — Design System

register: product · Terminal-native dark, Restrained→Committed color strategy.

## Color (OKLCH)
Anchored to the CLI's existing identity (teal #5EEAD4, amber #F5C97A) — identity
preservation wins, so these are not re-derived from a palette seed.

| Role | Token | Value | Use |
|---|---|---|---|
| Abyss (app bg) | `--bg` | oklch(0.17 0.028 240) | deepest layer, behind everything |
| Surface | `--surface` | oklch(0.21 0.03 240) | panels, sidebar |
| Surface raised | `--surface-2` | oklch(0.25 0.032 240) | cards, input, hover |
| Border | `--border` | oklch(0.30 0.03 240) | hairlines |
| Ink | `--ink` | oklch(0.96 0.01 240) | primary text (≥12:1) |
| Ink muted | `--ink-muted` | oklch(0.74 0.02 240) | secondary text (≥4.6:1) |
| Ink faint | `--ink-faint` | oklch(0.58 0.02 240) | timestamps, meta only (never body) |
| Teal (primary) | `--teal` | oklch(0.85 0.13 178) | primary actions, current selection, agent |
| Amber (accent) | `--amber` | oklch(0.83 0.11 78) | cost, warnings, secondary highlight |
| Rose (danger) | `--rose` | oklch(0.70 0.17 18) | destructive risk, errors, deny |
| Sea | `--sea` | oklch(0.80 0.09 230) | info, read-risk, links |

Risk colors map 1:1 to the CLI warden: read=sea, write=amber, execute=teal, destructive=rose.

## Type
One family: **Inter** (UI) + **JetBrains Mono** (code, tool args, cost, the wordmark).
Fixed rem scale, ratio ~1.2. No fluid clamp headings — this is product UI at consistent DPI.
- 0.6875rem meta · 0.8125rem label · 0.875rem body · 1rem strong · 1.25rem h2 · 1.75rem hero.
Mono is a deliberate signature, used for anything the machine produced or measures.

## Motion
150–250ms, ease-out (cubic-bezier(0.2,0.8,0.2,1)). Motion conveys state only:
message enter, tool row status flip, approval slide-in, mode switch. The one atmospheric
exception is the background: a slow (~40s) drifting current + faint particle field behind
the app — the sketch's "background animations" — kept under 3% contrast so it never
competes with content. All motion honors `prefers-reduced-motion`.

## Layout
Three zones: left sidebar (Chats / Connections, ~248px, collapsible), main chat column
(max 820px measure), and a bottom-anchored prompt bar with the `+` new-chat affordance
from the sketch. Structural responsive: sidebar collapses to an icon rail under 900px.

## Component vocabulary (states are non-negotiable)
Every interactive element ships default / hover / focus-visible / active / disabled.
- **Message**: user (right-ish, surface-2) vs agent (left, transparent, teal rail on hover).
- **Tool row**: icon + name + risk chip + duration; running (pulse) → ok (teal tick) / fail (rose cross), expandable output.
- **Approval card**: risk-colored, slides in; Approve / Approve+always / Deny.
- **Prompt bar**: mono input, `+` button, mode pill (review/yolo/lockdown), send.
- **Empty state teaches**: welcome hero with the trident wordmark + example prompts, not "nothing here."

## Bans honored
No side-stripe cards (tool rows use full borders + leading icon), no gradient text,
no glassmorphism-by-default, no eyebrows, no hero-metric template, no identical card grid.
