# probe: d-template-echo

Variant of `clean-pass/report.yaml` carrying exactly one usefulness defect, resolved
against `clean-pass/archive-facts.json`.

The template the judge was given is `template.txt` in this directory.

## Defect

The narrative is the worked example from the judge's own template, copied verbatim.

## Why this must fail

A field quoted from the template describes the template, not the case. It is fluent,
well-formed, correctly shaped prose that happens to be about a different eval entirely,
and every structural rule passes it. This is the specific failure mode of a model that
has been shown an example and has nothing of its own to say.

## Expected

Tier D raises exactly `d-template-echo`, and no other rule.
