# probe: d-calibration

Variant of `clean-pass/report.yaml` carrying exactly one usefulness defect, resolved
against `clean-pass/archive-facts.json`.

## Defect

The report claims `confidence_in_this_report: high` while citing three distinct
resolving refs — one short of the four the rule requires.

## Why this must fail

High confidence is a claim about the density of the record, and the record is countable.
The threshold is one ref per verdict dimension (approach, integrity, competence,
reconciliation), so falling below it means at least one dimension of the verdict rests
on nothing the reader can check. Confidence that outruns its evidence is worse than no
confidence field at all, because a downstream consumer filtering on `high` will trust it.

## Expected

Tier D raises exactly `d-calibration`, and no other rule.
