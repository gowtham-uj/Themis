/** Run one black-box advisory Phase-2 campaign and materialize its artifacts. */
import {createHash} from "node:crypto";
import {createReadStream, createWriteStream} from "node:fs";
import {mkdir, readdir, stat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {stringify} from "yaml";
import {loadPhase2Case} from "./load-cases.js";
import {aggregatePatterns, extractObservations} from "./patterns.js";
import type {Phase2Analyst} from "./analyst.js";
import {designerOnlyBoard, type Phase2Board} from "./board.js";
import type {
  Phase2Case, Phase2DeveloperPack, Phase2ExecutiveBrief, Phase2MemoryRecord,
  Phase2Pattern, Phase2PlatformFinding, Phase2PlatformReport,
} from "./types.js";

export interface RunPhase2Input {
  campaignId: string;
  projectId: string;
  sutFingerprint: string;
  viewDirs: readonly string[];
  outputDir: string;
  analyst: Phase2Analyst;
  /** Full five-component board. Defaults to a designer-only wrapper around `analyst`. */
  board?: Phase2Board;
  memory?: Phase2MemoryRecord | null;
}

export interface Phase2PackResult {
  artifactDir: string;
  /** SHA-256 of the consolidated developer-improvement-pack.zip. */
  developerPackSha256: string;
  /** Absolute path to the consolidated zip the developer downloads. */
  developerPackZip: string;
  pack: Phase2DeveloperPack;
  platformReport: Phase2PlatformReport;
}

/**
 * Agent-facing files that go into the developer-improvement-pack.zip. Platform
 * content (platform-report.yaml) and internal memory (rd-memory.yaml) are kept
 * OUT — the pack must only carry what helps the tested agent's developer.
 */
const AGENT_PACK_FILES = [
  "campaign.yaml",
  "executive-brief.yaml",
  "hypotheses.yaml",
  "patterns.yaml",
  "developer-pack.yaml",
  "experiment-plans.yaml",
];

/** Recursively add every file under srcDir to the zip under zipPrefix. */
async function addDirToZip(zip: { addFile: (realPath: string, metadataPath: string) => void }, srcDir: string, zipPrefix: string): Promise<void> {
  let names: string[] = [];
  try { names = await readdir(srcDir); } catch { return; }
  for (const name of names.sort()) {
    const src = join(srcDir, name);
    const s = await stat(src).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) await addDirToZip(zip, src, `${zipPrefix}${name}/`);
    else if (s.isFile()) zip.addFile(src, `${zipPrefix}${name}`);
  }
}

/**
 * Bundle the developer pack into ONE consolidated zip with the Phase-1 and
 * Phase-2 evidence organized in folders:
 *
 *   phase1/<runId>/judge/…   each member eval's complete court record
 *   phase2/…                 the campaign's agent-facing artifacts
 *
 * This is the single deliverable the agent's developer uses to improve the SUT.
 */
export async function bundleDeveloperPack(
  outputDir: string,
  campaignId: string,
  phase1JudgeDirs: Readonly<Record<string, string>> = {},
  files: readonly string[] = AGENT_PACK_FILES,
): Promise<{ zipPath: string; sha256: string }> {
  const { ZipFile } = await import("yazl");
  const zipPath = join(outputDir, "developer-improvement-pack.zip");
  const zip = new ZipFile();

  // phase2/ — campaign-level agent-facing artifacts (plus the manifest).
  for (const name of [...files, "manifest.json"]) {
    try {
      const s = await stat(join(outputDir, name));
      if (s.isFile()) zip.addFile(join(outputDir, name), `phase2/${name}`);
    } catch { /* optional file */ }
  }
  // phase1/ — each member eval's complete judge record.
  for (const [runId, judgeDir] of Object.entries(phase1JudgeDirs)) {
    await addDirToZip(zip, judgeDir, `phase1/${runId}/judge/`);
  }

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    zip.outputStream.pipe(out);
    out.on("error", reject);
    zip.outputStream.on("error", reject);
    out.on("finish", () => resolve());
    zip.end();
  });
  const sha = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(zipPath);
    s.on("data", (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      sha.update(b);
      bytes += b.length;
    });
    s.on("error", reject);
    s.on("end", resolve);
  });
  const digest = sha.digest("hex");
  const manifest = {
    schemaVersion: 1,
    campaignId,
    developerPackSha256: digest,
    developerPackZip: zipPath,
    bytes,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(join(outputDir, "developer-pack.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { zipPath, sha256: digest };
}

async function put(path: string, value: unknown) {
  const body = stringify(value, { lineWidth: 0 });
  await writeFile(path, body);
  return { path, bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") };
}

/** Deterministic platform findings: verifier/harness defects, never agent faults. */
function derivePlatformFindings(cases: readonly Phase2Case[]): Phase2PlatformFinding[] {
  const out: Phase2PlatformFinding[] = [];
  const crash = cases.filter((c) => c.platformFault.kind === "verifier_crash");
  if (crash.length > 0) {
    out.push({
      id: "PF-VERIFIER_CRASH",
      severity: "blocker",
      kind: "verifier_crash",
      runIds: crash.map((c) => c.runId),
      finding: `The verifier crashed before grading in ${crash.length} eval(s): non-zero exit (e.g. ${crash.map((c) => c.platformFault.exitCode).filter((x): x is number => x !== null).join("/")}) with empty stdout and every check marked "error". The official reward is an infrastructure artifact, NOT a measurement of the agent.`,
      evidence: crash.map((c) => `run ${c.runId}: exit ${c.platformFault.exitCode} — ${c.platformFault.detail}`),
      fixOwner: "eval package author / platform verifier image",
      fixSuggestion: "Bake the verifier's runtime (e.g. python3) into the verifier image and ensure test.sh emits machine-readable JSON. Re-run the affected evals after the fix; the agent cannot be scored until the verifier can grade.",
    });
  }
  const timeout = cases.filter((c) => c.platformFault.kind === "verifier_timeout");
  if (timeout.length > 0) {
    out.push({
      id: "PF-VERIFIER_TIMEOUT",
      severity: "major",
      kind: "verifier_timeout",
      runIds: timeout.map((c) => c.runId),
      finding: `The verifier timed out in ${timeout.length} eval(s).`,
      evidence: timeout.map((c) => `run ${c.runId}`),
      fixOwner: "eval package author / platform verifier image",
      fixSuggestion: "Raise the verifier timeout or reduce its work; re-run after the fix.",
    });
  }
  const emptyWs = cases.filter((c) => c.emptyWorkspace);
  if (emptyWs.length > 0) {
    out.push({
      id: "PF-EMPTY_WORKSPACE",
      severity: "blocker",
      kind: "empty_workspace",
      runIds: emptyWs.map((c) => c.runId),
      finding: `${emptyWs.length} eval(s) were seeded with an empty workspace (eval.json workspace.source=empty). Seed files declared in the package never landed, so the agent could not perform the task as specified.`,
      evidence: emptyWs.map((c) => `run ${c.runId}: ${c.platformFault.detail}`),
      fixOwner: "eval package author / platform setup",
      fixSuggestion: "Fix environment/setup.sh so seed_repo is copied into /workspace/task before the agent starts. Re-run after the seed lands.",
    });
  }
  const setupFail = cases.filter((c) => c.platformFault.kind === "setup_failure");
  if (setupFail.length > 0) {
    out.push({
      id: "PF-SETUP_FAILURE",
      severity: "blocker",
      kind: "setup_failure",
      runIds: setupFail.map((c) => c.runId),
      finding: `setup.sh failed in ${setupFail.length} eval(s), so the workspace was never seeded and the agent could not perform the task as specified.`,
      evidence: setupFail.map((c) => `run ${c.runId}: ${c.platformFault.detail}`),
      fixOwner: "eval package author / platform setup",
      fixSuggestion: "Fix environment/setup.sh so it exits 0 and copies seed_repo into /workspace/task before the agent starts. Re-run after the seed lands.",
    });
  }
  const notAttributable = cases.filter((c) => !c.rewardAttributable && c.platformFault.kind === "none");
  if (notAttributable.length > 0) {
    out.push({
      id: "PF-REWARD_NOT_ATTRIBUTABLE",
      severity: "major",
      kind: "reward_not_attributable",
      runIds: notAttributable.map((c) => c.runId),
      finding: `${notAttributable.length} eval(s) ran the agent but their reward is not attributable to agent work.`,
      evidence: notAttributable.map((c) => `run ${c.runId}`),
      fixOwner: "platform",
      fixSuggestion: "Inspect the sealed lifecycle records before trusting the reward in Phase-2 statistics.",
    });
  }
  // Agent never executed (setup/harness failure with no specific fault kind):
  // still a platform finding — the eval produced no agent behavior to score.
  const neverRan = cases.filter((c) => !c.validForAgentLearning);
  if (neverRan.length > 0) {
    out.push({
      id: "PF-AGENT_NEVER_EXECUTED",
      severity: "blocker",
      kind: "agent_never_executed",
      runIds: neverRan.map((c) => c.runId),
      finding: `${neverRan.length} eval(s) never ran the agent (setup or harness failure); there is no agent behavior to score.`,
      evidence: neverRan.map((c) => `run ${c.runId}: failure_owner=${c.failureOwner}`),
      fixOwner: "platform / eval package setup",
      fixSuggestion: "Fix the setup/harness failure so the agent executes, then re-run.",
    });
  }
  return out;
}

/** Execute deterministic analysis + agentic recommendation design; no experiment execution. */
export async function runPhase2Campaign(x: RunPhase2Input): Promise<Phase2PackResult> {
  const cases = await Promise.all(x.viewDirs.map(loadPhase2Case));
  const valid = cases.filter((c) => c.validForAgentLearning);
  const platform = cases.filter((c) => !c.validForAgentLearning);
  const rewardNotAttributable = cases.filter((c) => !c.rewardAttributable).length;
  const platformFindings = derivePlatformFindings(cases);

  const observations = extractObservations(cases);
  const patterns = aggregatePatterns(observations);
  const board = x.board ?? designerOnlyBoard(x.analyst);
  const memory = x.memory ?? null;
  const boardCtx = {
    cases,
    viewDirs: Object.fromEntries(x.viewDirs.map((d, i) => {
      const c = cases[i];
      return [c?.runId ?? d, d];
    })),
  };
  board.bind?.({
    campaignId: x.campaignId,
    projectId: x.projectId,
    platformFaults: platformFindings.map((f) => f.finding),
    cases,
    patterns,
    viewDirs: boardCtx.viewDirs,
  });

  const hypotheses = await board.investigate({ campaignId: x.campaignId, patterns, ctx: boardCtx });
  const research = await board.research({ campaignId: x.campaignId, hypotheses, patterns, ctx: boardCtx });
  const drafted = await board.recommend({
    campaignId: x.campaignId,
    projectId: x.projectId,
    patterns,
    platformContext: {
      platformFailures: platform.length + rewardNotAttributable,
      rewardNotAttributable,
      platformFaults: platformFindings.map((f) => f.finding),
    },
    hypotheses,
    research,
    memory,
    ctx: boardCtx,
  });
  const review = await board.review({
    campaignId: x.campaignId,
    patterns,
    hypotheses,
    recommendations: drafted,
    platformFindings,
    memory,
    ctx: boardCtx,
  });
  const kept = new Set(review.keptIds);
  const recommendations = (review.keptIds.length > 0 || review.dropped.length > 0)
    ? drafted.filter((r) => kept.has(r.id))
    : drafted;
  // Agent-facing patterns only. Harness-owned patterns go to the platform report.
  const agentPatterns = patterns.filter((p) => p.owner === "agent" || p.owner === "mixed");
  const platformPatterns = patterns.filter((p) => p.owner === "eval_harness");
  const executiveBrief = buildExecutiveBrief(agentPatterns, recommendations);

  const pack: Phase2DeveloperPack = {
    schemaVersion: 1,
    campaignId: x.campaignId,
    projectId: x.projectId,
    sutFingerprint: x.sutFingerprint,
    memberRunIds: cases.map((c) => c.runId),
    validAgentRuns: valid.length,
    executiveBrief,
    hypotheses,
    patterns: agentPatterns,
    recommendations,
    review,
    generatedAt: new Date().toISOString(),
  };

  const platformReport: Phase2PlatformReport = {
    schemaVersion: 1,
    campaignId: x.campaignId,
    platformFailures: platform.length + rewardNotAttributable,
    rewardNotAttributable,
    findings: platformFindings,
    patterns: platformPatterns,
    nextPlatformAction: platformFindings[0]?.fixSuggestion ?? "no platform defects",
    generatedAt: new Date().toISOString(),
  };

  await mkdir(x.outputDir, { recursive: true });
  const files = [];
  files.push(await put(join(x.outputDir, "campaign.yaml"), {
    schema_version: 1,
    campaign_id: x.campaignId,
    project_id: x.projectId,
    sut_fingerprint: x.sutFingerprint,
    members: cases.map((c) => ({
      run_id: c.runId,
      valid_for_agent_learning: c.validForAgentLearning,
      failure_owner: c.failureOwner,
      reward_attributable: c.rewardAttributable,
      reward: c.reward,
      cohort: c.cohort,
      task_name: c.taskName,
    })),
  }));
  files.push(await put(join(x.outputDir, "executive-brief.yaml"), { schema_version: 1, ...executiveBrief }));
  files.push(await put(join(x.outputDir, "hypotheses.yaml"), { schema_version: 1, hypotheses, research }));
  files.push(await put(join(x.outputDir, "patterns.yaml"), { schema_version: 1, observations, patterns }));
  const dev = await put(join(x.outputDir, "developer-pack.yaml"), pack);
  files.push(dev);
  files.push(await put(join(x.outputDir, "experiment-plans.yaml"), {
    schema_version: 1,
    plans: recommendations.map((r) => r.experimentPlan),
  }));
  files.push(await put(join(x.outputDir, "rd-memory.yaml"), {
    schema_version: 1,
    rejectedRecommendationIds: review.dropped.map((d) => d.id),
    reasons: review.dropped.map((d) => d.reason),
  }));
  const manifest = {
    schema_version: 1,
    campaign_id: x.campaignId,
    files: files.map((f) => ({ path: f.path.split("/").pop(), bytes: f.bytes, sha256: f.sha256 })),
  };
  await put(join(x.outputDir, "manifest.json"), manifest);
  // Platform report is separate: only written when there IS platform content.
  if (platformReport.findings.length > 0 || platformReport.patterns.length > 0) {
    await put(join(x.outputDir, "platform-report.yaml"), platformReport);
  }
  // phase1/<runId>/judge — each member eval's complete Phase-1 court record.
  const phase1JudgeDirs: Record<string, string> = {};
  for (const [runId, viewDir] of Object.entries(boardCtx.viewDirs)) {
    phase1JudgeDirs[runId] = join(viewDir, "judge");
  }
  const bundle = await bundleDeveloperPack(x.outputDir, x.campaignId, phase1JudgeDirs);
  const platformTraces = join(process.cwd(), "data", "platform", "phase2", x.campaignId);
  try {
    const { copyPhase2Traces } = await import("./phase2-pi.js");
    await copyPhase2Traces(platformTraces, join(x.outputDir, "judge_traces"));
  } catch { /* traces optional if this campaign did not use PI */ }
  return {
    artifactDir: x.outputDir,
    developerPackSha256: bundle.sha256,
    developerPackZip: bundle.zipPath,
    pack,
    platformReport,
  };
}

function buildExecutiveBrief(
  agentPatterns: readonly Phase2Pattern[],
  recommendations: Phase2DeveloperPack["recommendations"],
): Phase2ExecutiveBrief {
  const largest = [...agentPatterns].sort((a, b) => b.frequency - a.frequency).slice(0, 5);
  const top = recommendations.find((r) => r.priority === "P0") ?? recommendations[0];
  return {
    largestWeaknesses: largest.map((p) => ({
      patternId: p.id,
      signature: p.signature,
      frequency: p.frequency,
      whyItMatters: p.summary.slice(0, 240),
    })),
    nextDeveloperAction: top ? `Implement ${top.id} (${top.targetCapability}).` : "No agent recommendation survived review.",
  };
}
