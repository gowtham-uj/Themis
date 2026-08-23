# probe: a-no-placeholder-residue

Single-defect variant of `clean-pass/report.yaml`. Every other byte is the good
report, so the only thing this probe can fire on is the defect below.

## Defect

A strength observation still carries the template token `<tool_call ref>`.

## Why this must fail

Angle-bracket residue means the template was emitted, not filled. It is the single
clearest signal that a field was never authored, and it must fail before any
groundedness rule spends effort resolving refs in an unwritten report.

## Expected

`checkTierA` raises exactly `a-no-placeholder-residue`, and no other rule.
