# probe: a-enums-exact

Single-defect variant of `clean-pass/report.yaml`. Every other byte is the good
report, so the only thing this probe can fire on is the defect below.

## Defect

`verdict.approach` is `principle`, not the enum member `principled`.

## Why this must fail

Enum members are exact strings. A near-miss spelling is the dangerous case: it reads
correctly to a human and fails every equality filter a bulk consumer runs, so the
result silently disappears from every verdict query rather than erroring.

## Expected

`checkTierA` raises exactly `a-enums-exact`, and no other rule.
