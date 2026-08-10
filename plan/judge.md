# LLM Judge Subsystem

The judge is a **decoupled, repeatable** grading step. It is itself a **PI agent**, embedded through
PI's SDK with its **system prompt replaced** by our versioned judge prompt and equipped only with our
**custom judge tools**. Provider/model selection is swappable. It ingests immutable eval archives and
the task rubric, grades one run or an entire queue in one agent session, persists its own full PI event
trace, and emits validated verdict data from which the platform renders a polished **HTML report**.

## What the judge produces (three layers of feedback)

The judge emits **three complementary layers**, not just a number:

1. **Scores** (numeric, for trends) — overall + per-criterion, anchored, weighted → the regression
   number line.
2. **Diagnostics** (binary, located) — yes/no failure modes, each with a pointer to *where* it
   happened (`{value, refs, note}`), not a bare boolean.
3. **Findings** (the layer worth reading, fixing, and logging) — individual, *located, prioritized,
   fixable* issues: a `claim` ("deleted `auth.test.ts`'s skip to make the suite green"), structured
   `refs` (a diff hunk, a trace `seq` range, a tool-call id), a `severity`, a `confidence`, an optional
   `fix` (direction + repro), and a controlled `category` the platform fingerprints for recurrence.
   Plus `positiveFindings` (behavior to preserve) and `metaFindings` (rubric/task gaps, for the task
   author — not the agent).

The score answers *how good*; the diagnostic answers *whether X happened*; the finding answers *what
to fix, exactly where, and how*. Findings are the actionable spine of the report and the durable issues
log; scores and diagnostics are the trend signal. Verdict shape and the judge's findings rules live in
[judge-system-prompt.md §7–9](judge-system-prompt.md); the rubric-side motivation in
[rubric.md §6–7](rubric.md). This three-layer design is what stops the platform from being "just a
numbering machine": the queryable data is defects-with-locations, not scores-with-boolean-flags.

## Why a PI agent as the judge, not a one-shot LLM call

- **Judging a trajectory needs tools, not one prompt.** A coding run can touch dozens of files and a
  long trace that won't fit in one context. An agentic judge *inspects* — it lists immutable archive
  files, reads exact byte ranges, reconstructs the trajectory, and submits only after required
  evidence coverage is complete.
- **PI SDK as the engine**: the server replaces PI's system prompt with the versioned custom judge
  prompt, disables built-in tools/extensions/skills/context discovery, registers only the platform's
  evidence and terminating submission tools, chooses a real configured provider/model, and captures
  every PI session event plus the final transcript.
- **One versatile host** supports single-eval and queue-wide judging by supplying different custom tool
  sets and user payloads. The queue form uses one PI session for every selected immutable archive and
  emits exactly one Verdict per eval plus cross-eval analysis.
- The judge is auditable and decoupled: re-judging creates a new revision over byte-identical archives
  without rerunning the agent under evaluation.

## Inputs to a judgement

```
- task.prompt              (what the agent was asked)
- task.rubric              (per-task criteria + weights + optional checks)
- global judge system prompt (tuned, versioned)
- user judge prompt        (optional, ad-hoc steer from the UI)
- run.events.jsonl         (thinking, messages, tool calls/results, usage)
- run.diff.patch           (what the agent changed)
- run metadata             (agent, model, status, duration, tokens)
```
The judge container mounts the run's log dir **read-only** at `/logs` and the report skill read-only.

## Global judge system prompt (draft)

Versioned (`system_prompt_version`) so re-judging is comparable. The full prompt lives in
**[judge-system-prompt.md](judge-system-prompt.md) (v2)** — it is **not written from scratch**; it is
assembled from the most validated public judge designs and enriched for coding-agent trajectories:

- **MT-Bench `single-v1`** — impartial framing, explanation-before-score, parseable output, bias warnings.
- **G-Eval** — explicit **Evaluation Steps** (chain-of-thought before scoring), form-filling.
- **Prometheus 2** — **anchored per-level rubric**, optional **reference solution**, feedback-then-score.
- **MCP-Bench / AgentRewardBench** — multi-axis scoring + **yes/no failure-mode diagnostics**, evidence-grounding.
- **Our enrichment** — injection **trust model**, verify-don't-trust, hallucinated-success penalty, critical-criterion gate, failure attribution.

See that file for the verbatim prompt, provenance table, expected rubric shape, and sources.

## Structured verdict (schema)

The judge must emit machine-readable scores (mirrored to SQLite for trends) before/with the report,
**plus the findings layer** that makes feedback actionable and durable. Rationale is written **before**
the score (Prometheus/MT-Bench feedback-then-score ordering). The diff is hunk-numbered and the trace is
`seq`-addressable so every `ref` points to a real location. Full prompt + rules in
[judge-system-prompt.md](judge-system-prompt.md); the essential shape:

```ts
interface Verdict {
  overall: { score: number; verdict: "pass"|"partial"|"fail"; summary: string };
  criteria: Array<{
    criterion: string; weight: number; critical?: boolean;
    feedback: string;                                    // reasoning, written before the score
    score: number;                                       // 0..1
    evidence: string[];                                  // quoted log lines / diff hunks
    findingIds: string[];                                // findings that bear on this criterion
  }>;
  findings: Finding[];                  // located, fixable issues — the actionable layer (see below)
  positiveFindings: Finding[];          // behavior to preserve
  metaFindings: MetaFinding[];          // rubric/task gaps for the task author (not agent defects)
  diagnostics: Record<string, {         // localized booleans (not bare flags)
    value: boolean; refs?: Ref[]; note?: string }>;
  attribution: { agent_vs_environment: "agent"|"environment"|"mixed"; note?: string };
  observations: string[];
  comparison?: { vsRunId: string; direction: "progressed"|"regressed"|"flat"; why: string };
}

interface Ref =
  | { kind: "diff"; file: string; hunk: number; lines?: [number, number] }
  | { kind: "trace"; runId: string; seqs: [number, number] }
  | { kind: "tool"; toolCallId: string };

interface Finding {
  id: string;                            // short, stable, human-readable
  category: string;                      // controlled vocab (e.g. "test_gaming", "root_cause_missed")
  severity: "blocker" | "major" | "minor" | "nit";
  confidence: number;                    // 0..1 — judge's own uncertainty
  criterion?: string;                   // rubric criterion it bears on
  claim: string;                         // one line: what's wrong
  refs: Ref[];                           // structured, addressable evidence (≥1)
  fix?: { direction: string; repro?: { command: string; expected: string } };
  // `recurring` is filled by the PLATFORM (fingerprint match), not by the judge:
  recurring?: { firstSeenRun: string; lastSeenRun: string; count: number };
}

interface MetaFinding {
  id: string; category: "rubric_unverifiable" | "prompt_ambiguous" | "evidence_missing";
  claim: string; note?: string;
}
```

## Report-generation skill (great UI/UX)

The judge produces the HTML via a **pi skill** we author and mount — this is where "get a famous
UI/UX skill and let it use that" lands. The skill packages:

- A **design system**: type scale, spacing, color tokens (light+dark), accessible contrast, a clean
  component set (score gauges, criterion cards, a diff viewer, a trace timeline, a token/cost strip).
- **Charts done right**: per-criterion score bars, a run-vs-prior comparison, token/cost breakdown —
  following solid dataviz rules (categorical vs sequential palettes, labeled axes, colorblind-safe).
- **Structure**: verdict header → **findings spine ("what to fix", severity-ordered, each linking via its
  refs into the diff viewer / trace timeline / tool call)** → scores → evidence-linked criterion
  breakdown (each criterion citing its `findingIds`) → diagnostics (localized, with their own refs) →
  notable moments in the trace → positive findings ("what to keep") → observations → (optional)
  regression note. The findings spine comes early — it is what a fixing engineer opens the report to read.
- **Constraints**: self-contained single `report.html` (inline CSS/JS, no external network), responsive,
  printable.

> Sourcing: seed this skill from a high-quality design/dataviz skill (the same principles as the
> `dataviz` design guidance) adapted into pi's skill format, so the judge reliably emits on-brand,
> accessible reports rather than ad-hoc HTML.

## Live judge log

pi runs with `--mode json`; the Judge Worker maps its events into the canonical schema and streams
them to `/api/judgements/:id/events` (SSE). The UI shows the judge **thinking**, its **tool calls**
(reading the diff, grepping logs), and its progress toward the verdict — exactly like watching an
agent run, which makes the judge auditable and debuggable.

## Decoupling & re-judging

- Judgements never mutate runs. Re-judge = new `judgements` row over the same `events.jsonl`/`diff`.
- Swap `judge_model`/`judge_provider` or edit the `judge_prompt` and re-run to compare judges.
- `overall_score` + per-criterion `scores` feed the trend charts and the two-run compare view.
- **Findings feed the regression narrative**: a finding fingerprint that appears in run A but not run B
  is a concrete *what changed* ("v2 stopped running the suite" → `verification_skipped` recurred), far
  more actionable than a delta number. The compare view renders findings-set diff (introduced /
  resolved / persisted) alongside score deltas.

## Guarding judge quality (future)

- Optional **panel/self-consistency**: run the judge K times or with K models and aggregate, to reduce
  judge variance on borderline runs. Findings aggregate by fingerprint intersection (a defect the panel
  agrees on surfaces; a single-judge-only finding is tagged lower-confidence).
- Optional **deterministic checks** (tests pass, builds, file exists) folded in as hard signals the
  judge must reconcile with — the most rigorous rubric mode.
- **Findings fingerprinting & recurrence** (platform, not the judge): each finding's
  `category` + canonicalized location-key is its fingerprint, so the same defect recurring across
  runs, across model versions, or across N repeats is recognized and logged — turning a score dip into
  "defect `test_gaming:src/auth.test.ts#skip` recurred in 3/3 repeats." Recurrence rate (per finding,
  per category) is a sharper, less-averaged regression signal than the diagnostic boolean alone.
