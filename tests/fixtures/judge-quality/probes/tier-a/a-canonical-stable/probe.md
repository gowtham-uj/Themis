# probe: a-canonical-stable

Single-defect variant of `clean-pass/report.yaml`. Every other byte is the good
report, so the only thing this probe can fire on is the defect below.

## Defect

The narrative uses an explicit block-indent indicator (`|2`) with a first content
line indented past it, so the parsed string begins with two literal spaces.

## Why this must fail

The report parses cleanly and reads identically to the good fixture. But the leading
spaces cannot survive re-emission as a block scalar, so `C(x)` and `C(parse(C(x)))`
differ: the same logical report would hash two different ways. Every downstream
promise in the plan is hash-addressed, so a report that does not canonicalize to
stable bytes cannot be published at all.

## Expected

`checkTierA` raises exactly `a-canonical-stable`, and no other rule.
