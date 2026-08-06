---
name: Multi-criterion refactor
workspace:
  source: empty
agentCategory: coding
profile: refactor
tags: [refactor, quality]
checks:
  - id: typecheck
    kind: typecheck
    command: npm run typecheck
  - id: lint
    kind: lint
    command: npm run lint
rubric:
  profile: refactor
  version: 2
  criteria:
    - id: A1
      axis: A
      label: Goal completion
      weight: 2
      critical: true
      appliesTo: both
      anchors:
        full: Refactor complete; behavior preserved and verified.
        partial: Partial refactor; some modules untouched or behavior drift.
        none: No meaningful refactor; behavior broken.
    - id: G1
      axis: G
      label: Code quality
      weight: 1
      appliesTo: coding
      anchors:
        full: Clear structure, consistent style, no dead code.
        partial: Some improvement but inconsistencies remain.
        none: Quality regressed or unchanged mess.
    - id: D1
      axis: D
      label: Self-verification
      weight: 1
      critical: true
      appliesTo: both
      checkId: typecheck
      anchors:
        full: Ran typecheck/lint and observed green results.
        partial: Partial verification (one check skipped).
        none: Claimed done with no verification.
---

Refactor the authentication module to extract a shared token validator.
Preserve existing public API behavior. Run typecheck and lint before finishing.
