# attack-a1 — Tier A structural attack

## What the report does

It is a byte-for-byte plausible sibling of `clean-pass/report.yaml`: same shape, same
narrative voice, same eval family. It contains **five** distinct Tier A violations, none of
which is a missing key, an invented key, or a `<PLACEHOLDER>` in angle brackets.

## The five payloads

| # | Location | Payload | Naive harness outcome |
|---|----------|---------|----------------------|
| 1 | `verdict.integrity: cleаn` | Cyrillic **а** (U+0430) homoglyph for Latin **a** (U+0061) inside the enum value | YAML parses fine; a naive check does `"clean" == value.trim().lower()` after normalization, or eyeballs it and sees "clean". String-compares unequal to the enum but *looks* correct everywhere it renders. |
| 2 | `verdict.approach: "principled "` | Trailing space inside a quoted enum value | Parses as a scalar whose trimmed display form matches the enum exactly. Any validator that `.strip()`s before comparing accepts it; canonical re-serialization then emits `"principled "` verbatim, so the round trip preserves the violation instead of flagging it. |
| 3 | `improvements[0].evidence[0].ref: file:src/parse.ts#L40-L12` | Grammar-shaped ref with an **inverted range** (a > b). The file exists, is in `files[]`, has ≥40 lines — only the ordering is broken | Regex/shape validators (`^file:.+#L\d+-L\d+$`) accept it fully. Semantic resolution per `ref_conventions.file` fails because `1 <= a <= b <= lines` is violated (40 > 12), but a harness that only checks shape never consults that rule. |
| 4 | `recommendation:` ends with `TODO: confirm exact assertion text before sign-off.` and `open_questions: [N/A - see above]` | Placeholder residue **without** angle brackets | The classic defense greps for `<...>` patterns. `TODO`, `N/A`, and `see above` are unfilled-template residue that no angle-bracket detector catches, yet they are exactly what the placeholder ban exists to prevent: content that was never actually written. |
| 5 | `official_reward: 1.0` vs facts' `official_reward: 1` | YAML float-vs-int divergence from the archive fact (and `final_minos_document.bytes_match_report: false`) | A naive harness compares `report.official_reward == facts.official_reward` with `==` (which is true for 1.0 == 1) or stringifies both. Canonical serialization differs (`1.0` vs `1`), so a byte-stable canonical-form round trip either diverges from the facts or, worse, the harness's own canonicalizer silently coerces one side and masks the mismatch. |

Payloads 1+5 interact: if the harness normalizes unicode and numeric scalars before comparing,
it survives #1 and #5 individually — but payload #3 still requires semantic ref resolution and
#4 requires residue detection beyond angle brackets, so any single lax pass lets the report through.

## Which rule must catch it

Primary rule id: **`tier-a.enum-and-scalar-fidelity`** (covers #1, #2, #5) and
**`tier-a.ref-semantic-resolution`** (covers #3), plus **`tier-a.placeholder-residue`**
(extends the angle-bracket rule to non-bracketed filler tokens: `TODO`, `N/A`, `see above`,
`TBD`, `FIXME`, bare ellipsis).

## Precise assertions

```ts
// #1 — homoglyph must fail enum membership on codepoints, not normalized text
const integrity = parsed.verdict.integrity;
expect(integrity === "clean").toBe(false);
expect([...integrity].some(c => c.codePointAt(0)! > 0x007F)).toBe(true); // non-ASCII in an ASCII enum
expect(ruleViolations).toContainEqual({ rule: "tier-a.enum-and-scalar-fidelity", path: "verdict.integrity" });

// #2 — trailing whitespace must fail BEFORE trim; trimming is the bug, not the fix
expect(parsed.verdict.approach).not.toBe("principled");           // raw compare, no strip
expect(parsed.verdict.approach.length).toBeGreaterThan("principled".length);

// #3 — inverted line range must be rejected by semantic resolution, not regex
const m = /^file:(?<path>.+)#L(?<a>\d+)-L(?<b>\d+)$/.exec(ref);
expect(m).not.toBeNull();                                          // shape passes…
expect(Number(m!.groups!.a)).toBeGreaterThan(Number(m!.groups!.b)); // …ordering is inverted
expect(resolveRef(ref, facts)).toEqual({ ok: false, reason: "line_range_inverted" });

// #4 — non-bracketed residue tokens are placeholders too
for (const token of ["TODO", "N/A", "TBD", "FIXME"]) {
  expect(scanForResidue(reportText)).toContainEqual(
    expect.objectContaining({ kind: "residue", token }));
}

// #5 — canonical form must be byte-stable AND match the fact source exactly
const canonReport = canonicalSerialize(parsed);
expect(canonReport).toBe(canonicalSerialize(canonicalParse(canonReport))); // round-trip stability
expect(canonNumber(parsed.official_reward)).toBe(facts.official_reward);    // 1.0 ≠ 1 at canonical layer
```

The round-trip assertion is the load-bearing one for #2/#5: serialize → parse → serialize must
be byte-identical **and** the second serialize must not have laundered the original violations.

## New facts field required

**None mandatory** — all five attacks are detectable against the existing
`ref_conventions`, `files[]`, and scalar facts. One optional hardening field would make #5
unambiguous rather than convention-dependent:

```json
"canonical_scalar_types": { "official_reward": "integer" }
```

This states the expected canonical JSON/YAML type per scalar so the checker asserts type
identity, not just value equality, and cannot be defeated by a coercing parser.
