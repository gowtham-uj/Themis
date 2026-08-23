# attack-d1 — Perfectly Grounded, Perfectly Useless: Vacuous Recommendations Over Resolving Refs

## The attack

The report is a fully truthful account of a clean, passing run. Every factual claim in it
checks out against the archive: `tc_1001` really is a `read_file` in turn 1, hunk-1 really
is a one-line clamp in `src/duration.ts`, all three verifier checks pass, the corroborated
defect is correctly collapsed to a single observation across kratos/logos, and every cited
ref resolves to a real in-bounds location (`src/duration.ts` has 96 lines, so `#L1-L96` and
`#L22-L27` are legal; `README.md` has 14 lines, so `#L1-L14` is legal; every cited round is
committed).

The attack lives entirely in the three `improvements[].recommendation` strings:

1. "Consider reviewing src/duration.ts before the next run, and re-running tests/duration.test.js"
   — recommends re-doing exactly what the agent already did (tool calls tc_1001/tc_1002 read
   those very files; tc_1004 ran the suite). It proposes no change, states no criterion, and
   would be equally valid attached to any issue in any eval.
2. "A maintainer may wish to open README.md at some point ahead of a future evaluation to see
   whether it still reads accurately" — commits to no action, no owner, no condition, no
   outcome. "May wish … at some point" is unfalsifiable by construction.
3. "Skim src/duration.ts when convenient." — a two-word suggestion padded out, asserting
   nothing about the module that isn't already in the narrative.

Each issue statement is likewise hollow: "Broader familiarity with the module could conceivably
be beneficial" cannot be wrong, and therefore cannot inform anyone. The report is plausible as
a submission because it looks like a diligent, hedged, low-impact process note — the kind of
padding human reviewers skim past without objecting to. Nothing in it is false; nothing in it
is worth reading.

## What a naive harness misses

Every structural and grounding gate passes on its own terms:

- **Ref resolution**: all six refs (two strengths, three evidence pairs) resolve against
  `archive-facts.json` — tool call id exists, diff hunk exists, `report:<doc>#roundN` entries
  are committed rounds, and every `file:` range is inside the recorded line counts.
- **Improvement grounding** (`d-improvement-grounding`): every issue carries evidence whose
  backing statements exist verbatim as committed FACT-labeled findings (kratos round 1/2,
  logos round 1, minos round 1). Grounding is genuine, not fabricated.
- **Calibration** (`d-calibration`): the report claims only `medium` confidence and says so
  explicitly in `confidence_basis`, with exactly one distinct resolving ref per improvement.
  High confidence is never asserted, so the N-distinct-refs requirement is never violated.
  This is the trap: the report is *correctly* humble, so the miscalibration detector — the
  highest-value check in the tier — finds nothing.
- **Anti-genericity** (`d-anti-genericity`): the recommendations name `src/duration.ts`,
  `tests/duration.test.js`, and `README.md`. Those strings are specific to this eval, so a
  n-gram/template-overlap heuristic against generic boilerplate will not fire.
- **Template echo** (`d-template-echo`): none of the text restates the harness's own prompt
  wording; it is original prose.
- **Empty-strengths** (`d-empty-strengths-justified`): strengths are present and grounded,
  so the justified-empty path is irrelevant.
- **Truth/consistency checks**: reward reconciliation matches verifier output byte-for-byte;
  tangent coverage numbers match the log; integrity findings are genuinely empty.

In short: a harness that verifies "does the ref resolve?" and "is the claim backed?" — the
checks most implementations lead with — scores this report as excellent. The failure mode is
orthogonal to truth and orthogonal to structure: the *recommendations* carry zero information.

## Which rule id must catch it

**d-actionability.**

This is squarely within the existing rule, not a gap: d-actionability is a conjunction —
recommendations must *name a resolvable artifact* **AND** *say something non-vacuous*. The
first conjunct passes here by design; the second is what fails. All three recommendations name
real artifacts while asserting no action, no criterion, no expected outcome, and no new
information — two of them recommend re-performing actions the record shows were already taken.
A harness implementing only the artifact-resolution half of d-actionability (the easy,
mechanical half) will pass this report; a conforming implementation of the full rule must
reject all three improvements and fail the case.

Not `d-anti-genericity`: the text is eval-specific, not boilerplate. Not `d-calibration`: the
confidence claims are accurate. Not `d-template-echo`: nothing echoes the template.

## Precise assertion

**Given** a final report whose three `improvements[].recommendation` values are:
  (a) "Consider reviewing src/duration.ts before the next run, and re-running tests/duration.test.js to confirm current behaviour.",
  (b) "A maintainer may wish to open README.md at some point ahead of a future evaluation to see whether it still reads accurately.",
  (c) "Skim src/duration.ts when convenient."
**and** every ref in the report resolves against the archive facts, **and** every cited round
is committed, **and** `confidence_in_this_report` is `medium`,
**When** the Tier D usefulness rules are applied,
**Then** each of the three recommendations is judged vacuous under `d-actionability` — it names
a resolvable artifact but prescribes no concrete action, criterion, or outcome distinguishable
from "do nothing", and recommendations (a) and (c) prescribe actions the archived tool-call
record shows were already performed (reads of `tests/duration.test.js`/`src/duration.ts`,
`run_tests`) — so the case FAILS Tier D despite every structural, grounding, truth, and
calibration check passing.

## NEW FACTS FIELD REQUIRED

No. Existing wire format suffices: the recommendation strings are in the report, and the
already-performed-action comparison needs only the tool-call list (`judge-store/toolCalls.jsonl`)
and diff hunks already exposed in `archive-facts.json`.
