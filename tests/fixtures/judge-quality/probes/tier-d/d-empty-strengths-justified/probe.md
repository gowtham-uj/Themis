# probe: d-empty-strengths-justified

Variant of `clean-pass/report.yaml` carrying exactly one usefulness defect, resolved
against `clean-pass/archive-facts.json`.

## Defect

`what_the_agent_did_well` is empty and the narrative never says why — it reads as a
neutral account with the strengths section simply missing.

## Why this must fail

An empty strengths list is itself a finding: it says the judge could see nothing the
agent did well. That is a strong claim, and a report that makes it silently is
indistinguishable from a report where the section was dropped by a bug. The narrative
must account for the absence so the reader knows which one they are looking at.
Confidence is `medium` here because removing the strengths removes their refs; that is
a consequence of the defect, not a second defect.

## Expected

Tier D raises exactly `d-empty-strengths-justified`, and no other rule.
