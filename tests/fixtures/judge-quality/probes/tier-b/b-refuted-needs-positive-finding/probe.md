# probe: b-refuted-needs-positive-finding

Single-defect variant of the `clean-pass` pair.

`report.yaml` is **byte-identical to clean-pass** — the defect is in the committed
record the report was assembled from. A final report can be flawless and still rest on
a record that does not support it; that gap is the only thing this rule can see.

## Defect

A kratos round is recorded with `disposition: refuted` while its only finding is an
UNRESOLVED statement that a search turned up nothing.

## Why this must fail

Absence of evidence is the single most common way an investigation overreaches: the
sweep found nothing, and the report writes that up as having established the negative.
The locked rule is that "refuted" is a positive finding — a FACT with a ref showing the
thing is not so — and searched-and-found-nothing is "inconclusive". Without this rule a
judge can clear an agent of a suspicion it merely failed to investigate, which is worse
than never raising the suspicion. `checkRefutedNeedsPositiveFinding` requires the
positive finding to exist in the same disposition.

## Expected

Tier B raises exactly `b-refuted-needs-positive-finding`, and no other rule.
