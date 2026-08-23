# probe: a-required-keys

Single-defect variant of `clean-pass/report.yaml`. Every other byte is the good
report, so the only thing this probe can fire on is the defect below.

## Defect

The contract mapping `case_coverage` is absent.

## Why this must fail

Every contract key must be present. `case_coverage` is the block that says whether
the investigation converged or hit the round ceiling with tangents still open; a
report that omits it looks complete while concealing that it is not. Dropping a
container key (rather than a scalar) isolates this rule cleanly: a missing scalar
also trips `a-enums-exact`, which type-checks it, so it could not prove which rule
caught the omission.

## Expected

`checkTierA` raises exactly `a-required-keys`, and no other rule.
