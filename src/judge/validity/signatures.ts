/**
 * Phase-1 finding signatures — stable, normalized IDs Phase-2 groups by.
 *
 * Phase-2 must not re-derive "searched internal logs" vs "workspace grep
 * returned the agent's own session" vs "self-referential context ingestion"
 * as the same issue through embeddings. Phase 1 assigns a normalized signature
 * where it can, deterministically, so the Phase-2 finding registry is an
 * indexed pathology database rather than a prose corpus.
 *
 * This module is a CONTROLLED VOCABULARY plus a keyword classifier. The remedy
 * agent may propose a signature; the write-boundary validator rejects any id
 * outside this list, and the deterministic classifier provides the default
 * assignment so the labels do not depend on an LLM's consistency.
 */

export const FINDING_SIGNATURES = Object.freeze([
  // Context / token economics
  "TOOL_SEARCH_SELF_CONTEXT",
  "TOOL_RESULT_OVERSIZED",
  "POOR_CODE_LOCALIZATION",
  "IRRELEVANT_FILE_READING",
  "CONTEXT_INFLATION",
  // Reasoning / correctness discipline
  "COUNTEREXAMPLE_IGNORED",
  "TEST_SUITE_GUESSING",
  "SPEC_ASSUMPTION",
  "INSUFFICIENT_EDGE_VERIFICATION",
  "VERIFICATION_GAP",
  "PREMATURE_IMPLEMENTATION",
  "SPEC_AMBIGUITY",
  // Environment / tool assumptions
  "INTERPRETER_ASSUMPTION",
  "ENVIRONMENT_ASSUMPTION",
  // Platform (never attributed to the agent)
  "INFRA_SETUP_FAILURE",
  "METRIC_ATTRIBUTION_ERROR",
  "HARNESS_LIFECYCLE_ARTIFACT",
  "VERIFIER_ON_WRONG_TREE",
  // Fallback
  "UNCLASSIFIED",
] as const);

export type FindingSignature = (typeof FINDING_SIGNATURES)[number];

/** keyword → signature. First match wins; order is precedence. */
const KEYWORD_SIGNATURES: ReadonlyArray<{ re: RegExp; signature: FindingSignature }> = [
  { re: /own (?:session|conversation|thinking|transcript)|self[- ]context|live[- ](?:session )?log|conversation\.md|(?:read|grep|search)[^\n]{0,80}\.reaper|\.reaper[^\n]{0,80}(?:session|transcript|conversation|audit)/i, signature: "TOOL_SEARCH_SELF_CONTEXT" },
  { re: /(?:87,?993|88k|oversized|huge|massive|excessive)[^\n]*(?:result|output|context|characters)|result[^\n]*(?:too|overly|excessively)[^\n]*(?:large|big)|max_result_chars/i, signature: "TOOL_RESULT_OVERSIZED" },
  { re: /counterexample|backtracking|contradict(?:s|ion) (?:own|its) (?:solution|algorithm|implementation)|found (?:a )?counterexample|waived|proceeded anyway|proceeded despite/i, signature: "COUNTEREXAMPLE_IGNORED" },
  { re: /guess(?:ing|ed)? (?:the )?(?:test|tests|hidden)|assum(?:e|ed|ing)[^\n]*(?:test|hidden|simple)|likely (?:tests|hidden)|probably (?:simple|enough)/i, signature: "TEST_SUITE_GUESSING" },
  { re: /python3?: command not found|which python|assumed python|interpreter (?:missing|not found|assumption)|no python3?\b/i, signature: "INTERPRETER_ASSUMPTION" },
  { re: /localiz(?:e|ation|ing)|find(?:ing)? (?:the )?(?:right|relevant|correct) (?:file|symbol|location)|repo(?:sitory)? (?:search|map|explor)/i, signature: "POOR_CODE_LOCALIZATION" },
  { re: /did not test|untested|never (?:test|invoked (?:npm|node|pytest))|no (?:test|verification)[^\n]*(?:for|of)|verification (?:gap|step|discipline)|not verified|test_attempts 0|without (?:ever )?running (?:the )?(?:test|suite)/i, signature: "VERIFICATION_GAP" },
  { re: /spec[^\n]*(?:ambigu|both readings|unclear|admits both)|ambiguous (?:spec|requirement)/i, signature: "SPEC_AMBIGUITY" },
  { re: /setup[^\n]*(?:fail|abort|exit)|never reached the agent|agent (?:never|did not) (?:start|run|execute)|infrastructure|harness (?:fail|abort|bug)|refusing non-empty target/i, signature: "INFRA_SETUP_FAILURE" },
  { re: /metric[^\n]*(?:mislabel|attribution|labeling)|stop_reason|verified_completion (?:false|true)[^\n]*artifact|bookkeeping artifact/i, signature: "METRIC_ATTRIBUTION_ERROR" },
  { re: /verifier[^\n]*(?:ran|scored|evaluated)[^\n]*(?:seed|untouched|wrong)|graded the (?:untouched|seed)/i, signature: "VERIFIER_ON_WRONG_TREE" },
  { re: /premature|implemented? before|jumped to (?:code|implementation)|without (?:reading|understanding) the (?:spec|task)/i, signature: "PREMATURE_IMPLEMENTATION" },
  { re: /edge case|boundary condition|corner case|invalid input|did not (?:cover|test) (?:edges|boundaries)/i, signature: "INSUFFICIENT_EDGE_VERIFICATION" },
  { re: /read[^\n]*irrelevant|unrelated file|decoy|not referenced by/i, signature: "IRRELEVANT_FILE_READING" },
];

/**
 * Deterministically classify prose into zero or more finding signatures.
 * Returns a stable, sorted list; unknown text returns ["UNCLASSIFIED"].
 */
export function classifySignatures(text: string): FindingSignature[] {
  const hits = new Set<FindingSignature>();
  for (const { re, signature } of KEYWORD_SIGNATURES) {
    if (re.test(text)) hits.add(signature);
  }
  if (hits.size === 0) return ["UNCLASSIFIED"];
  return [...hits].sort();
}

/** True when a signature is in the controlled vocabulary. */
export function isKnownSignature(v: unknown): v is FindingSignature {
  return typeof v === "string" && (FINDING_SIGNATURES as readonly string[]).includes(v);
}
