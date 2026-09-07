/**
 * WP-14: derive the gate's ground-truth facts from a real sealed archive and a
 * real case working store.
 *
 * Tier B (groundedness) only means something if the facts come from the actual
 * archive: a ref is "real" when the archive contains the thing it points at.
 * Nothing here invents data — every set is populated by reading files that the
 * eval run and the courtroom actually produced.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { parseAllDocuments } from "yaml";

import type { ArchiveFacts as TierBFacts } from "./tier-b-grounded.js";
import type { ArchiveFacts as TierDFacts, TierDContext } from "./tier-d-usefulness.js";
import {
  canonicalNarrativeJoin,
  competenceScoreOf,
  confidenceBasisOf,
  integritySummaryOf,
  narrativeOf,
  openQuestionsOf,
  rewardReconciliationOf,
  str,
  verdictOf,
} from "./minos-projection.js";

async function walk(root: string, cap = 5000): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    if (out.length >= cap) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await rec(abs);
      else if (e.isFile()) out.push(abs);
    }
  }
  await rec(root);
  return out;
}

/**
 * Line count for `file:<path>#L<a>-L<b>` bounds.
 *
 * Counts newline bytes rather than decoding, so a BINARY archive entry (a
 * `.pyc` cache captured in a diff, for example) still has a real line count.
 * Skipping it instead made every ref to a binary artifact unresolvable, which
 * reads as "the judge invented that file" when the file is right there.
 */
async function countLines(path: string, maxBytes = 4 * 1024 * 1024): Promise<number | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > maxBytes) return null;
    const buf = await readFile(path);
    let newlines = 0;
    for (const byte of buf) if (byte === 0x0a) newlines += 1;
    // `split("\n").length` semantics: a trailing newline does not open a line.
    return buf.length === 0 ? 1 : newlines + (buf[buf.length - 1] === 0x0a ? 0 : 1);
  } catch {
    return null;
  }
}

/** Parse an append-only multi-document YAML stream into its mappings. */
function yamlDocs(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  try {
    for (const doc of parseAllDocuments(text)) {
      const v = doc.toJS() as unknown;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        out.push(v as Record<string, unknown>);
      }
    }
  } catch {
    // A malformed stream contributes no committed rows.
  }
  return out;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function asRecordArray(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x));
}

/**
 * Tool-call ids the archive itself records.
 *
 * The archive is the authority a `tool_call:` ref resolves against, so read the
 * canonical event stream and the adapter's native session log directly instead
 * of trusting a derived Node 0 file, which may be stale or from an older
 * extractor version.
 */
async function archiveToolCallIds(archiveDir: string, relPaths: readonly string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  const sources = relPaths.filter(
    (p) => p === "eval_lifecycle_logs/events.jsonl" || p.endsWith("/session.jsonl") || p === "session.jsonl",
  );
  for (const rel of sources) {
    const text = await readIfSmall(join(archiveDir, rel), 16 * 1024 * 1024);
    if (text === null) continue;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = typeof o.type === "string" ? o.type : "";
      if (type === "tool.call" || type === "tool.result") {
        if (typeof o.id === "string" && o.id) ids.add(o.id);
      } else if (typeof o.toolCallId === "string" && o.toolCallId) {
        ids.add(o.toolCallId);
      }
    }
  }
  return ids;
}

async function readIfSmall(path: string, maxBytes = 8 * 1024 * 1024): Promise<string | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > maxBytes) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Facts a judgement's refs can legitimately point at. */
export interface CaseFacts {
  tierB: TierBFacts;
  tierD: TierDContext;
}

/**
 * Read the sealed archive (+ the case work dir, when present) and produce the
 * fact sets the gate checks refs against.
 */
export async function collectArchiveFacts(input: {
  archiveDir: string;
  workDir?: string;
  templateText?: string;
}): Promise<CaseFacts> {
  const files = await walk(input.archiveDir);
  const relPaths = files.map((f) => relative(input.archiveDir, f).split(sep).join("/"));

  // file -> line count, for file:<path>#L<a>-L<b> bounds checks.
  const fileLines = new Map<string, number>();
  for (const abs of files) {
    const rel = relative(input.archiveDir, abs).split(sep).join("/");
    const lines = await countLines(abs);
    if (lines !== null) fileLines.set(rel, lines);
  }

  // tool_call ids. The archive's own event streams are authoritative; the Node 0
  // extraction is a convenience mirror and only adds to them.
  const toolCallIds = await archiveToolCallIds(input.archiveDir, relPaths);
  if (input.workDir) {
    const tc = await readIfSmall(join(input.workDir, "node0", "toolCalls.jsonl"));
    if (tc) {
      for (const line of tc.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t) as { id?: unknown; tool_call_id?: unknown };
          const id = o.id ?? o.tool_call_id;
          if (typeof id === "string" && id) toolCallIds.add(id);
        } catch {
          /* a malformed line is not a fact */
        }
      }
    }
  }

  // diff hunks per file, parsed from the archive's unified diffs.
  const diffs = new Map<string, Set<string>>();
  for (const rel of relPaths.filter((p) => p.endsWith(".patch") || p.endsWith(".diff"))) {
    const text = await readIfSmall(join(input.archiveDir, rel));
    if (!text) continue;
    let current: string | null = null;
    let n = 0;
    for (const line of text.split("\n")) {
      const plus = /^\+\+\+ [ab]\/(.+)$/.exec(line);
      if (plus) {
        current = plus[1]!;
        n = 0;
        if (!diffs.has(current)) diffs.set(current, new Set());
        continue;
      }
      if (current && line.startsWith("@@")) {
        n += 1;
        diffs.get(current)!.add(String(n));
      }
    }
  }

  // verifier output line numbers.
  const verifierLines = new Set<number>();
  for (const rel of relPaths.filter((p) => p.startsWith("verifier_res/"))) {
    const text = await readIfSmall(join(input.archiveDir, rel));
    if (!text) continue;
    const count = text.split("\n").length;
    for (let i = 1; i <= count; i += 1) verifierLines.add(i);
    break;
  }

  // ---- stable evidence IDs ------------------------------------------------
  // `trace:<runId>:seq:<n>` — the canonical event-stream positions. Line
  // numbers in a JSONL file shift whenever the writer changes; the `seq` a
  // record carries does not, so this is the durable way to cite a trajectory
  // moment.
  const traceSeqs = new Map<string, Set<number>>();
  for (const rel of ["eval_lifecycle_logs/events.jsonl", "session/session.jsonl"]) {
    const text = await readIfSmall(join(input.archiveDir, rel), 16 * 1024 * 1024);
    if (!text) continue;
    // A stream declares its own run identity once, in a leading header record,
    // and most later records omit it. Attributing only the records that repeat
    // `runId` would bury the rest in the anonymous bucket, so every ref to a
    // real moment in that stream would read as unresolvable.
    let streamRunId: string | undefined;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as {
          seq?: unknown;
          runId?: unknown;
          id?: unknown;
          kind?: unknown;
          metadata?: { runId?: unknown };
        };
        if (o.kind === "header") {
          const declared =
            typeof o.metadata?.runId === "string" && o.metadata.runId
              ? o.metadata.runId
              : typeof o.id === "string" && o.id
                ? o.id
                : undefined;
          if (declared) streamRunId = declared;
        }
        if (typeof o.seq !== "number") continue;
        const runId =
          typeof o.runId === "string" && o.runId ? o.runId : (streamRunId ?? "*");
        if (!traceSeqs.has(runId)) traceSeqs.set(runId, new Set());
        traceSeqs.get(runId)!.add(o.seq);
      } catch {
        /* a malformed line is not a fact */
      }
    }
  }

  // `artifact:<path>#/<json-pointer>` — a value inside a JSON artifact, and
  // `metric:<name>` — a named lifecycle measurement. Both are stable against
  // reformatting in a way `file:...#L12-L20` is not.
  const artifactPointers = new Map<string, Set<string>>();
  const metricNames = new Set<string>();
  // A verifier writes its structured result to stdout, so the archive holds it
  // under a `.log` name. Selecting on the extension alone would leave that
  // artifact unaddressable, so any small text body that parses as JSON counts.
  const jsonRels = relPaths.filter((p) => p.endsWith(".json") || p.endsWith(".log"));
  for (const rel of jsonRels) {
    const text = await readIfSmall(join(input.archiveDir, rel), 4 * 1024 * 1024);
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const pointers = new Set<string>();
    // Bounded walk: JSON pointers for every addressable node.
    const walk = (node: unknown, ptr: string, depth: number): void => {
      if (pointers.size >= 4000 || depth > 12) return;
      if (ptr) pointers.add(ptr);
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${ptr}/${i}`, depth + 1));
      } else if (typeof node === "object" && node !== null) {
        for (const [k, v] of Object.entries(node)) {
          // RFC 6901 escaping.
          const token = k.replace(/~/g, "~0").replace(/\//g, "~1");
          walk(v, `${ptr}/${token}`, depth + 1);
        }
      }
    };
    walk(parsed, "", 0);
    artifactPointers.set(rel, pointers);
    // Top-level measurement names from the metrics artifacts.
    if (/run-metrics\.json$|metrics\.json$/.test(rel) && typeof parsed === "object" && parsed !== null) {
      for (const k of Object.keys(parsed as Record<string, unknown>)) metricNames.add(k);
    }
  }

  // `source:<path>#symbol=<name>` — a symbol, not a line range.
  const sourceSymbols = new Map<string, Set<string>>();
  for (const rel of relPaths.filter((p) => /\.(ts|js|py|go|rs|java|rb)$/.test(p))) {
    const text = await readIfSmall(join(input.archiveDir, rel), 1024 * 1024);
    if (!text) continue;
    const names = new Set<string>();
    for (const m of text.matchAll(
      /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|func|interface|type|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      names.add(m[1]!);
    }
    if (names.size > 0) sourceSymbols.set(rel, names);
  }

  // Official reward: the verifier owns it; the gate reconciles against it.
  let officialReward = 0;
  for (const rel of relPaths.filter((p) => p.startsWith("verifier_res/") && p.endsWith(".json"))) {
    const text = await readIfSmall(join(input.archiveDir, rel));
    if (!text) continue;
    try {
      // The sealed verifier result names it `officialReward`; older/alternate
      // shapes used `reward`. Reading only `reward` silently defaulted the
      // reward to 0 and made every correct reward reproduction look like a
      // modification.
      const o = JSON.parse(text) as { officialReward?: unknown; reward?: unknown };
      const value = typeof o.officialReward === "number" ? o.officialReward : o.reward;
      if (typeof value === "number") {
        officialReward = value;
        break;
      }
    } catch {
      /* not the verifier result */
    }
  }

  // Committed court documents + the agents that own scratchpads.
  const committedReports = new Set<string>();
  const agentIds = new Set<string>();
  let tangentLogRows = 0;
  let committedRoundRows = 0;
  const labeledStatements: Array<{ label: string; ref: string | null }> = [];
  const minosProse: string[] = [];
  const approachVerdicts: string[] = [];
  const integrityVerdicts: string[] = [];
  const competenceScores: number[] = [];
  const reconciliationVerdicts: string[] = [];
  if (input.workDir) {
    const judgeDir = join(input.workDir, "node4", "judge");
    for (const abs of await walk(judgeDir, 500)) {
      const base = abs.split(sep).pop()!;
      // Court documents are append-only multi-document YAML streams written by
      // write_to_yaml_template. Line regexes cannot count their rows: the tool
      // emits JSON-quoted keys and block scalars (`"round": 1`), so every count
      // came back 0 and every honest report looked like it overstated coverage.
      const docs = /\.ya?ml$/.test(base) ? yamlDocs((await readIfSmall(abs)) ?? "") : [];

      const m = /^(kratos|logos|minos)-report\.ya?ml$/.exec(base);
      if (m) {
        const cat = m[1]!;
        agentIds.add(cat);
        const rounds = new Set<string>();
        for (const doc of docs) {
          const r = doc.round;
          if (typeof r === "number" && Number.isInteger(r)) rounds.add(String(r));
        }
        if (rounds.size === 0) rounds.add("1");
        for (const r of rounds) committedReports.add(`report:${cat}#round${r}`);
      }
      const sp = /^scratchpad-(.+)\.md$/.exec(base);
      if (sp) agentIds.add(sp[1]!);

      // The log books are append-only, but a model may file a second section for
      // the SAME round/tangent instead of one. The gate asks "how many rounds /
      // tangents are committed", so count DISTINCT identities, not raw document
      // count — a double-filed round log would otherwise overstate rounds_run.
      if (/^round-log\.ya?ml$/.test(base)) {
        const rounds = new Set<string>();
        for (const doc of docs) {
          const r = doc.round;
          if (typeof r === "number" && Number.isInteger(r)) rounds.add(String(r));
        }
        committedRoundRows = Math.max(committedRoundRows, rounds.size);
      }
      if (/^tangent-log\.ya?ml$/.test(base)) {
        const ids = new Set<string>();
        for (const doc of docs) {
          const id = asString(doc.tangent_id ?? doc.id);
          if (id) ids.add(id);
        }
        tangentLogRows = Math.max(tangentLogRows, ids.size || docs.length);
      }
      // The orchestrator has also filed tangents as a scratchpad-style markdown
      // log (`tangent-log.md`, one `## T-…` heading per tangent). Count those
      // too — dropping them made every such case read as "zero tangents logged".
      if (/^tangent-log\.md$/.test(base)) {
        const text = (await readIfSmall(abs)) ?? "";
        const headings = (text.match(/^##\s+(T-[A-Za-z0-9._-]+)/gm) ?? []).length;
        tangentLogRows = Math.max(tangentLogRows, headings);
      }

      if (/^(kratos|logos)-report\.ya?ml$/.test(base)) {
        for (const doc of docs) {
          // Template shape: findings: [{statement, label, ref}].
          for (const finding of asRecordArray(doc.findings)) {
            const label = asString(finding.label);
            if (label === null) continue;
            labeledStatements.push({ label, ref: asString(finding.ref) });
          }
          // Observed live shape: findings as "[FACT] …" prose lines, with refs
          // written inline in the frozen grammar.
          if (Array.isArray(doc.findings)) {
            for (const entry of doc.findings) {
              if (typeof entry !== "string") continue;
              const lm = /^\s*\[(FACT|HYPOTHESIS|UNRESOLVED)\]/.exec(entry);
              if (!lm) continue;
              const rm =
                /\b(tool_call:[^\s,;)"]+|diff:[^\s,;)"]+#\d+|file:[^\s,;)"]+#L\d+-L\d+|verifier:\d+|report:(?:kratos|logos|minos)#round\d+|scratchpad:[^\s,;)"]+)/.exec(
                  entry,
                );
              labeledStatements.push({ label: lm[1]!, ref: rm ? rm[1]! : null });
            }
          }
        }
      }
      if (/^minos-report\.ya?ml$/.test(base)) {
        for (const doc of docs) {
          const verdict = verdictOf(doc);
          const approach = asString(verdict.approach);
          if (approach) approachVerdicts.push(approach);
          const integrity = asString(verdict.integrity);
          if (integrity) integrityVerdicts.push(integrity);
          const competence = competenceScoreOf(doc);
          if (competence !== null) competenceScores.push(competence);
          const reconciliation = asString(verdict.reconciliation);
          if (reconciliation) reconciliationVerdicts.push(reconciliation);

          // Every prose string minos committed, resolved through the same
          // projection module the mechanical assembler uses — the two can never
          // disagree about what "a committed minos source" contains.
          const push = (v: string | null): void => {
            if (v) minosProse.push(v);
          };
          push(narrativeOf(doc));
          push(canonicalNarrativeJoin(doc));
          push(rewardReconciliationOf(doc, verdict));
          push(confidenceBasisOf(doc));
          push(str(doc.case_completeness ?? ""));
          push(str(doc.limitations ?? ""));
          for (const item of asRecordArray(doc.what_the_agent_did_well)) {
            push(asString(item.observation));
          }
          // The assembler projects BOTH improvement shapes verbatim: structured
          // objects (issue/recommendation) AND bare string-list entries (each
          // line becomes an issue). Register both so `b-verbatim-assembly` never
          // flags text minos actually committed.
          for (const item of asRecordArray(doc.improvements)) {
            for (const key of ["issue", "recommendation"]) {
              push(asString(item[key]));
            }
          }
          if (Array.isArray(doc.improvements)) {
            for (const entry of doc.improvements) {
              if (typeof entry === "string") push(entry);
            }
          }
          if (typeof doc.improvements === "string") {
            for (const line of doc.improvements.split("\n")) {
              const t = line.trim();
              if (t) push(t);
            }
          }
          for (const item of asRecordArray(doc.integrity_findings)) {
            push(asString(item.finding ?? item.statement));
          }
          for (const item of integritySummaryOf(doc, verdict).findings) {
            push(asString(item.finding));
          }
          for (const item of asRecordArray(doc.still_open)) {
            for (const key of ["question", "what_would_settle_it", "why_unresolved"]) {
              push(asString(item[key]));
            }
          }
          for (const item of openQuestionsOf(doc)) {
            push(item.question);
            push(item.what_would_settle_it);
          }
          for (const item of asRecordArray(doc.still_open)) {
            push(asString(item.would_it_change_ruling));
            push(asString(item.would_it_change_the_ruling));
          }
          for (const item of asRecordArray(doc.tangents)) {
            for (const key of ["tangent", "detail", "basis"]) {
              push(asString(item[key]));
            }
          }
        }
      }
    }
  }

  const tierB: TierBFacts = {
    toolCallIds,
    files: fileLines,
    diffs,
    verifierLines,
    committedReports,
    agentIds,
    // web_search is configured per-case; with no endpoint no web ref is legitimate.
    webUrls: new Set<string>(),
    traceSeqs,
    artifactPointers,
    sourceSymbols,
    metricNames,
    officialReward,
    tangentLogRows,
    committedRoundRows,
    labeledStatements,
    // Populated from committed kratos documents once dispositions are filed.
    dispositions: [],
    corroboration: [],
    minosCommitted: {
      approachVerdicts,
      integrityVerdicts,
      competenceScores,
      reconciliationVerdicts,
      prose: minosProse,
    },
    observationProvenance: new Map<string, string>(),
  };

  // Tier D: symbols/commands/tests actually present in the archive, so a
  // recommendation naming a real file/symbol/test is distinguishable from
  // generic advice.
  const symbols = new Set<string>();
  const tests = new Set<string>();
  for (const [rel] of fileLines) {
    if (!/\.(ts|js|py|go|rs|java|rb)$/.test(rel)) continue;
    const text = await readIfSmall(join(input.archiveDir, rel), 1024 * 1024);
    if (!text) continue;
    for (const m of text.matchAll(
      /(?:function|class|def|func|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      symbols.add(m[1]!);
    }
    for (const m of text.matchAll(/(?:it|test|describe)\(\s*["'`]([^"'`]{3,80})/g)) {
      tests.add(m[1]!);
    }
    if (/(^|\/)(test_|tests?\/)/.test(rel)) tests.add(rel);
  }

  const commands = new Set<string>();
  const EXEC_TOOLS = new Set(["bash", "exec", "shell", "run", "cmd"]);
  const addCommand = (full: string): void => {
    if (!full || full.length < 2) return;
    commands.add(full);
    // Split on shell control operators only (never on `\n`, which would turn a
    // heredoc body's Python lines into phony "commands").
    for (const segment of full.split(/(?:&&|;|\|\||\|)+/)) {
      const tok = /^([A-Za-z0-9_.-]{2,})/.exec(segment.trim());
      if (tok) commands.add(tok[1]!);
    }
  };
  // The agent's commands, from the canonical event stream + native session —
  // NOT the court's own tool calls. The archive view re-seals the judge/ tree
  // alongside the eval evidence, so scanning every `.jsonl` would credit the
  // orchestrator's `read_evidence`/`write_to_yaml_template` calls as if the
  // evaluated agent had issued them.
  for (const rel of ["eval_lifecycle_logs/events.jsonl", "session/session.jsonl"]) {
    const text = await readIfSmall(join(input.archiveDir, rel), 16 * 1024 * 1024);
    if (!text) continue;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = typeof o.type === "string" ? o.type : "";
      const isCanonical = type === "tool.call";
      const isNative = type === "tool_started";
      if (!isCanonical && !isNative) continue;
      const name = isCanonical ? o.name : o.toolName;
      if (typeof name !== "string" || !EXEC_TOOLS.has(name)) continue;
      const args = (isCanonical ? o.args : o.effectiveArgs) as Record<string, unknown> | undefined;
      const cmd = args && (typeof args.cmd === "string" ? args.cmd : args.command);
      if (typeof cmd === "string") addCommand(cmd);
    }
  }
  // raw_std carries the echoed commands too (shell prompt lines); scan only the
  // eval's own stdout/stderr, not the court's.
  for (const rel of relPaths.filter((p) => p.startsWith("raw_std/") && /\.(log|txt)$/.test(p))) {
    const text = await readIfSmall(join(input.archiveDir, rel), 2 * 1024 * 1024);
    if (!text) continue;
    for (const line of text.split("\n")) {
      for (const m of line.matchAll(/(?:^|[|&;]\s*|\$[ (])(python3?|node|npm|npx|pytest|tsx|go|rustc|cargo|java|ruby|gcc|make|git)\b/g)) {
        commands.add(m[1]!);
      }
    }
  }

  const tierD: TierDContext = {
    archive: {
      filePaths: relPaths,
      symbols: [...symbols],
      commands: [...commands],
      tests: [...tests],
      resolvingRefs: [],
    } as TierDFacts,
    templateText: input.templateText ?? "",
  };

  return { tierB, tierD };
}
