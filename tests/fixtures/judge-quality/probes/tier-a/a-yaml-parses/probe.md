# probe: a-yaml-parses

Single-defect variant of `clean-pass/report.yaml`. Every other byte is the good
report, so the only thing this probe can fire on is the defect below.

## Defect

`eval_id` appears twice at the top level.

## Why this must fail

The canonical report form carries no duplicate keys, so the parser runs with
`uniqueKeys: true` and a repeated key is a parse failure, not a last-wins merge.
A last-wins parser would silently drop one of two conflicting eval ids.

## Expected

`checkTierA` raises exactly `a-yaml-parses`, and no other rule.
