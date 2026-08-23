/**
 * Deterministic text-similarity primitives for the Tier D usefulness gate
 * (WP-0). Dependency-free; every function is pure.
 *
 * Boilerplate detection needs a measure that is high only when two texts
 * share exact phrase structure, not merely common vocabulary — that is
 * word-shingle (n-gram) Jaccard over lowercased alphanumeric tokens.
 */

/** Word-shingle width used by the boilerplate and template-echo detectors. */
export const SHINGLE_SIZE = 3;

/**
 * Cross-fixture boilerplate threshold (rule d-anti-genericity).
 *
 * Two reports from DIFFERENT evals fail when their narrative shingle Jaccard
 * is at or above this value. Honest narratives about genuinely different cases
 * share few exact 3-word runs — typical overlap is well under 0.15 — while a
 * judge emitting boilerplate only swaps a handful of case-specific tokens and
 * lands near or above 0.6. The value sits far above coincidental overlap yet
 * still catches template-filled narratives.
 */
export const ANTI_GENERICITY_SIMILARITY_THRESHOLD = 0.6;

/**
 * Template-echo containment threshold (rule d-template-echo).
 *
 * A prose field fails when at least this fraction of its shingles appears
 * verbatim in the prompt/template text. Coincidental trigram overlap between
 * an honest field and a several-hundred-word template is normally below 0.10;
 * at 0.30 the field is substantially quoting the template rather than
 * describing the case.
 */
export const TEMPLATE_ECHO_NGRAM_OVERLAP_THRESHOLD = 0.3;

const TOKEN_RE = /[a-z0-9]+/g;

/** Lowercased alphanumeric word tokens; the canonical similarity tokenization. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

/** Consecutive word shingles (n-grams) of `text`, as joined token strings. */
export function wordShingles(text: string, size: number = SHINGLE_SIZE): string[] {
  const tokens = tokenize(text);
  const shingles: string[] = [];
  for (let i = 0; i + size <= tokens.length; i++) {
    shingles.push(tokens.slice(i, i + size).join(' '));
  }
  return shingles;
}

function setIntersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const value of a) {
    if (b.has(value)) n++;
  }
  return n;
}

/** Shingle-set Jaccard similarity in [0, 1]; below the shingle window it falls back to token-set Jaccard. */
export function jaccardSimilarity(a: string, b: string, size: number = SHINGLE_SIZE): number {
  const sa = new Set(wordShingles(a, size));
  const sb = new Set(wordShingles(b, size));
  if (sa.size === 0 || sb.size === 0) return tokenSetJaccard(a, b);
  const inter = setIntersectionSize(sa, sb);
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tokenSetJaccard(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = setIntersectionSize(ta, tb);
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Fraction of `text`'s shingles that appear verbatim in `source`, in [0, 1].
 * This is the template-echo measure: how much of a field is quoted from the
 * prompt/template, as opposed to how alike two fields are to each other.
 */
export function shingleContainment(text: string, source: string, size: number = SHINGLE_SIZE): number {
  const st = new Set(wordShingles(text, size));
  if (st.size === 0) return 0;
  const ss = new Set(wordShingles(source, size));
  if (ss.size === 0) return 0;
  return setIntersectionSize(st, ss) / st.size;
}
