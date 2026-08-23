/**
 * Adapter from the on-disk fixture wire format (snake_case JSON) to the
 * in-memory ArchiveFacts shape the Tier B checks resolve against.
 *
 * This module exists because the two halves were authored independently: the
 * fixtures are a serialization format, ArchiveFacts is a Set/Map lookup shape.
 * Nothing bridged them, so the harness had never actually run against a real
 * fixture.
 *
 * Design rule: every missing or malformed field throws with the fixture name
 * and the JSON path. A loader that defaults a missing field to an empty Set
 * turns "the fixture cannot express this" into "the rule found no violations",
 * which is precisely the failure that let a green suite hide a broken harness.
 */

import type { ArchiveFacts } from './tier-b-grounded.ts';
import type { ArchiveFacts as TierDFacts } from './tier-d-usefulness.ts';
import type { Ref } from './types.ts';

/** Raw shape of a fixture archive-facts.json document. */
interface WireFacts {
  readonly schema?: string;
  readonly official_reward?: number;
  readonly archive_paths?: Readonly<Record<string, string>>;
  readonly files?: ReadonlyArray<{ path?: string; lines?: number }>;
  readonly tool_calls?: ReadonlyArray<{ id?: string }>;
  readonly hunks?: ReadonlyArray<{ file?: string; hunk?: string }>;
  readonly verifier?: { checks?: ReadonlyArray<{ line?: number }> };
  readonly documents?: Readonly<Record<string, { committed_rounds?: ReadonlyArray<number> }>>;
  readonly scratchpads?: ReadonlyArray<string>;
  readonly web_sources?: ReadonlyArray<{ url?: string }>;
  readonly tangent_log?: { total?: number };
  readonly corroboration?: ReadonlyArray<{
    claim?: string;
    asserted_by?: ReadonlyArray<string>;
    distinct_refs?: ReadonlyArray<string>;
    counted_as?: string;
  }>;
  readonly committed_statements?: {
    kratos?: ReadonlyArray<WireKratosRound>;
    logos?: ReadonlyArray<WireLogosRound>;
    minos?: ReadonlyArray<WireMinosRound>;
  };
  readonly minos_committed?: WireMinosCommitted;
  /** Optional alias map: ref → underlying_observation_id (attack-b1). */
  readonly observation_provenance?: ReadonlyArray<{
    ref?: string;
    underlying_observation_id?: string;
  }>;
}

interface WireFinding {
  readonly statement?: string;
  readonly label?: string;
  readonly ref?: string | null;
}

interface WireKratosRound {
  readonly round?: number;
  readonly disposition?: string;
  readonly findings?: ReadonlyArray<WireFinding>;
}

interface WireLogosRound {
  readonly round?: number;
  readonly labeled_statements?: ReadonlyArray<WireFinding>;
}

interface WireMinosRound {
  readonly round?: number;
}

interface WireMinosCommitted {
  readonly approach_verdicts?: ReadonlyArray<string>;
  readonly integrity_verdicts?: ReadonlyArray<string>;
  readonly competence_scores?: ReadonlyArray<number>;
  readonly reconciliation_verdicts?: ReadonlyArray<string>;
  readonly prose?: ReadonlyArray<string>;
}

/** Thrown when a fixture cannot be faithfully represented as ArchiveFacts. */
export class FixtureFormatError extends Error {
  constructor(
    readonly fixture: string,
    readonly jsonPath: string,
    detail: string,
  ) {
    super(`${fixture}: ${jsonPath}: ${detail}`);
    this.name = 'FixtureFormatError';
  }
}

const SUPPORTED_SCHEMA = 'judge-quality/archive-facts/1';

function require<T>(
  value: T | undefined | null,
  fixture: string,
  jsonPath: string,
  detail = 'required field is missing',
): T {
  if (value === undefined || value === null) {
    throw new FixtureFormatError(fixture, jsonPath, detail);
  }
  return value;
}

/**
 * Convert one parsed archive-facts.json into ArchiveFacts.
 * Throws FixtureFormatError on any field the wire format cannot supply.
 */
export function toArchiveFacts(raw: unknown, fixture: string): ArchiveFacts {
  if (typeof raw !== 'object' || raw === null) {
    throw new FixtureFormatError(fixture, '$', 'archive-facts.json is not an object');
  }
  const wire = raw as WireFacts;

  const schema = require(wire.schema, fixture, '$.schema');
  if (schema !== SUPPORTED_SCHEMA) {
    throw new FixtureFormatError(
      fixture,
      '$.schema',
      `unsupported schema ${schema}; this loader decodes ${SUPPORTED_SCHEMA}`,
    );
  }

  const officialReward = require(wire.official_reward, fixture, '$.official_reward');
  if (typeof officialReward !== 'number') {
    throw new FixtureFormatError(fixture, '$.official_reward', 'must be a number');
  }

  const files = new Map<string, number>();
  for (const [i, entry] of (require(wire.files, fixture, '$.files')).entries()) {
    const path = require(entry.path, fixture, `$.files[${i}].path`);
    const lines = require(entry.lines, fixture, `$.files[${i}].lines`);
    files.set(path, lines);
  }

  const toolCallIds = new Set<string>();
  for (const [i, call] of (require(wire.tool_calls, fixture, '$.tool_calls')).entries()) {
    toolCallIds.add(require(call.id, fixture, `$.tool_calls[${i}].id`));
  }

  const diffs = new Map<string, Set<string>>();
  for (const [i, hunk] of (require(wire.hunks, fixture, '$.hunks')).entries()) {
    const file = require(hunk.file, fixture, `$.hunks[${i}].file`);
    const id = require(hunk.hunk, fixture, `$.hunks[${i}].hunk`);
    let set = diffs.get(file);
    if (!set) {
      set = new Set<string>();
      diffs.set(file, set);
    }
    set.add(id);
  }

  const verifier = require(wire.verifier, fixture, '$.verifier');
  const verifierLines = new Set<number>();
  for (const [i, check] of (require(verifier.checks, fixture, '$.verifier.checks')).entries()) {
    verifierLines.add(require(check.line, fixture, `$.verifier.checks[${i}].line`));
  }

  const documents = require(wire.documents, fixture, '$.documents');
  const committedReports = new Set<string>();
  // Distinct round numbers, not one row per (category, round). Three categories
  // each committing rounds 1 and 2 is two committed rounds, not six — summing
  // them makes every fixture look like it under-reports rounds_run.
  const committedRounds = new Set<number>();
  for (const [category, doc] of Object.entries(documents)) {
    const rounds = require(
      doc?.committed_rounds,
      fixture,
      `$.documents.${category}.committed_rounds`,
    );
    for (const round of rounds) {
      committedReports.add(`report:${category}#round${round}`);
      committedRounds.add(round);
    }
  }
  const committedRoundRows = committedRounds.size;

  const agentIds = new Set(require(wire.scratchpads, fixture, '$.scratchpads'));

  const webUrls = new Set<string>();
  for (const [i, source] of (require(wire.web_sources, fixture, '$.web_sources')).entries()) {
    webUrls.add(require(source.url, fixture, `$.web_sources[${i}].url`));
  }

  const tangentLog = require(wire.tangent_log, fixture, '$.tangent_log');
  const tangentLogRows = require(tangentLog.total, fixture, '$.tangent_log.total');

  const corroboration = (require(wire.corroboration, fixture, '$.corroboration')).map(
    (entry, i) => ({
      claim: require(entry.claim, fixture, `$.corroboration[${i}].claim`),
      reports: [...require(entry.asserted_by, fixture, `$.corroboration[${i}].asserted_by`)],
      refs: [...require(entry.distinct_refs, fixture, `$.corroboration[${i}].distinct_refs`)],
      countedAs: require(entry.counted_as, fixture, `$.corroboration[${i}].counted_as`),
    }),
  );

  const statements = require(wire.committed_statements, fixture, '$.committed_statements');

  const labeledStatements: Array<{ label: string; ref: string | null }> = [];
  const dispositions: Array<{
    claim: string;
    disposition: string;
    findings: Array<{ label: string; ref: string | null }>;
  }> = [];

  const kratos = require(statements.kratos, fixture, '$.committed_statements.kratos');
  for (const [i, round] of kratos.entries()) {
    const base = `$.committed_statements.kratos[${i}]`;
    const findings = (require(round.findings, fixture, `${base}.findings`)).map((f, j) => ({
      label: require(f.label, fixture, `${base}.findings[${j}].label`),
      ref: f.ref ?? null,
    }));
    labeledStatements.push(...findings);
    dispositions.push({
      claim: (require(round.findings, fixture, `${base}.findings`))[0]?.statement ?? '',
      disposition: require(round.disposition, fixture, `${base}.disposition`),
      findings,
    });
  }

  const logos = require(statements.logos, fixture, '$.committed_statements.logos');
  for (const [i, round] of logos.entries()) {
    const base = `$.committed_statements.logos[${i}]`;
    const labeled = require(round.labeled_statements, fixture, `${base}.labeled_statements`);
    for (const [j, s] of labeled.entries()) {
      labeledStatements.push({
        label: require(s.label, fixture, `${base}.labeled_statements[${j}].label`),
        ref: s.ref ?? null,
      });
    }
  }

  // The b-verbatim-assembly rule compares the report's verdicts and prose against
  // the strings minos actually committed. The wire format has no minos source
  // block, so those strings are not recoverable from the fixture. Defaulting them
  // to empty arrays would make the rule vacuously pass on every fixture, so this
  // is a hard failure naming the missing field instead.
  const minos = require(
    wire.minos_committed,
    fixture,
    '$.minos_committed',
    'ArchiveFacts.minosCommitted has no wire representation. The b-verbatim-assembly rule ' +
      'compares report verdicts/prose against minos-committed source strings, and the fixture ' +
      'format cannot express them. Add a $.minos_committed block with approach_verdicts, ' +
      'integrity_verdicts, competence_scores, reconciliation_verdicts, and prose',
  );

  const minosCommitted = {
    approachVerdicts: [
      ...require(minos.approach_verdicts, fixture, '$.minos_committed.approach_verdicts'),
    ],
    integrityVerdicts: [
      ...require(minos.integrity_verdicts, fixture, '$.minos_committed.integrity_verdicts'),
    ],
    competenceScores: [
      ...require(minos.competence_scores, fixture, '$.minos_committed.competence_scores'),
    ],
    reconciliationVerdicts: [
      ...require(
        minos.reconciliation_verdicts,
        fixture,
        '$.minos_committed.reconciliation_verdicts',
      ),
    ],
    prose: [...require(minos.prose, fixture, '$.minos_committed.prose')],
  };

  const observationProvenance = new Map<string, string>();
  for (const [i, entry] of (wire.observation_provenance ?? []).entries()) {
    const ref = entry?.ref;
    const id = entry?.underlying_observation_id;
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new FixtureFormatError(
        fixture,
        `$.observation_provenance[${i}].ref`,
        'ref must be a non-empty string',
      );
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new FixtureFormatError(
        fixture,
        `$.observation_provenance[${i}].underlying_observation_id`,
        'underlying_observation_id must be a non-empty string',
      );
    }
    observationProvenance.set(ref, id);
  }

  return {
    toolCallIds,
    files,
    diffs,
    verifierLines,
    committedReports,
    agentIds,
    webUrls,
    officialReward,
    tangentLogRows,
    committedRoundRows,
    labeledStatements,
    dispositions,
    corroboration,
    minosCommitted,
    observationProvenance,
  };
}

/** Wire fields Tier D needs that Tier B's ArchiveFacts does not carry. */
interface WireTierDExtras {
  readonly hunks?: ReadonlyArray<{ summary?: string }>;
  readonly verifier?: { checks?: ReadonlyArray<{ name?: string }> };
  readonly tool_calls?: ReadonlyArray<{ tool_name?: string }>;
}

/** Identifier-shaped tokens (function/class/method names) inside free text. */
function extractSymbols(text: string): string[] {
  return [...text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)]
    .map((m) => m[0])
    .filter((word) => /[_A-Z]/.test(word.slice(1)) || word.includes('_'));
}

/**
 * Convert one parsed archive-facts.json into the Tier D fact shape.
 *
 * Tier D declares its own `ArchiveFacts` — a different structure that happens to
 * share the name with Tier B's. They are not interchangeable, and because
 * tsconfig excludes `tests/`, passing one where the other is required compiles
 * cleanly and fails at runtime. Both loaders are therefore explicit and separate.
 */
export function toTierDFacts(raw: unknown, fixture: string): TierDFacts {
  if (typeof raw !== 'object' || raw === null) {
    throw new FixtureFormatError(fixture, '$', 'archive-facts.json is not an object');
  }
  const wire = raw as WireFacts & WireTierDExtras;
  const base = toArchiveFacts(raw, fixture);

  // `files[]` is the source-tree evidence the refs resolve against, but a
  // recommendation may legitimately name an archive artifact instead ("inspect
  // the provisioning log under eval.json"). Both are paths that resolve in the
  // archive, so d-actionability must see both or it rejects recommendations
  // that point at real, addressable evidence.
  const filePaths = [...new Set([...base.files.keys(), ...Object.values(wire.archive_paths ?? {})])];

  // Symbols are not a first-class wire field; hunk summaries are where the
  // fixture names the functions the change touched.
  const symbols = new Set<string>();
  for (const hunk of wire.hunks ?? []) {
    for (const symbol of extractSymbols(hunk.summary ?? '')) symbols.add(symbol);
  }

  const commands = new Set<string>();
  for (const call of wire.tool_calls ?? []) {
    if (call.tool_name) commands.add(call.tool_name);
  }

  const tests = new Set<string>();
  for (const check of wire.verifier?.checks ?? []) {
    if (check.name) tests.add(check.name);
  }
  for (const path of filePaths) {
    if (/\btests?\b|\.test\.|\.spec\./.test(path)) tests.add(path);
  }

  return {
    filePaths,
    symbols: [...symbols],
    commands: [...commands],
    tests: [...tests],
    // Filled in by withResolvingRefs once the report is known: `resolvingRefs`
    // is the set of refs THIS REPORT cites that resolve, not every ref the
    // archive could theoretically produce. Enumerating the archive instead
    // yields refs like `file:src/parse.ts#L1-L120` that never string-match a
    // report's `#L34-L38`, silently undercounting calibration evidence.
    resolvingRefs: [],
  };
}

/**
 * Bind a report's resolving refs into its Tier D facts.
 * Tier B owns ref resolution, so this delegates rather than re-implementing it.
 */
export function withResolvingRefs(
  tierD: TierDFacts,
  resolvingRefs: readonly Ref[],
): TierDFacts {
  return { ...tierD, resolvingRefs };
}
