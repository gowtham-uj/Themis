# probe: a-no-field-echo

Single-defect variant of `clean-pass/report.yaml`. Every other byte is the good
report, so the only thing this probe can fire on is the defect below.

## Defect

A strength whose `observation` is the word "observation".

## Why this must fail

A field filled with its own name is not filled. This is what a model emits when it
has nothing to say but the schema requires a string, and it passes any check that
only asks whether the field is non-empty.

## Expected

`checkTierA` raises exactly `a-no-field-echo`, and no other rule.
