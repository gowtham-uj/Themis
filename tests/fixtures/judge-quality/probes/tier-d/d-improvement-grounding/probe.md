# probe: d-improvement-grounding

Variant of `clean-pass/report.yaml` carrying exactly one usefulness defect, resolved
against `clean-pass/archive-facts.json`.

## Defect

The single improvement carries an empty `evidence[]`.

## Why this must fail

An improvement without evidence is an opinion the report is presenting as a finding.
The locked design has a place for material the record does not support — `open_questions`
— and the whole point of the split is that a reader can trust everything in
`improvements` to be pinned. Removing the evidence also drops the report to three
resolving refs, so `confidence_in_this_report` is lowered to `medium` here: that is a
truthful consequence of the defect, not a second defect, and it keeps the probe firing
one rule.

## Expected

Tier D raises exactly `d-improvement-grounding`, and no other rule.
