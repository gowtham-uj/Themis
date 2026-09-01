/** Load published Phase-1 views into black-box Phase-2 case records. */
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {parseAllDocuments} from "yaml";
import type {FailureOwner, Phase2Case} from "./types.js";

async function json(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

interface ImprovementRef { ref?: unknown }

/** Pull a stable evidence ref off an improvement item's evidence list. */
function improvementRefs(x: Record<string, unknown>): string[] {
  const ev = Array.isArray(x.evidence) ? x.evidence : [];
  return ev
    .map((e) => (e as ImprovementRef)?.ref)
    .filter((r): r is string => typeof r === "string");
}

/**
 * Derive failure ownership and reward attribution deterministically from the
 * sealed verifier record, INDEPENDENT of the Phase-1 validity stamp, so old
 * judge views (written before the verifier-crash classification existed) are
 * still routed correctly.
 */
function platformFault(viewDir: string): Promise<{ kind: "verifier_crash" | "verifier_timeout" | "setup_failure" | "empty_workspace" | "none"; exitCode: number | null; detail: string }> {
  return (async () => {
    const vr = await json(join(viewDir, "verifier_res", "verifier-result.json"));
    const evalJson = await json(join(viewDir, "eval_lifecycle_logs", "eval.json"));
    const workspace = (evalJson?.workspace ?? {}) as Record<string, unknown>;
    const emptyWorkspace = String(workspace.source ?? "") === "empty";
    const exit = vr ? n(vr.exitCode) : null;
    const checks = Array.isArray(vr?.checks) ? vr!.checks as Record<string, unknown>[] : [];
    const allError = checks.length > 0 && checks.every((c) => c.status === "error");
    const emptyOut = String(vr?.resultSha256 ?? "") === EMPTY_SHA256;
    if (vr?.timedOut === true) {
      return { kind: "verifier_timeout", exitCode: exit, detail: s((checks[0] as Record<string, unknown> | undefined)?.detail) };
    }
    if (vr && exit !== null && exit !== 0 && (allError || emptyOut)) {
      return { kind: "verifier_crash", exitCode: exit, detail: s((checks[0] as Record<string, unknown> | undefined)?.detail) };
    }
    if (emptyWorkspace) {
      return { kind: "empty_workspace", exitCode: exit, detail: "eval.json workspace.source is empty; seed files never landed" };
    }
    return { kind: "none", exitCode: exit, detail: "" };
  })();
}

/** Load one immutable Phase-1 archive view. */
export async function loadPhase2Case(viewDir: string): Promise<Phase2Case> {
  const y = await readFile(join(viewDir, "judge", "evalJudge.yaml"), "utf8");
  const d = parseAllDocuments(y)[0]?.toJS() as Record<string, unknown> | undefined;
  if (!d) throw new Error(`invalid evalJudge: ${viewDir}`);
  const validity = (d.eval_validity ?? {}) as Record<string, unknown>;
  const metrics = await json(join(viewDir, "eval_lifecycle_logs", "run-metrics.json"));
  const run = await json(join(viewDir, "eval_lifecycle_logs", "run.json"));
  const evalJson = await json(join(viewDir, "eval_lifecycle_logs", "eval.json"));
  const quality = await json(join(viewDir, "judge", "quality-report.json"));
  const meas = (metrics?.measurements ?? {}) as Record<string, { value?: unknown }>;
  const mv = (k: string) => n(meas[k]?.value) ?? n(metrics?.[k]);

  const fault = await platformFault(viewDir);
  // Trust the Phase-1 stamp when present, but a deterministically-detected
  // verifier crash outranks a stale `failure_owner: none` from an old view.
  const stampedOwner = s(validity.failure_owner) || "none";
  const emptyWorkspace =
    String(((evalJson?.workspace ?? {}) as Record<string, unknown>).source ?? "") === "empty" ||
    fault.kind === "empty_workspace";
  const harnessFault =
    fault.kind === "verifier_crash" ||
    fault.kind === "verifier_timeout" ||
    fault.kind === "empty_workspace" ||
    fault.kind === "setup_failure" ||
    emptyWorkspace;
  const rewardAttributable = harnessFault ? false : validity.official_reward_attributable_to_agent !== false;
  const failureOwner: FailureOwner = harnessFault ? "eval_harness" : (stampedOwner as FailureOwner);

  const improvements = Array.isArray(d.improvements)
    ? (d.improvements as Record<string, unknown>[])
    : [];

  return {
    runId: String(d.eval_id ?? run?.runId ?? ""),
    validForAgentLearning: validity.valid_for_agent_learning !== false,
    failureOwner,
    reward: n(d.official_reward),
    rewardAttributable,
    agent: String(d.agent_under_evaluation ?? run?.agentId ?? "unknown"),
    model: typeof run?.model === "string" ? run.model : null,
    tokens: mv("tokens_used"),
    wallTimeMs: mv("wall_clock_ms"),
    toolCalls: mv("tool_calls") ?? n(metrics?.toolCallCount),
    narrative: String(d.narrative ?? ""),
    improvements,
    qualityPassed: quality?.passed === true,
    platformFault: fault,
    emptyWorkspace,
    taskName: String(evalJson?.name ?? d.eval_id ?? run?.runId ?? ""),
    cohort: {
      language: languageFrom(evalJson),
      category: String(evalJson?.categoryName ?? evalJson?.agentCategory ?? "unknown"),
      profile: String(evalJson?.profile ?? "unknown"),
      model: typeof run?.model === "string" ? run.model : "unknown",
    },
  };
}

function languageFrom(evalJson: Record<string, unknown> | null): string {
  const known = new Set(["javascript", "typescript", "python", "go", "golang", "rust", "c", "cpp", "c++", "java", "bash"]);
  const tags = Array.isArray(evalJson?.tags) ? evalJson!.tags : [];
  for (const t of tags) {
    const x = String(t).toLowerCase();
    if (known.has(x)) return x === "golang" ? "go" : x === "c++" ? "cpp" : x;
  }
  return "unknown";
}

/** Extract the evidence refs minos attached to each improvement item. */
export function improvementRefList(c: Phase2Case): string[] {
  const out = new Set<string>();
  for (const x of c.improvements) {
    for (const r of improvementRefs(x)) out.add(r);
  }
  return [...out];
}
