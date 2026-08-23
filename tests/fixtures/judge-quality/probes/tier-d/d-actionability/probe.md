# probe: d-actionability

Variant of `clean-pass/report.yaml` carrying exactly one usefulness defect, resolved
against `clean-pass/archive-facts.json`.

## Defect

The single improvement's recommendation names no file, symbol, command or test that
exists in the archive — it says "raise the quality bar" and stops.

## Why this must fail

A recommendation that names nothing addressable is not a recommendation; it is a mood.
The reader cannot act on it and cannot check it, and it survives every structural and
groundedness rule because the improvement is otherwise perfectly well-formed and its
evidence resolves. Actionability is the only gate that catches it.

## Expected

Tier D raises exactly `d-actionability`, and no other rule.
