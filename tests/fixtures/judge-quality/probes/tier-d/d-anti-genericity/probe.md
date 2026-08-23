# probe: d-anti-genericity

Variant of `clean-pass/report.yaml` carrying exactly one usefulness defect, resolved
against `clean-pass/archive-facts.json`.

This probe is **cross-report**: it is graded as a pair with `clean-pass`, because the
defect does not exist inside either report alone.

## Defect

A second eval whose narrative is clean-pass's narrative with the identifiers swapped —
same sentences, same structure, different file and function names.

## Why this must fail

Boilerplate is invisible inside a single report: read on its own this narrative is
specific, grounded and plausible. It is only visible across the corpus, where the judge
turns out to be writing one narrative and substituting nouns. That is why this rule is
cross-report and why the probe ships as a pair with clean-pass rather than alone.

## Expected

Tier D raises exactly `d-anti-genericity`, and no other rule.
