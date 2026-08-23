# probe: b-improvement-evidence-resolves

Single-defect variant of the `clean-pass` pair.

## Defect

The improvement's single evidence ref points at `file:src/parse.ts#L120-L124` — a range
past the end of a 60-line file.

## Why this must fail

The report still names a real file and a well-formed range, so the ref survives the Tier A
grammar check; only resolution against the archive catches it. An improvement whose
evidence does not resolve is an assertion wearing a citation: the reader who follows it
finds nothing there, and there is no way to tell an honest transcription slip from an
invented line range. `checkImprovementEvidenceResolves` covers the evidence positions
specifically because that is where a recommendation earns the right to be believed.

## Expected

Tier B raises `b-improvement-evidence-resolves`, plus the rules below and nothing else.

- `b-refs-resolve` — every ref in the report, evidence positions included, is also checked by the general
resolution rule. The containment is total and by design: no mutation can break an
evidence ref without breaking a ref. The two rules are still distinct — `b-refs-resolve`
says a citation is broken, `b-improvement-evidence-resolves` says a *recommendation*
is unsupported — and this probe proves the second one is wired up, which is what the
coverage gate asks.
