# Agent categories — pre-defined profiles

This is a **general agent evaluation platform**: it evaluates any autonomous-agent run, not only coding
agents. **Coding agents are one pre-defined category.** A **category** is a profile that presets which
rubric axes/criteria apply, whether the run produces source artifacts (a diff), which default
deterministic checks exist, and the shape of its trajectory — so a new agent type is "select/extend a
category," not "hand-author a rubric from zero."

A task declares its `agentCategory` (defaulted from the project); the judge uses the category to know
which axes to score, **whether the `withSource` improvements lens applies**, and which checks to expect.

## Pre-defined categories

| category | What it evaluates | Produces a diff/source? | `withSource` lens? | Default axes | Default checks |
|---|---|---|---|---|---|
| `coding` | agents that edit/write code in a workspace | yes (git diff) | **yes** | A,B,C,D,E,F,G,H (full) | test_suite, build, typecheck, lint, repro, secret_scan |
| `research` | read-only research/analysis agents (summarize, investigate, report) | no | no | A(accuracy), B, C(context), E, H(honesty) | (none; optional `command` for fact-check scripts) |
| `general` | tool-using, non-coding agents (API orchestration, ops, data ops) | maybe | if diff present | A, B, C, F, plus D(verify) where checkable | per-task `command`/`http` checks |
| `browser` | browser/computer-use agents (navigate UI, complete web tasks) | no (DOM/actions) | no | A(goal), C(tool/result interpretation), B, E | `http` endpoint checks, screenshot asserts |
| `data` | data/ETL agents (transform, migrate, pipeline) | yes (data outputs) | partially (outputs, not code) | A, B, D(verify outputs), F, G(hygiene) | `repro` (run+compare outputs), `perf_bench` |
| `conversational` | chat/assistant agents (no tools, single- or multi-turn) | no | no | A, B(reasoning), H(honesty/clarity) | (none) |

### Category profile shape

```ts
interface AgentCategory {
  id: string;                          // "coding" | "research" | "general" | "browser" | "data" | "conversational"
  label: string;
  hasSourceArtifacts: "always" | "never" | "conditional";  // gates the withSource improvements lens
  defaultCriteria: string[];          // rubric criterion ids that apply (others dropped + renormalized)
  defaultProfile: string;             // starter weight preset (rubric §6) — coding→bugfix/feature/etc
  defaultChecks: Check[];              // deterministic hooks expected for this category
  diffKind?: "git" | "outputs" | "none";  // what "the diff" means for refs
}
```

## How category affects the rest of the platform

- **Rubric** ([rubric.md](rubric.md)): a category filters `applies_to` (`general`|`coding`|`both`) and
  the profile's criteria; non-applicable criteria drop and weights renormalize (§7). Coding keeps
  axes G (Code Quality) fully; research/browser/conversational drop G and most of F.
- **Judge** ([judge-system-prompt.md §10](judge-system-prompt.md)): the `withSource` improvements lens
  is produced **only when `hasSourceArtifacts` is truthy** (coding always; data conditionally; others
  never). The `withoutSource` lens is always produced. This is why "general agent eval" still yields
  actionable feedback without source access.
- **Diff & refs** ([execution.md](execution.md), [event-schema.md](event-schema.md)): for `git`
  categories the harness computes a git diff (hunk-numbered, addressable). For `outputs`/`none`
  categories, no `diff.patch` — findings use trace/tool refs only; the judge's `withSource` lens is
  omitted, not silently empty.
- **Projects** ([projects.md](projects.md)): a project sets a default `agentCategory`; tasks may
  override it. The project's check-runner templates map to the category's checks.
- **Adapters** ([adapters.md](adapters.md)): an adapter is category-aware — e.g. a browser agent
  adapter emits tool calls for navigation/clicks rather than file edits; the canonical schema is
  unchanged (still tool.call/tool.result), only the tool names differ.

## Adding a category

1. Pick `id` + `label`, set `hasSourceArtifacts`, choose default criteria + profile + checks.
2. (Optional) add an `applies_to` marker to any new rubric criteria.
3. Register the category id. Done — judge, UI, API, trends, findings, improvements all adapt. No core
   changes. A custom category is just a profile JSON; you rarely need a code change.
