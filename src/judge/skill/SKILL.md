---
name: report-generation
description: >
  Design-system + structure skill for agenteval judgement reports. Mount into the
  judge so every verdict becomes a polished, accessible, self-contained
  report.html. Use when emitting or authoring the HTML report for a Verdict.
---

# Report-generation skill (agenteval)

Author brief for the judge's HTML report step. The platform's pure renderer
(`src/judge/report/render.ts`) implements this skill; re-judging or hand-tuning
should follow the same rules.

Spec sources: `plan/judge.md` §"Report-generation skill", `plan/judge-system-prompt.md`
§7–10, `plan/rubric.md` §6 (findings are the actionable spine), `plan/roadmap.md` Phase 5.

## Author brief

Produce a **self-contained single `report.html`** from a validated three-layer
Verdict (scores + localized diagnostics + located findings) plus the two-lens
improvements synthesis. A fixing engineer opens this document top-to-bottom; the
**findings spine** is the primary payload and must come early.

Constraints (hard):

- One document. ALL CSS in a `<style>`, ALL JS in a `<script>`.
- NO external URLs, NO network fetches, NO `<link>`, NO `<script src=…>`.
- Responsive + printable (`@media print`).
- Deterministic for a given `(verdict, ctx)` — no `Date.now` / `Math.random`.
- Escape all user/judge-authored text (claims, feedback, notes, evidence, ids).

## Design system

### Type scale (rems)

| Token | Size |
|-------|------|
| xs | 0.75rem |
| sm | 0.875rem |
| md | 1rem |
| lg | 1.25rem |
| xl | 1.5rem |
| 2xl | 2rem |

System sans: `system-ui, -apple-system, "Segoe UI", sans-serif`. Mono for refs,
ids, repro blocks. Tabular nums on score columns and axis ticks.

### Spacing scale

`4 / 8 / 12 / 16 / 24 / 32 / 48` px.

### Color tokens (light + dark)

Ship both via `prefers-color-scheme` and optional `data-theme` toggle. Surfaces,
ink, and status steps must clear **WCAG AA** for text; status / severity colors
never carry meaning alone — always pair with **icon + label**.

**Severity (colorblind-safe categorical status):**

| Severity | Role | Light | Dark | Icon |
|----------|------|-------|------|------|
| blocker | stop / critical | `#d03b3b` | `#e66767` | ● |
| major | serious / amber | `#ec835a` | `#ec835a` | ▲ |
| minor | info blue | `#2a78d6` | `#3987e5` | ■ |
| nit | slate | `#898781` | `#898781` | · |

**Verdict levels:** pass = good green, partial = warning amber, fail = critical red
(again: icon + label).

**Score fill:** sequential blue (`#2a78d6` light / `#3987e5` dark) on a recessive
track. Do not rainbow scores.

### Components

- Overall **donut/arc gauge** (score 0..1) with aria-label.
- Per-criterion **horizontal score bars** with a clear 0 / 0.5 / 1 axis.
- Finding cards (severity border + badges + ref chips + optional fix/repro).
- Improvement cards (priority badge + area + change/why + refs + linked findings).
- Diagnostic tiles (`{value, refs, note}` — never bare booleans).
- Ref chips that look clickable (mono, hover, focus ring).
- Metadata strip + optional token/cost strip.

## Structure checklist (verbatim order)

Render in this order. Section ids are stable anchors for tests and deep links.

1. **Verdict header** (`#verdict`) — overall score gauge + level (pass/partial/fail) + summary.
2. **Findings spine** (`#findings`) — "what to fix", **severity-ordered**
   (`blocker > major > minor > nit`). Each card:
   - claim (headline)
   - severity badge (icon + label + color)
   - confidence %
   - category
   - criterion link (if set) → `#criterion-<id>`
   - ref list as deep-link chips
   - optional fix direction + repro (`command` + `expected`) as a code block
   - recurrence chip when `finding.recurring` is present
3. **Improvements panel** (`#improvements`) — two-lens synthesis:
   - **Without-source lens first** (always present; note that this lens holds without source access).
   - **With-source lens** only when `improvements.withSource` is present. If absent, show the note:
     `no source-level recommendations (run has no source artifacts)`.
   - Each improvement: area, priority badge, change, why, refs (chips), linkedFindings
     (scroll links to finding anchors).
4. **Criterion breakdown** (`#criteria`) — per-criterion cards:
   - feedback **before** score (feedback-then-score)
   - score bar 0..1 with labeled axis, weight, critical flag
   - evidence list (quoted log lines / diff hunks)
   - `findingIds` as clickable links to finding cards
5. **Diagnostics** (`#diagnostics`) — grid of `{value, refs, note}` tiles.
   Value true/false visually distinct (icon + label + border/bg). Each shows WHERE via refs.
6. **Notable trajectory moments** (`#notable-moments`) — derive from `observations[]`
   as bullet moments. Do **not** invent trajectory mining.
7. **Positive findings** (`#positive-findings`) — "what to keep"; same card shape as the
   findings spine, distinct section/color.
8. **Observations** (`#observations`) — simple list.
9. **Attribution** (`#attribution`) — `agent_vs_environment` + note.
10. **Optional comparison** (`#comparison`) — when `verdict.comparison` present:
    `vsRunId` + direction (progressed/regressed/flat with arrow + color) + why.
11. **Metadata strip** (`#metadata`) — run id, model, judge model + system prompt version,
    judged-at, agent category, has-source flag; token/cost strip when
    `runMetadata.tokens` present.

Also emit:

- `<!-- @agenteval-report -->` comment near the top.
- `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- `@media print` rules that drop chrome and avoid breaks inside cards.

## Ref deep-links

Helpers: `refLabel(ref)`, `refHref(ref)`.

| kind | chip label | href |
|------|------------|------|
| `diff` | `{file} hunk {hunk}` (+ optional `L{a}–{b}`) | `#diff:{file}:{hunk}` |
| `trace` | `trace seq {a}–{b}` | `#trace:{runId}:{a}:{b}` |
| `tool` | `tool call {toolCallId}` | `#tool:{toolCallId}` |

Chips are keyboard-focusable anchors. Finding cards use `#finding-{slug(id)}`.

## Dataviz rules

Follow solid dataviz principles (same method as the platform `dataviz` skill):

- **Form follows job.** Overall score → single hero gauge (not a chart of one point).
  Per-criterion scores → labeled horizontal bars on a shared 0..1 axis.
  Comparison direction → arrow + status color + label (not a dual-axis plot).
- **One axis.** Never dual-axis. Score bars share the 0..1 scale.
- **Color by job.** Severity/status = reserved status palette with icon+label.
  Sequential blue for magnitude (score fill). Never rainbow scores; never reuse
  status hues as series colors.
- **Colorblind-safe.** Do not rely on hue alone. CVD-safe separation for adjacent
  categorical slots; text contrast AA.
- **Labeled axes.** Every score bar shows 0 · 0.5 · 1. Gauge has aria-label with
  numeric score and verdict level.
- **Token/cost strip** only when `runMetadata.tokens` is present — a compact
  labeled strip, not a pie chart of one run.
- **No chart junk.** No 3D, no dual axes, no unlabelled legends, no animation that
  ignores `prefers-reduced-motion`.

## Accessibility

- Semantic HTML: `section` / `article` / `h2` / `h3` / `nav` / `header` / `footer`.
- `aria-label` on gauges and score bars; `role="img"` where decorative SVG conveys data.
- Sufficient contrast (AA) in light and dark.
- Keyboard-focusable ref links and theme toggle; visible focus rings.
- `prefers-reduced-motion` respected (no scroll-behavior/animation when set).
- Skip link to `#findings`.

## Theme

- Default follows `prefers-color-scheme`.
- Optional tiny inline script for a manual light/dark toggle; guard `localStorage`
  with try/catch (sandboxed `srcdoc` iframes may throw). Defensive: no errors if
  an element is absent.

## Lens independence (do not break in the report)

- `withoutSource` recommendations must never imply source access; their refs are
  trace/tool only. The renderer does not re-validate, but must not invent diff chips.
- `withSource` is gated: render the lens only when the key is present on the verdict;
  otherwise show the no-source note.
- Findings remain the actionable spine — improvements link *to* them, they do not
  replace them.

## Implementation entrypoint

```ts
import { renderVerdictReport, type ReportContext } from "../report/index.js";
// renderVerdictReport(verdict, ctx) → complete HTML string
```

Mount this skill alongside the judge system prompt so any future LLM-emitted HTML
path (or human authoring) stays on-brand with the pure renderer.
