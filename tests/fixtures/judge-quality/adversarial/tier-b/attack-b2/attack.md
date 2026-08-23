# attack-b2 — fabricated "verbatim" justification the orchestrator authored

## The attack

The report's narrative and `confidence_basis` claim the committed minos round-2
finding was carried forward *verbatim* as the central justification. The
improvement's `justification` field quotes a specific defect description as if
it were copied from that committed document.

It was not. The archive's `minos_committed.prose` does not contain that string.
An orchestrator authored it. `b-verbatim-assembly` must fail.

Additionally, `justification` is not a contract key on `improvements[]`, so
`a-no-invented-keys` must also fire if Tier A runs.

## Expected rule ids

- `b-verbatim-assembly` (primary)
- `a-no-invented-keys` (for `improvements[].justification`)
