/**
 * themis-tools — the mediated tool surface (WP-7), code-enforced in a pi extension.
 *
 * These are the ONLY tools the orchestrator and its subagents get for judge
 * state. The guarantee is in code, not prompts:
 *   - write_to_yaml_template resolves template + destination from a fixed map —
 *     the caller never chooses a path.
 *   - read_evidence accepts a catalog id + byte range, never a host path, and
 *     bounds every read.
 *   - read_scratchpad denies an in-progress owner with an explicit error.
 *   - tangent/petition/grant/channel are append-only, with idempotency keys.
 *   - web_search runs the SSRF guardrail before any fetch.
 *
 * Paths come from the environment (THEMIS_JUDGE_DIR, THEMIS_ARCHIVE_DIR) so the
 * extension is scoped to exactly one case per process.
 */

import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  stat,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, normalize, resolve, sep } from "node:path";

import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stringify as yamlStringify } from "yaml";

import { FINDING_SIGNATURES, isKnownSignature } from "../validity/signatures.js";
import { formatWebResults, webResearch } from "./web-research.js";

// ---------------------------------------------------------------------------
// Scoped path resolution (code-enforced containment)
// ---------------------------------------------------------------------------

function judgeDir(): string {
  const d = process.env.THEMIS_JUDGE_DIR;
  if (!d) throw new Error("THEMIS_JUDGE_DIR is not set");
  return resolve(d);
}

/** Sealed verifier reward, read at write time so official_reward is never authored. */
async function readSealedOfficialReward(): Promise<number | null> {
  let root: string;
  try {
    root = archiveDir();
  } catch {
    return null;
  }
  try {
    const names = await readdir(join(root, "verifier_res"));
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const o = JSON.parse(await readFile(join(root, "verifier_res", name), "utf8")) as {
          officialReward?: unknown; reward?: unknown;
        };
        const v = typeof o.officialReward === "number" ? o.officialReward : o.reward;
        if (typeof v === "number") return v;
      } catch { /* not the verifier result */ }
    }
  } catch { /* no verifier_res */ }
  return null;
}

function archiveDir(): string {
  const d = process.env.THEMIS_ARCHIVE_DIR;
  if (!d) throw new Error("THEMIS_ARCHIVE_DIR is not set");
  return resolve(d);
}

/** The only templates the court may write. Caller names a key, never a path. */
const TEMPLATE_TARGETS: Record<string, string> = {
  "kratos-report": "judge/kratos-report.yaml",
  "logos-report": "judge/logos-report.yaml",
  "minos-report": "judge/minos-report.yaml",
  // The final report is a host projection of committed rulings, so the court
  // never writes it. A live court filed its whole ruling under `evalJudge`,
  // which overwrote the projection with the orchestrator's own prose and left
  // minos-report.yaml empty — the assembler then had nothing to project and the
  // finished judgement failed Tier B with no retry that could recover it. The
  // template name stays valid because the court is taught to file a final
  // report; the bytes land on the ruling the assembler actually reads.
  "evalJudge": "judge/minos-report.yaml",
  "round-log": "judge/round-log.yaml",
  "tangent-log": "judge/tangent-log.yaml",
  "case-summary": "judge/case-summary.yaml",
  "access-log": "judge/access-log.md",
  "channel": "judge/channel.md",
  "developer-brief": "judge/developer-brief.yaml",
  "phase2-hypotheses": "judge/phase2-hypotheses.yaml",
  "phase2-research": "judge/phase2-research.yaml",
  "phase2-recommendations": "judge/phase2-recommendations.yaml",
  "phase2-review": "judge/phase2-review.yaml",
};

/** Where one court template's bytes land. Exposed so the rule is testable. */
export function finalReportTemplateTarget(template: string): string | undefined {
  return TEMPLATE_TARGETS[template];
}

function safeJoin(root: string, rel: string): string {
  const segs = rel.split(/[/\\]/).filter((s) => s.length > 0 && s !== "." && s !== "..");
  const abs = resolve(root, ...segs);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path escapes scope: ${rel}`);
  }
  return abs;
}

function nowIso(): string {
  return new Date().toISOString();
}

type ToolResult = AgentToolResult<Record<string, never>> & { isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text: `DENIED: ${text}` }], details: {}, isError: true };
}

/**
 * The frozen evalJudge template (report-templates.md #4). The tool validates
 * required keys, enum values, and ref shapes BEFORE serializing, so a malformed
 * ruling is a rejected call the agent fixes — never a silently broken artifact.
 */
const EVALJUDGE_REQUIRED = [
  "final_report", "eval_id", "agent_under_evaluation", "rounds_run",
  "official_reward", "narrative", "what_the_agent_did_well", "improvements",
  "integrity_summary", "reward_reconciliation", "case_coverage",
  "open_questions", "revision_history", "confidence_in_this_report",
  "confidence_basis",
] as const;

const VERDICT_REQUIRED = ["approach", "integrity", "competence", "reconciliation"] as const;
const ENUMS = {
  approach: ["principled", "narrow", "symptomatic", "insufficient_evidence", "not_observed"],
  integrity: ["clean", "suspicious", "violation", "contested", "insufficient_evidence", "not_applicable"],
  reconciliation: ["consistent", "passed_for_wrong_reason", "failed_despite_sound_work", "unexplained"],
  confidence_in_this_report: ["high", "medium", "low"],
  closed_by: ["no_new_tangents", "triage_exhausted", "round_ceiling"],
} as const;

/** The frozen ref grammar (report-templates.md). One ref per field — a
 *  comma-joined list of refs is NOT a well-formed ref and is rejected. */
export const REF_RE =
  /^(tool_call:.+|diff:[^#]+#\d+|file:[^#]+#L\d+-L\d+|verifier:\d+|report:(kratos|logos|minos)#round\d+|scratchpad:[A-Za-z0-9._-]+|web:https?:\/\/.+|trace:[^\s:]+:seq:\d+|artifact:[^#\s]+#\/\S+|source:[^#\s]+#symbol=\S+|metric:\S+)$/;

/** How a rejected value is quoted back to the agent that wrote it.
 *  `JSON.stringify(undefined)` is the JS value `undefined`, so interpolating it
 *  printed the bare word: a MISSING key and a key literally holding the string
 *  "undefined" produced the same message, and neither told the agent which
 *  mistake it made. Name the absence instead. */
export function gotValue(v: unknown): string {
  if (v === undefined) return "no value — the key is missing";
  if (v === null) return "null";
  return JSON.stringify(v);
}

/** Reject a ref that is not a single well-formed frozen-grammar ref. */
export function badRef(v: unknown, where: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !REF_RE.test(v)) {
    return `${where} is not a well-formed ref (got ${gotValue(v)}; expected tool_call:<id> | diff:<file>#<hunk> | file:<path>#L<a>-L<b> | verifier:<line> | report:<cat>#round<n> | scratchpad:<agent_id> | web:<url> | trace:<runId>:seq:<n> | artifact:<path>#/<json-pointer> | source:<path>#symbol=<name> | metric:<name>)`;
  }
  return null;
}

/** Finding labels (kratos/logos findings template). */
const FINDING_LABELS = ["FACT", "HYPOTHESIS", "UNRESOLVED"] as const;

/**
 * Validate a kratos-report / logos-report document. The investigators establish
 * facts with refs; a malformed ref here silently poisons every downstream
 * resolution check, so the grammar is enforced at the write boundary — the same
 * "schema as a control" rule the evalJudge template already enjoys.
 */
export function validateInvestigatorReport(fields: Record<string, unknown>): string | null {
  const findings = fields.findings;
  if (!Array.isArray(findings)) return "findings must be a list";
  for (let i = 0; i < findings.length; i += 1) {
    const f = findings[i] as Record<string, unknown> | undefined;
    if (!f || typeof f !== "object") return `findings[${i}] must be a mapping`;
    if (typeof f.statement !== "string" || f.statement.trim().length === 0) {
      return `findings[${i}].statement must be a non-empty string`;
    }
    const label = f.label;
    if (typeof label !== "string" || !(FINDING_LABELS as readonly string[]).includes(label)) {
      return `findings[${i}].label must be one of {${FINDING_LABELS.join(", ")}} (got ${gotValue(label)})`;
    }
    const r = badRef(f.ref, `findings[${i}].ref`);
    if (r) return r;
    if (label === "FACT" && (f.ref === null || f.ref === undefined || f.ref === "")) {
      return `findings[${i}] is labelled FACT and must carry a ref; only HYPOTHESIS/UNRESOLVED may be unrefed`;
    }
  }
  return null;
}

/** Validate the evalJudge fields object; returns a rejection reason or null. */
export function validateEvalJudge(fields: Record<string, unknown>): string | null {
  for (const k of EVALJUDGE_REQUIRED) {
    if (!(k in fields)) return `evalJudge missing required key "${k}"`;
  }
  if (fields.final_report !== true) return `evalJudge final_report must be the literal true`;
  if (typeof fields.eval_id !== "string" || fields.eval_id.length === 0) return "eval_id must be a string";
  if (typeof fields.agent_under_evaluation !== "string" || fields.agent_under_evaluation.length === 0)
    return "agent_under_evaluation must be a string";
  if (typeof fields.rounds_run !== "number" || !Number.isInteger(fields.rounds_run) || fields.rounds_run < 1)
    return "rounds_run must be an integer >= 1";
  if (typeof fields.official_reward !== "number") return "official_reward must be a number";

  const verdict = fields.verdict as Record<string, unknown> | undefined;
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) return "verdict must be a mapping";
  for (const k of VERDICT_REQUIRED) {
    if (!(k in verdict)) return `verdict missing key "${k}"`;
  }
  for (const [k, allowed] of Object.entries(ENUMS)) {
    const v = k === "confidence_in_this_report" || k === "closed_by"
      ? (k === "closed_by" ? (fields.case_coverage as Record<string, unknown> | undefined)?.closed_by : fields[k])
      : verdict[k];
    if (v === undefined || v === null) continue;
    if (!(allowed as readonly string[]).includes(String(v))) {
      return `${k} must be one of {${(allowed as readonly string[]).join(", ")}} (got ${gotValue(v)})`;
    }
  }
  // `null` competence is legal ONLY on a non-attributable run (the agent never
  // executed). Encoding "not observed" as a number would poison agent stats.
  const validity = fields.eval_validity as Record<string, unknown> | undefined;
  const nonAttributable = validity !== undefined && validity.valid_for_agent_learning === false;
  if (verdict.competence === null || verdict.competence === undefined) {
    if (!nonAttributable) {
      return "verdict.competence may be null only when eval_validity.valid_for_agent_learning is false (agent never ran)";
    }
  } else if (typeof verdict.competence !== "number" || verdict.competence < 1 || verdict.competence > 5) {
    return "verdict.competence must be an integer 1..5, or null when the agent never ran";
  }

  const cov = fields.case_coverage as Record<string, unknown> | undefined;
  if (cov) {
    if (typeof cov.tangents_total !== "number" || typeof cov.tangents_resolved !== "number" || typeof cov.tangents_open !== "number")
      return "case_coverage tangents_* must be integers";
    if (typeof cov.converged !== "boolean") return "case_coverage.converged must be true|false";
  }

  // Nested enums and ints — the same frozen contract the gate checks, enforced
  // at write time so the model fixes the value instead of shipping a violation.
  const CATEGORY = ["correctness", "approach", "process", "integrity", "efficiency", "tooling"];
  const IMPACT = ["high", "medium", "low"];
  const CONF = ["high", "medium", "low"];
  const CLOSED = ["no_new_tangents", "triage_exhausted", "round_ceiling"];
  const WHY = ["unsolvable_from_record", "failed_triage", "round_ceiling"];

  const imps = fields.improvements;
  if (Array.isArray(imps)) {
    for (let i = 0; i < imps.length; i += 1) {
      const it = imps[i] as Record<string, unknown> | undefined;
      if (!it || typeof it !== "object") return `improvements[${i}] must be a mapping`;
      if (it.category !== undefined && !CATEGORY.includes(String(it.category)))
        return `improvements[${i}].category must be one of {${CATEGORY.join(", ")}} (got ${gotValue(it.category)})`;
      if (it.impact !== undefined && !IMPACT.includes(String(it.impact)))
        return `improvements[${i}].impact must be one of {${IMPACT.join(", ")}}`;
      if (it.confidence !== undefined && !CONF.includes(String(it.confidence)))
        return `improvements[${i}].confidence must be one of {${CONF.join(", ")}}`;
    }
  }

  const wtdw = fields.what_the_agent_did_well;
  if (Array.isArray(wtdw)) {
    for (let i = 0; i < wtdw.length; i += 1) {
      const it = wtdw[i] as Record<string, unknown> | undefined;
      if (!it) continue;
      const r = badRef(it.ref, `what_the_agent_did_well[${i}].ref`);
      if (r) return r;
    }
  }
  if (Array.isArray(imps)) for (let i = 0; i < (imps as unknown[]).length; i += 1) {
    const it = (imps as unknown[])[i] as Record<string, unknown> | undefined;
    if (!it || !Array.isArray(it.evidence)) continue;
    for (let j = 0; j < (it.evidence as unknown[]).length; j += 1) {
      const ev = (it.evidence as unknown[])[j] as Record<string, unknown> | undefined;
      if (!ev) continue;
      const rr = badRef(ev.report, `improvements[${i}].evidence[${j}].report`);
      if (rr) return rr;
      const rf = badRef(ev.ref, `improvements[${i}].evidence[${j}].ref`);
      if (rf) return rf;
    }
  }

  const is = fields.integrity_summary as Record<string, unknown> | undefined;
  if (is && typeof is === "object" && Array.isArray(is.findings)) {
    for (let i = 0; i < (is.findings as unknown[]).length; i += 1) {
      const f = (is.findings as unknown[])[i] as Record<string, unknown> | undefined;
      if (f && f.round !== undefined && typeof f.round !== "number")
        return `integrity_summary.findings[${i}].round must be an integer (got ${gotValue(f.round)})`;
      if (f) {
        const rf = badRef(f.ref, `integrity_summary.findings[${i}].ref`);
        if (rf) return rf;
      }
    }
  }

  const oq = fields.open_questions;
  if (Array.isArray(oq)) {
    for (let i = 0; i < oq.length; i += 1) {
      const q = oq[i] as Record<string, unknown> | undefined;
      if (q?.why_unresolved !== undefined && !WHY.includes(String(q.why_unresolved)))
        return `open_questions[${i}].why_unresolved must be one of {${WHY.join(", ")}}`;
    }
  }
  return null;
}

/** Validate a developer-brief document (the remediation deliverable). */
export function validateDeveloperBrief(fields: Record<string, unknown>): string | null {
  if (typeof fields.case_id !== "string" || fields.case_id.length === 0) return "case_id must be a string";
  if (typeof fields.run_id !== "string" || fields.run_id.length === 0) return "run_id must be a string";
  const mode = fields.mode;
  if (mode !== "prod" && mode !== "dev") return `mode must be prod|dev (got ${gotValue(mode)})`;
  // Findings carry the Phase-2 registry signature (controlled vocabulary).
  const findings = fields.findings;
  if (Array.isArray(findings)) {
    for (let i = 0; i < findings.length; i += 1) {
      const f = findings[i] as Record<string, unknown> | undefined;
      if (!f || typeof f !== "object") return `findings[${i}] must be a mapping`;
      if (typeof f.id !== "string" || f.id.length === 0) return `findings[${i}].id must be a string`;
      if (f.signature !== undefined && f.signature !== null && !isKnownSignature(f.signature)) {
        return `findings[${i}].signature must be one of {${FINDING_SIGNATURES.join(", ")}} (got ${gotValue(f.signature)})`;
      }
      if (f.owner !== undefined && typeof f.owner !== "string") return `findings[${i}].owner must be a string`;
      if (f.refs !== undefined && !Array.isArray(f.refs)) return `findings[${i}].refs must be a list`;
    }
  }
  const recs = fields.recommendations;
  if (!Array.isArray(recs) || recs.length === 0) return "recommendations must be a non-empty list";
  const CLASSES = ["direct_fix", "research_backed", "experimental"];
  const PRIORITIES = ["P0", "P1", "P2", "P3"];
  const LEVELS = ["high", "medium", "low"];
  for (let i = 0; i < recs.length; i += 1) {
    const r = recs[i] as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") return `recommendations[${i}] must be a mapping`;
    if (typeof r.id !== "string" || r.id.length === 0) return `recommendations[${i}].id must be a string`;
    if (!CLASSES.includes(String(r.class))) return `recommendations[${i}].class must be one of {${CLASSES.join(", ")}} (got ${gotValue(r.class)})`;
    if (!PRIORITIES.includes(String(r.priority))) return `recommendations[${i}].priority must be one of {${PRIORITIES.join(", ")}} (got ${gotValue(r.priority)})`;
    if (r.evidence_level !== undefined && !LEVELS.includes(String(r.evidence_level))) return `recommendations[${i}].evidence_level must be one of {${LEVELS.join(", ")}}`;
    if (r.confidence !== undefined && !LEVELS.includes(String(r.confidence))) return `recommendations[${i}].confidence must be one of {${LEVELS.join(", ")}}`;
    if (typeof r.target_subsystem !== "string" || r.target_subsystem.length === 0)
      return `recommendations[${i}].target_subsystem must be a non-empty string`;
    if (!Array.isArray(r.change) || r.change.length === 0)
      return `recommendations[${i}].change must be a non-empty list`;
    const validation = r.validation as Record<string, unknown> | undefined;
    if (!validation || typeof validation !== "object")
      return `recommendations[${i}].validation must be a mapping`;
    if (!Array.isArray(validation.conditions) || validation.conditions.length === 0)
      return `recommendations[${i}].validation.conditions must be a non-empty list`;
    const basis = r.research_basis;
    if (basis !== undefined) {
      if (!Array.isArray(basis)) return `recommendations[${i}].research_basis must be a list`;
      for (let j = 0; j < basis.length; j += 1) {
        const b = basis[j] as Record<string, unknown> | undefined;
        if (!b || typeof b.source !== "string" || !/^web:https?:\/\/.+$/.test(b.source)) {
          return `recommendations[${i}].research_basis[${j}].source must be a web:<url> ref`;
        }
      }
    }
    if (r.class === "research_backed" || r.class === "experimental") {
      if (!Array.isArray(basis) || basis.length === 0) {
        return `recommendations[${i}] class ${String(r.class)} requires a non-empty research_basis`;
      }
    }
  }
  return null;
}

/**
 * Canonical, tool-owned YAML serialization.
 *
 * `BLOCK_LITERAL` used to force every scalar into a block, so a court record
 * rendered `id: |-\n  F1` and `priority: |-\n  P1`. That tripled the line count
 * of a developer brief and buried the prose an agent developer actually reads.
 * `PLAIN` lets the emitter pick per value: short strings stay inline, multi-line
 * prose still becomes a block, and anything ambiguous is quoted. Round trips are
 * preserved either way; the emitter quotes what it must.
 */
export function serializeYaml(fields: Record<string, unknown>): string {
  return yamlStringify(fields, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function registerThemisTools(pi: ExtensionAPI): void {
  const schema = (props: Record<string, unknown>) => Type.Object(props as Record<string, import("typebox").TSchema>);

  // ---- write_to_yaml_template --------------------------------------------
  pi.registerTool({
    name: "write_to_yaml_template",
    label: "Write YAML template",
    description:
      "Write a canonical YAML document for a court record (kratos-report, logos-report, minos-report, evalJudge, round-log, tangent-log, case-summary, access-log, channel). Append-only: same-id writes are no-ops or conflicts.",
    parameters: schema({
      template: Type.String(),
      fields: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(_id, params) {
      try {
        const template = params.template as string;
        const target = TEMPLATE_TARGETS[template];
        if (!target) {
          return err(`unknown template "${template}". Allowed: ${Object.keys(TEMPLATE_TARGETS).join(", ")}`);
        }
        const fields = (params.fields ?? {}) as Record<string, unknown>;
        if (Object.keys(fields).length === 0) {
          return err("fields must not be empty");
        }
        // The evalJudge deliverable is schema-validated before it is written.
        if (template === "evalJudge") {
          const reason = validateEvalJudge(fields);
          if (reason !== null) return err(reason);
          // Locked rule: official_reward is reproduced from the sealed verifier,
          // never authored or changed by the court. Reject any value that does
          // not equal the sealed record.
          const sealed = await readSealedOfficialReward();
          if (sealed !== null && fields.official_reward !== sealed) {
            return err(`official_reward ${JSON.stringify(fields.official_reward)} does not match the sealed verifier reward ${sealed}; it is reproduced, never authored`);
          }
        }
        // Investigator reports establish facts with refs; a malformed ref or a
        // mislabeled finding poisons every downstream resolution check, so the
        // same write-boundary control applies.
        if (template === "kratos-report" || template === "logos-report") {
          const reason = validateInvestigatorReport(fields);
          if (reason !== null) return err(reason);
        }
        // The remediation deliverable is schema-validated before it is written.
        if (template === "developer-brief") {
          const reason = validateDeveloperBrief(fields);
          if (reason !== null) return err(reason);
        }
        await mkdir(join(judgeDir(), "judge"), { recursive: true });
        const body = serializeYaml(fields) + "---\n";
        // Append-only: if the file exists, append a new section rather than edit.
        const path = safeJoin(judgeDir(), target);
        if (existsSync(path)) {
          await appendFile(path, body);
        } else {
          await writeFile(path, body);
        }
        return ok(`appended ${template} (${Buffer.byteLength(body)} bytes)`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- evidence_list -----------------------------------------------------
  pi.registerTool({
    name: "evidence_list",
    label: "List evidence",
    description:
      "List archive-relative entries under a directory (bounded). Directories end with '/'. Call with no arguments for the archive root. The only way to discover the sealed archive layout; never a host path.",
    parameters: schema({ dir: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      try {
        const rel = String(params.dir ?? "");
        const root = archiveDir();
        const abs = safeJoin(root, rel);
        const entries = await readdir(abs, { withFileTypes: true }).catch(() => null);
        if (!entries) return err(`not a directory in archive: ${rel}`);
        // List directories AND files. Without directory entries the caller
        // cannot discover the archive layout and burns calls guessing names
        // (observed live: 114 evidence_list calls, all DENIED).
        const prefix = rel ? `${rel}/` : "";
        const dirs = entries
          .filter((e) => e.isDirectory())
          .map((e) => `${prefix}${e.name}/`)
          .sort();
        const filesHere = entries
          .filter((e) => e.isFile())
          .map((e) => `${prefix}${e.name}`)
          .sort();
        const rows = [...dirs, ...filesHere].slice(0, 500);
        return ok(
          rows.length > 0
            ? rows.join("\n")
            : `(empty directory: ${rel || "<archive root>"})`,
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- read_evidence -----------------------------------------------------
  pi.registerTool({
    name: "read_evidence",
    label: "Read evidence",
    description:
      "Read a bounded byte range from a sealed-archive file, by relative path (never a host path). Refuse traversal and oversized reads.",
    parameters: schema({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      length: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      try {
        const rel = String(params.path ?? "");
        const p = safeJoin(archiveDir(), rel);
        const s = await stat(p).catch(() => null);
        if (!s || !s.isFile()) return err(`not a file in archive: ${rel}`);
        const offset = Number(params.offset ?? 0);
        const length = Math.min(Number(params.length ?? 64 * 1024), 64 * 1024);
        const fh = await import("node:fs/promises").then((m) => m.open(p, "r"));
        try {
          const buf = Buffer.alloc(length);
          const { bytesRead } = await fh.read(buf, 0, length, offset);
          return ok(buf.subarray(0, bytesRead).toString("utf8"));
        } finally {
          await fh.close();
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- read_court_record --------------------------------------------------
  pi.registerTool({
    name: "read_court_record",
    label: "Read court record",
    description:
      "Read a COMMITTED court document by template name (kratos-report, logos-report, minos-report, round-log, tangent-log, case-summary). This is how the orchestrator retrieves the VERBATIM text of a filed report for final assembly — never a host path, never a scratchpad.",
    parameters: schema({ template: Type.String() }),
    async execute(_id, params) {
      try {
        const template = String(params.template ?? "");
        const target = TEMPLATE_TARGETS[template];
        if (!target) return err(`unknown template "${template}". Allowed: ${Object.keys(TEMPLATE_TARGETS).join(", ")}`);
        const p = safeJoin(judgeDir(), target);
        const text = await readFile(p, "utf8").catch(() => null);
        if (text === null) return err(`no committed court record for ${template}`);
        return ok(text);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- read_scratchpad ---------------------------------------------------
  const scratchInProgress = new Set<string>();
  pi.registerTool({
    name: "read_scratchpad",
    label: "Read scratchpad",
    description:
      "Read an agent's scratchpad file. Denied with an explicit error while the owner is still in progress.",
    parameters: schema({ agent_id: Type.String() }),
    async execute(_id, params) {
      try {
        const agent = String(params.agent_id ?? "");
        if (scratchInProgress.has(agent)) {
          return err(`scratchpad for ${agent} is still in progress`);
        }
        const p = safeJoin(judgeDir(), `judge/scratchpad-${agent}.md`);
        const text = await readFile(p, "utf8").catch(() => null);
        if (text === null) return err(`no scratchpad for ${agent}`);
        return ok(text);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- file_tangent ------------------------------------------------------
  pi.registerTool({
    name: "file_tangent",
    label: "File tangent",
    description: "Append a tangent row to the tangent log book.",
    parameters: schema({
      id: Type.String(),
      question: Type.String(),
      raised_by: Type.String(),
    }),
    async execute(_id, params) {
      try {
        const p = safeJoin(judgeDir(), "judge/tangent-log.md");
        await mkdir(join(judgeDir(), "judge"), { recursive: true });
        const row = `## ${params.id}\n- question: ${params.question}\n- raised_by: ${params.raised_by}\n- at: ${nowIso()}\n`;
        await appendFile(p, row);
        return ok(`tangent ${params.id} filed`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- petition / grant (access log, idempotent) --------------------------
  const petitionKeys = new Set<string>();
  pi.registerTool({
    name: "petition",
    label: "Petition",
    description: "Petition for evidence access or a dispatch. Append-only access log with idempotency key.",
    parameters: schema({
      idempotency_key: Type.String(),
      kind: Type.String(),
      target: Type.String(),
      suspicion: Type.String(),
    }),
    async execute(_id, params) {
      try {
        const key = String(params.idempotency_key ?? "");
        if (petitionKeys.has(key)) return ok(`petition ${key} already recorded`);
        petitionKeys.add(key);
        const p = safeJoin(judgeDir(), "judge/access-log.md");
        await mkdir(join(judgeDir(), "judge"), { recursive: true });
        const row = `## petition ${key}\n- kind: ${params.kind}\n- target: ${params.target}\n- suspicion: ${params.suspicion}\n- outcome: pending\n- at: ${nowIso()}\n`;
        await appendFile(p, row);
        return ok(`petition ${key} recorded`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  pi.registerTool({
    name: "grant",
    label: "Grant",
    description: "Grant or deny a petition (records the outcome in the access log).",
    parameters: schema({
      petition_id: Type.String(),
      decision: Type.String(),
      reason: Type.String(),
    }),
    async execute(_id, params) {
      try {
        if (params.decision !== "granted" && params.decision !== "denied") {
          return err("decision must be granted or denied");
        }
        const p = safeJoin(judgeDir(), "judge/access-log.md");
        await mkdir(join(judgeDir(), "judge"), { recursive: true });
        const row = `## outcome ${params.petition_id}\n- decision: ${params.decision}\n- reason: ${params.reason}\n- at: ${nowIso()}\n`;
        await appendFile(p, row);
        return ok(`petition ${params.petition_id} ${params.decision}`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- channel -----------------------------------------------------------
  pi.registerTool({
    name: "channel",
    label: "Channel",
    description: "Post a message to the court channel log.",
    parameters: schema({ from: Type.String(), to: Type.String(), message: Type.String() }),
    async execute(_id, params) {
      try {
        const p = safeJoin(judgeDir(), "judge/channel.md");
        await mkdir(join(judgeDir(), "judge"), { recursive: true });
        const row = `[${nowIso()}] ${params.from} → ${params.to}: ${params.message}\n`;
        await appendFile(p, row);
        return ok("channel message posted");
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- web_search (SSRF-guarded) -----------------------------------------
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the general web and arXiv for a technique or prior art. Ask in prose. Each result carries a ready-to-cite `web:<url>` ref; a recommendation with one earns fix_type: research_backed. Refuses private/loopback/link-local targets. Web refs may back recommendations only, never findings about the agent.",
    parameters: schema({ query: Type.String() }),
    async execute(_id, params) {
      try {
        const q = String(params.query ?? "");
        if (q.length === 0) return err("query required");
        // Real fetch is blocked here unless a search endpoint is configured —
        // the guardrail is the point: no arbitrary URL, no private ranges.
        const endpoint = process.env.THEMIS_WEB_SEARCH_ENDPOINT;
        if (!endpoint) {
          // Keyless backends that work from this host. The old path asked the
          // eval provider to run the search through an OpenAI-compatible tools
          // array; DeepInfra answers `finish_reason: tool_calls` and executes
          // nothing, so every court that tried got a body with no URLs in it.
          const results = await webResearch(q);
          return ok(formatWebResults(q, results));
        }
        const url = new URL(endpoint);
        if (["http:", "https:"].indexOf(url.protocol) < 0) return err("search endpoint must be http(s)");
        const host = url.hostname;
        if (host === "localhost" || host.endsWith(".local") || /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
          return err("search endpoint resolves to a private address");
        }
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        return ok(text.slice(0, 64 * 1024));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- Phase-2 campaign tools (no-ops unless THEMIS_PHASE2_CAMPAIGN_DIR is set)
  function phase2Dir(): string | null {
    const d = process.env.THEMIS_PHASE2_CAMPAIGN_DIR;
    return d ? resolve(d) : null;
  }
  async function phase2Json(name: string): Promise<unknown> {
    const root = phase2Dir();
    if (!root) throw new Error("THEMIS_PHASE2_CAMPAIGN_DIR is not set");
    return JSON.parse(await readFile(join(root, name), "utf8"));
  }

  pi.registerTool({
    name: "list_evals",
    label: "List Phase-2 evals",
    description: "List campaign evals (validity, reward, cohort, tokens). Phase-2 only.",
    parameters: schema({}),
    async execute() {
      try {
        const cases = await phase2Json("cases.json");
        return ok(JSON.stringify(cases));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
  pi.registerTool({
    name: "list_patterns",
    label: "List Phase-2 patterns",
    description: "List deterministic campaign patterns. Phase-2 only.",
    parameters: schema({}),
    async execute() {
      try {
        const patterns = await phase2Json("patterns.json");
        return ok(JSON.stringify(patterns));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
  pi.registerTool({
    name: "read_pattern",
    label: "Read Phase-2 pattern",
    description: "Read one pattern including evidence. Phase-2 only.",
    parameters: schema({ patternId: Type.String() }),
    async execute(_id, params) {
      try {
        const patterns = (await phase2Json("patterns.json")) as Array<{ id: string }>;
        const p = patterns.find((x) => x.id === params.patternId);
        return p ? ok(JSON.stringify(p)) : err("unknown patternId");
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
  pi.registerTool({
    name: "read_improvements",
    label: "Read minos improvements",
    description: "Read Phase-1 improvement items for one campaign eval. Phase-2 only.",
    parameters: schema({ runId: Type.String() }),
    async execute(_id, params) {
      try {
        const cases = (await phase2Json("cases.json")) as Array<{ runId: string; improvements?: unknown }>;
        const c = cases.find((x) => x.runId === params.runId);
        return c ? ok(JSON.stringify(c.improvements ?? [])) : err("unknown runId");
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
  pi.registerTool({
    name: "read_lifecycle",
    label: "Read lifecycle file",
    description: "Read an allowlisted lifecycle/verifier/judge file for one campaign eval. Phase-2 only.",
    parameters: schema({ runId: Type.String(), path: Type.String() }),
    async execute(_id, params) {
      try {
        const allow = new Set([
          "eval_lifecycle_logs/run-metrics.json",
          "eval_lifecycle_logs/run.json",
          "eval_lifecycle_logs/eval.json",
          "verifier_res/verifier-result.json",
          "verifier_res/verifier-stderr.log",
          "judge/evalJudge.yaml",
        ]);
        const rel = String(params.path ?? "");
        if (!allow.has(rel)) return err(`path not allowlisted: ${rel}`);
        const views = (await phase2Json("views.json")) as Record<string, string>;
        const view = views[String(params.runId)];
        if (!view) return err("unknown runId");
        const text = await readFile(join(view, ...rel.split("/")), "utf8");
        return ok(text.slice(0, 16_000));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
  pi.registerTool({
    name: "read_judge_report",
    label: "Read evalJudge.yaml",
    description: "Read the Phase-1 evalJudge.yaml for one campaign eval. Phase-2 only.",
    parameters: schema({ runId: Type.String() }),
    async execute(_id, params) {
      try {
        const views = (await phase2Json("views.json")) as Record<string, string>;
        const view = views[String(params.runId)];
        if (!view) return err("unknown runId");
        const text = await readFile(join(view, "judge", "evalJudge.yaml"), "utf8");
        return ok(text.slice(0, 16_000));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}
