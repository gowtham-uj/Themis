/** Validate retained native evidence without modifying the original artifacts. */

import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { Ref } from "../judge/verdict.js";
import type { RunMetrics } from "./metrics.js";

export const EVIDENCE_INTEGRITY_SCHEMA_VERSION = 1 as const;

export type EvidenceIntegrityStatus = "valid" | "invalid" | "contradictory" | "unknown";
export type EvidenceOwnerClass = "agent" | "platform" | "judge" | "eval";

export interface EvidenceIntegrityCheck {
  id: string;
  status: EvidenceIntegrityStatus;
  artifactPath: string;
  refs: Ref[];
  observed: string;
  interpretation: string;
  ownerClass: EvidenceOwnerClass;
  scoringSafe: boolean;
}

export interface EvidenceIntegrityReport {
  schemaVersion: typeof EVIDENCE_INTEGRITY_SCHEMA_VERSION;
  runId: string;
  checks: EvidenceIntegrityCheck[];
  safeForScoring: boolean;
}

/** Inspect known Reaper evidence files and report exact integrity boundaries. */
export async function analyzeEvidenceIntegrity(input: {
  runId: string;
  retainedDir: string;
  metrics: RunMetrics;
}): Promise<EvidenceIntegrityReport> {
  const checks: EvidenceIntegrityCheck[] = [];
  for (const path of await walkFiles(input.retainedDir)) {
    const name = basename(path);
    if (name !== "reaper-result.json" && name !== "trajectory-metrics.json") continue;
    const artifactPath = relative(join(input.retainedDir, ".."), path).split(sep).join("/");
    const refs: Ref[] = [{ kind: "artifact", path: artifactPath }];
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
      checks.push({
        id: `${name}:json-valid`,
        status: "valid",
        artifactPath,
        refs,
        observed: "Artifact parses as exactly one JSON value.",
        interpretation: "The artifact is structurally safe to inspect.",
        ownerClass: "agent",
        scoringSafe: true,
      });
    } catch {
      checks.push({
        id: `${name}:json-invalid`,
        status: "invalid",
        artifactPath,
        refs,
        observed: describesMalformedJson(raw),
        interpretation: "Do not use this native artifact as authoritative scoring evidence.",
        ownerClass: "agent",
        scoringSafe: false,
      });
      continue;
    }

    const emptyToolIds = findEmptyToolIdentifiers(parsed);
    if (emptyToolIds.length > 0) {
      checks.push({
        id: `${name}:empty-tool-identifiers`,
        status: "invalid",
        artifactPath,
        refs,
        observed: `Empty tool identifiers at ${emptyToolIds.slice(0, 8).join(", ")}.`,
        interpretation: "Tool evidence cannot be reliably correlated to canonical calls.",
        ownerClass: "agent",
        scoringSafe: false,
      });
    }

    if (name === "trajectory-metrics.json") {
      checks.push(...metricContradictions(parsed, artifactPath, refs, input.metrics));
    }
  }

  if (checks.length === 0) {
    checks.push({
      id: "native-evidence:not-present",
      status: "unknown",
      artifactPath: "retained/",
      refs: [],
      observed: "No known Reaper result or trajectory metrics artifact was retained.",
      interpretation: "Use canonical events and platform metrics; no native summary was available.",
      ownerClass: "platform",
      scoringSafe: true,
    });
  }

  return {
    schemaVersion: EVIDENCE_INTEGRITY_SCHEMA_VERSION,
    runId: input.runId,
    checks,
    safeForScoring: checks.every((check) => check.scoringSafe),
  };
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return out;
    throw err;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

function describesMalformedJson(raw: string): string {
  const trimmed = raw.trim();
  const firstObject = trimmed.indexOf("{");
  const firstArray = trimmed.indexOf("[");
  const firstJson = [firstObject, firstArray].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (firstJson !== undefined && firstJson > 0) {
    return `Artifact contains ${firstJson} non-JSON characters before a JSON-looking value.`;
  }
  return "Artifact is not exactly one valid JSON value.";
}

function findEmptyToolIdentifiers(value: unknown, path = "$", out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findEmptyToolIdentifiers(entry, `${path}[${index}]`, out));
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    const isToolResultId =
      key === "id" && /(?:toolResults|tool_results|tools)\[\d+\]$/i.test(path);
    if (
      ["tool_call_id", "toolCallId", "decision_id", "decisionId"].includes(key) ||
      isToolResultId
    ) {
      if (typeof child !== "string" || child.trim().length === 0) out.push(childPath);
    }
    findEmptyToolIdentifiers(child, childPath, out);
  }
  return out;
}

function metricContradictions(
  value: unknown,
  artifactPath: string,
  refs: Ref[],
  metrics: RunMetrics,
): EvidenceIntegrityCheck[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const checks: EvidenceIntegrityCheck[] = [];
  const record = value as Record<string, unknown>;
  const nativeMutations = firstFiniteNumber(record, [
    "files_edited",
    "filesEdited",
    "edit_count",
    "editCount",
    "total_edits",
    "totalEdits",
  ]);
  const nativeVerifications = firstFiniteNumber(record, [
    "verification_attempts",
    "verificationAttempts",
    "verification_count",
    "verificationCount",
  ]);
  const nativeVerified = firstBoolean(record, ["verified_completion", "verifiedCompletion"]);

  if (nativeMutations === 0 && metrics.mutationCount > 0) {
    checks.push(contradiction(
      "trajectory-metrics:mutation-count",
      artifactPath,
      refs,
      `Native metrics report zero edits while canonical events contain ${metrics.mutationCount} recognized mutation(s).`,
    ));
  }
  if (nativeVerifications === 0 && metrics.verificationCount > 0) {
    checks.push(contradiction(
      "trajectory-metrics:verification-count",
      artifactPath,
      refs,
      `Native metrics report zero verifications while canonical events contain ${metrics.verificationCount} recognized verification action(s).`,
    ));
  }
  if (nativeVerified === true && metrics.verificationAfterLastMutation !== true) {
    checks.push(contradiction(
      "trajectory-metrics:verified-completion",
      artifactPath,
      refs,
      "Native metrics claim verified completion, but canonical events do not establish verification after the final mutation.",
    ));
  }
  return checks;
}

function contradiction(
  id: string,
  artifactPath: string,
  refs: Ref[],
  observed: string,
): EvidenceIntegrityCheck {
  return {
    id,
    status: "contradictory",
    artifactPath,
    refs,
    observed,
    interpretation: "Use platform-owned run-metrics.json for this fact.",
    ownerClass: "agent",
    scoringSafe: false,
  };
}

function firstFiniteNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === "boolean") return record[key];
  }
  return undefined;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err &&
    (err as { code: unknown }).code === "ENOENT";
}
