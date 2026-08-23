# probe: a-no-invented-keys

Single-defect variant of `clean-pass/report.yaml`. Every other byte is the good
report, so the only thing this probe can fire on is the defect below.

## Defect

A top-level key `judge_confidence_notes` outside the contract.

## Why this must fail

Invented keys belong in the scratchpad. A downstream projection maps contract keys
only, so an invented top-level key is data that no consumer will ever read while
looking, to a human, like part of the report.

## Expected

`checkTierA` raises exactly `a-no-invented-keys`, and no other rule.
