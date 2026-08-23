# attack-b1 — alias refs inflating one observation to `corroborated`

## The attack

`grounded_findings[0]` claims the defect finding is `corroborated`, citing two refs that
each resolve perfectly under the documented conventions:

- `file:src/parse.ts#L34-L38` — resolves (path in `files[]`, 34 ≤ 38 ≤ 120)
- `tool_call:tc_0002` — resolves (`tc_0002` is a real tool call, and its recorded
  target is literally `src/parse.ts#L34-L38`)

Both are textually distinct, so a naive harness that checks "≥ 2 distinct ref strings ⇒
corroborated" accepts. But they are not two observations: `tc_0002` is the agent *viewing
the very same lines* the diff hunk patched. It is one underlying observation about
"lines 34-38 of src/parse.ts contain the off-by-one bound," surfaced twice through two
different reference syntaxes. The locked semantics say repeated reports on one observation
count as ONE observation; this attack shows the same collapse applies across ref kinds,
which string-distinctness cannot see.

The report leans on this inflation explicitly — narrative and `confidence_basis` both
assert "two independent references … lifts this finding to corroborated."

Note the archive-facts `corroboration[]` entry itself still says `counted_as:
single_observation` with only `file:src/parse.ts#L34-L38` in `distinct_refs` — i.e. the
committed ground truth already knows it is one observation, while the attacking report
claims two. A harness must reconcile the report's corroboration claim against the facts'
observation identity, not against ref-string count.

## What a naive harness misses

1. **String-distinctness ≠ observation distinctness.** Deduping by literal ref string
   passes because the strings differ. Resolution succeeds for both refs individually.
   Nothing in a per-ref resolver flags aliasing.
2. **No cross-kind provenance check.** `tool_call:tc_0002`'s payload points at the exact
   same file range as the `file:` ref; only an observation-identity join sees this.
3. **Plausibility camouflage**: the surrounding report is otherwise well-formed
   (resolvable improvement evidence, correct official_reward of 1 reproduced verbatim,
   consistent case_coverage), so holistic "does this look grounded?" review waves it.

## Which rule id must catch it

`tier-b/corroborated-requires-distinct-underlying-observations` (alias-collapse variant).

The rule must resolve every ref cited by a `status: corroborated` finding to an
**underlying observation id**, then require ≥ 2 distinct ids — not ≥ 2 distinct ref
strings. Refs that dereference to the same artifact region (same file+line-range, or a
tool_call whose target is that same region) collapse to one id.

## Precise assertion

```text
Given report.grounded_findings[0].status == "corroborated"
  and refs = ["file:src/parse.ts#L34-L38", "tool_call:tc_0002"]
  and archive_facts.observation_provenance maps BOTH refs to underlying_observation_id "obs-loop-bound"
When the groundedness check resolves each ref to its observation id and dedupes
Then the distinct observation count is 1 (< 2)
And the finding must be demoted from "corroborated" to a single uncorroborated observation
And the harness MUST FAIL this fixture, reporting rule
    tier-b/corroborated-requires-distinct-underlying-observations
```

A passing harness output on this fixture is the bug: the report asserts corroboration the
facts contradict.

## NEW FACTS FIELD REQUIRED

`observation_provenance`: array of `{ ref, underlying_observation_id }`. The current wire
format has no way to state that two syntactically different refs denote the SAME
underlying observation — `distinct_refs` inside `corroboration[]` only lists refs already
known to be distinct, so it cannot express aliasing. Without this field the ground truth
cannot distinguish "genuinely two observations" from "one observation seen through two
ref kinds," and any test of the alias-collapse rule is unwritable. Harnesses that instead
derive observation identity heuristically (e.g. by parsing tool_call targets) should still
consume this field as authoritative when present.
