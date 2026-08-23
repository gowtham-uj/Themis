# probe: a-ref-shape-valid

Single-defect variant of `clean-pass/report.yaml`. Every other byte is the good
report, so the only thing this probe can fire on is the defect below.

## Defect

A file ref whose range runs backwards: `file:src/parse.ts#L38-L34`.

## Why this must fail

The ref grammar requires `1 <= start <= end`. A backwards range is not resolvable
against any archive, but it is shaped enough to pass a naive prefix check, so the
grammar has to reject it rather than leaving Tier B to fail on it later.

## Expected

`checkTierA` raises exactly `a-ref-shape-valid`, and no other rule.
