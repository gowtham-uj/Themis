/**
 * Themis judge quality harness — rule registry (WP-0).
 *
 * This is the complete, frozen registry of every Tier A, Tier B and
 * deterministic Tier D rule from section 3 ("five-tier gate") of
 * plan/themis-phase1-implementation.md.
 *
 * It carries NO checking logic — this list IS the spec that the
 * implementers of the harness must satisfy. Each entry is
 * { id, tier, title, rationale }.
 */

/** Tiers represented in this registry: A (structural), B (groundedness), D (deterministic usefulness). */
export type RuleTier = 'A' | 'B' | 'D';

/** A single quality rule the harness must enforce. */
export interface QualityRule {
  id: string;
  tier: RuleTier;
  title: string;
  rationale: string;
}

const RULE_ENTRIES: readonly QualityRule[] = [
  /* ------------------------------ Tier A ------------------------------ */
  {
    id: 'a-yaml-parses',
    tier: 'A',
    title: 'Report parses as YAML',
    rationale:
      'The evalJudge.yaml document must load as valid YAML before any field-level check. Plan §3 Tier A: "Parses".',
  },
  {
    id: 'a-required-keys',
    tier: 'A',
    title: 'Required keys present',
    rationale:
      'Every required key in the evalJudge.yaml contract must be present; a missing key fails. The contract: "Never omit a key."',
  },
  {
    id: 'a-no-invented-keys',
    tier: 'A',
    title: 'No invented keys',
    rationale:
      'No key outside the evalJudge.yaml contract may appear; invented keys are rejected (they belong in the scratchpad).',
  },
  {
    id: 'a-enums-exact',
    tier: 'A',
    title: 'Enums exactly as specified',
    rationale:
      'Enum values must be exactly the members listed in the contract; anything else is rejected. The contract: "Enums exactly as listed."',
  },
  {
    id: 'a-ref-shape-valid',
    tier: 'A',
    title: 'Ref shape valid',
    rationale:
      'Every ref must match the ref grammar — tool_call:<id>, diff:<file>#<hunk>, file:<path>#L<a>-L<b>, verifier:<line>, report:<category>#round<n>, scratchpad:<agent_id>, web:<url>; a malformed ref is rejected. The contract: "Refs well-formed."',
  },
  {
    id: 'a-no-placeholder-residue',
    tier: 'A',
    title: 'No placeholder residue',
    rationale:
      'No field may contain `<ANGLE_BRACKET>` placeholder residue; placeholders are not answers.',
  },
  {
    id: 'a-no-field-echo',
    tier: 'A',
    title: 'No field content restates its name',
    rationale:
      'No field whose content merely restates its own field name; a field filled with prose restating the field name is not filled.',
  },
  {
    id: 'a-canonical-stable',
    tier: 'A',
    title: 'Canonical serialization stable',
    rationale:
      'Canonical serialization must be byte-stable across a re-serialize round trip.',
  },

  /* ------------------------------ Tier B ------------------------------ */
  {
    id: 'b-refs-resolve',
    tier: 'B',
    title: 'Every ref resolves',
    rationale:
      'Every ref resolves against the real archive: tool_call:<id> exists in toolCalls.jsonl; file:<path>#L<a>-L<b> exists with the range in bounds; diff:<file>#<hunk> exists; verifier:<line> exists; report:<category>#round<n> names a committed document; scratchpad:<agent_id> names a real agent.',
  },
  {
    id: 'b-web-refs-not-findings',
    tier: 'B',
    title: 'web: refs never back a finding',
    rationale:
      '`web:` refs may support recommendations only; they can never back a claim about what the evaluated agent did. Locked semantics: "Web refs can support recommendations, never claims."',
  },
  {
    id: 'b-corroboration-recomputed',
    tier: 'B',
    title: 'Corroboration arithmetic recomputed',
    rationale:
      'The distinct-ref count derived independently must match minos\'s counted_as; two reports citing one ref must be single_observation. Corroboration requires distinct refs.',
  },
  {
    id: 'b-adverse-ruling-refed',
    tier: 'B',
    title: 'Adverse rulings are refed',
    rationale:
      'integrity: violation without ≥1 resolving ref is a hard failure; the contract says suspicion without a ref is `suspicious`, never `violation`.',
  },
  {
    id: 'b-official-reward-exact',
    tier: 'B',
    title: 'official_reward byte-exact',
    rationale:
      'official_reward must be byte-exact against the verifier\'s number; any drift fails. The reward is reproduced, never modified.',
  },
  {
    id: 'b-improvement-evidence-resolves',
    tier: 'B',
    title: 'Improvement evidence refs resolve',
    rationale: 'Every improvements[].evidence[] ref must resolve.',
  },
  {
    id: 'b-label-discipline',
    tier: 'B',
    title: 'Label discipline',
    rationale:
      'An unrefed statement labelled FACT fails; only HYPOTHESIS/UNRESOLVED may be unrefed.',
  },
  {
    id: 'b-refuted-needs-positive-finding',
    tier: 'B',
    title: 'refuted requires a positive finding',
    rationale:
      'A disposition of refuted whose report says only that a search found nothing fails; that is inconclusive, never refuted.',
  },
  {
    id: 'b-coverage-honesty',
    tier: 'B',
    title: 'Coverage honesty',
    rationale:
      'case_coverage counts must equal committed ledger rows — tangents_total equals tangent-log rows, rounds_run equals committed round rows.',
  },
  {
    id: 'b-verbatim-assembly',
    tier: 'B',
    title: 'Verbatim assembly',
    rationale:
      'Every verdict, justification and improvement in evalJudge.yaml must be byte-identical to its source in a committed minos document. Anything the orchestrator authored that is not in {rounds_run, case_coverage, closed_by, converged, declined-tangent facts} fails.',
  },

  /* --------------------------- Tier D (deterministic) ------------------ */
  {
    id: 'd-actionability',
    tier: 'D',
    title: 'Recommendations name a resolvable artifact',
    rationale:
      'Each improvements[].recommendation must name a concrete artifact that resolves — a file, symbol, command, or test that exists in the archive; a recommendation naming nothing resolvable fails. This is "specific enough to act on", made mechanical.',
  },
  {
    id: 'd-anti-genericity',
    tier: 'D',
    title: 'No cross-fixture boilerplate',
    rationale:
      'Run the corpus and compare narratives pairwise; if two different evals produce narratives above a similarity threshold, the judge is emitting boilerplate and the build fails.',
  },
  {
    id: 'd-template-echo',
    tier: 'D',
    title: 'No template echo',
    rationale:
      'Narrative and justification n-grams overlapping the prompt/template text above threshold fail.',
  },
  {
    id: 'd-calibration',
    tier: 'D',
    title: 'Confidence calibrated',
    rationale:
      'confidence_in_this_report: high requires ≥N distinct resolving refs across the case; low confidence on a case with dense corroboration is flagged. Miscalibration is "the worst output this system can produce".',
  },
  {
    id: 'd-empty-strengths-justified',
    tier: 'D',
    title: 'Empty strengths justified',
    rationale:
      'An empty what_the_agent_did_well is permitted (the contract says an empty list is itself a finding) but the narrative must then account for it.',
  },
  {
    id: 'd-improvement-grounding',
    tier: 'D',
    title: 'Improvement grounding',
    rationale:
      'Any improvement without evidence[] fails; ungrounded material belongs in open_questions.',
  },
];

/** The frozen, exported rule registry. Implementers must satisfy every entry. */
export const QUALITY_RULES: readonly QualityRule[] = Object.freeze(
  RULE_ENTRIES.map((rule) => Object.freeze(rule)),
);
