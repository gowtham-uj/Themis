# probe: b-label-discipline

Single-defect variant of the `clean-pass` pair.

`report.yaml` is **byte-identical to clean-pass** — the defect is in the committed
record the report was assembled from. A final report can be flawless and still rest on
a record that does not support it; that gap is the only thing this rule can see.

## Defect

One committed logos statement labelled `FACT` has its ref removed (`ref: null`).

## Why this must fail

The label vocabulary is the investigators' whole discipline: FACT asserts the record
shows this, and the ref is what makes that checkable. HYPOTHESIS and UNRESOLVED exist
precisely so an investigator can say something without a ref, so an unrefed FACT is never
a formatting slip — it is a claim promoted past the evidence that would support it. Every
downstream reader treats FACT as settled, so `checkLabelDiscipline` has to enforce it at
the point of authorship rather than letting it propagate into the final report.

## Expected

Tier B raises exactly `b-label-discipline`, and no other rule.
