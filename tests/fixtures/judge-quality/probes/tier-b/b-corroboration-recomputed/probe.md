# probe: b-corroboration-recomputed

Single-defect variant of the `clean-pass` pair.

`report.yaml` is **byte-identical to clean-pass** — the defect is in the committed
record the report was assembled from. A final report can be flawless and still rest on
a record that does not support it; that gap is the only thing this rule can see.

## Defect

The one corroboration entry is relabelled `counted_as: corroborated` while its
`distinct_refs` still holds exactly one ref — the same `file:src/parse.ts#L34-L38`
both kratos and logos cited.

## Why this must fail

This is the locked corroboration rule stated exactly: corroboration requires *distinct*
refs, and two reports pointing at one ref count as one observation. The failure mode is
the one that matters — a judge that counts agreement between its own investigators as
independent confirmation manufactures confidence out of a single piece of evidence, and
every report it writes then looks better corroborated than the archive can support.
`checkCorroborationRecomputed` recomputes the arithmetic from `distinct_refs` rather than
trusting minos's own `counted_as`, which is why the lie is catchable at all.

## Expected

Tier B raises exactly `b-corroboration-recomputed`, and no other rule.
