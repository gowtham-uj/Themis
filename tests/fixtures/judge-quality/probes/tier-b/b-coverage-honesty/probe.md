# probe: b-coverage-honesty

Single-defect variant of the `clean-pass` pair.

## Defect

`case_coverage` claims `converged: true` with `tangents_open: 1`, and `tangents_total`
is raised to 3 to match the tangent log so the open tangent is real rather than an
arithmetic slip.

## Why this must fail

Convergence is the report's claim that it stopped because there was nothing left to
investigate, not because it ran out of room. A case that closes with a tangent still
open did not converge, and saying otherwise is exactly the failure the confidence
section is supposed to prevent: a reader who trusts `converged: true` stops looking for
the unfinished thread. Note the asymmetry `checkCoverageHonesty` deliberately preserves
— `converged: false` with no open tangents is *not* an error, because a judge is always
free to under-claim. Only claimed convergence the record does not support is a lie.

## Expected

Tier B raises exactly `b-coverage-honesty`, and no other rule.
