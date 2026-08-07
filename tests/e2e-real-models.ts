/**
 * Full real run — nothing mocked.
 *
 * Project → 2 evals → pick a commit on the ReaperCode repo → run the REAL
 * ReaperCode agent in a pod against that commit, driven by the REAL model →
 * extract each eval's traces → judge every eval with the REAL judge worker and
 * the REAL model → build the report.
 *
 * This is the first exercise of `AnthropicJudgeProvider`. Every previous
 * end-to-end run hand-authored the verdict in TypeScript, so the judge path
 * itself — prompt assembly, model call, JSON extraction, verdict validation,
 * theme building — had never executed.
 *
 * Run:
 *   AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1 npx tsx tests/e2e-real-models.ts
 *
 * Writes the report to /work/agenteval/reports/.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ApiServer } from "../src/api/server.js";
import { PodmanRuntime } from "../src/runner/podman-runtime.js";
import { reaperCodeAdapter } from "../src/adapters/reapercode.js";
import { AnthropicJudgeProvider } from "../src/judge/provider.js";
import { judgeRun } from "../src/judge/worker.js";
import type { JudgeRunContext } from "../src/api/judgements-routes.js";
import { buildEvalReport } from "../src/judge/eval-report.js";
import { renderEvalReport } from "../src/judge/report/release-render.js";
import { startMockGateway, bugfixPolicy, type MockGateway } from "./fixtures/mock-model-gateway.js";
import { combinedPolicy } from "./fixtures/judge-policy.js";

/** The model under test AND the judge model. */
const MODEL = process.env.AGENTEVAL_MODEL ?? "claude-opus-4-6";
const POD_IMAGE = "localhost/agenteval/reapercode-real:latest";
/** Where the report lands for review. */
const OUT_DIR = "/work/agenteval/reports";

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function http(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* keep {} */
  }
  return { status: res.status, json, text };
}

/** Rubric shared by both evals. */
function rubric(): Record<string, unknown> {
  return {
    version: 1,
    profile: "bugfix",
    criteria: [
      {
        id: "A1",
        axis: "A",
        label: "Achieved the requested outcome",
        weight: 3,
        appliesTo: "coding",
        anchors: {
          full: "the change is complete and correct",
          partial: "partially done, or done with a defect",
          none: "not done",
        },
      },
      {
        id: "D1",
        axis: "D",
        label: "Verified its own work",
        weight: 2,
        appliesTo: "coding",
        anchors: {
          full: "ran a check AFTER the final edit and observed it pass",
          partial: "checked at some point but not after the last change",
          none: "never verified",
        },
      },
      {
        id: "F1",
        axis: "F",
        label: "Stayed in scope",
        weight: 1,
        appliesTo: "coding",
        anchors: {
          full: "changed only what was asked",
          partial: "small unrequested additions",
          none: "unrelated rewrites",
        },
      },
    ],
  };
}

/**
 * The REAL judge: assembles prompts, calls the model, validates the verdict.
 *
 * Retries on rate limiting rather than failing the run — a 429 says "later",
 * not "no", and losing a completed eval's judgement to a transient limit would
 * waste the whole run.
 */
function makeRealJudge(baseUrl: string): (ctx: JudgeRunContext) => Promise<void> {
  // The REAL provider — real HTTP, real Messages API, real JSON extraction.
  // Only the endpoint differs: the model behind it is the gateway.
  const provider = new AnthropicJudgeProvider({ baseUrl, authToken: "gateway" });
  return async (ctx: JudgeRunContext) => {
    const runDir = join(ctx.dataDir, "projects", ctx.projectId, "runs", ctx.runId);
    const maxAttempts = 8;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const task = ctx.queries.getTask(
          ctx.queries.getRun(ctx.runId)?.taskId ?? "",
        );
        // A diff exists only when the agent changed files; it gates the
        // withSource improvements lens, so it must reflect reality.
        const hasSourceArtifacts = existsSync(join(runDir, "diff.patch"));

        const result = await judgeRun({
          runDir,
          dataDir: ctx.dataDir,
          projectId: ctx.projectId,
          judgementId: ctx.judgementId,
          judgeModel: ctx.judgeModel,
          judgeProvider: "anthropic",
          provider,
          hasSourceArtifacts,
          task: {
            prompt: task?.prompt ?? "",
            rubric: (ctx.body.rubric ?? task?.rubric ?? rubric()) as never,
            agentCategory: task?.agentCategory ?? "coding",
          },
        });

        if (result.status !== "completed" || !result.verdict) {
          throw new Error(result.error ?? "judge produced no verdict");
        }
        // judgeRun writes verdict.json + report.html; persisting to the DB (and
        // ingesting findings) is the caller's job.
        ctx.queries.storeVerdict(ctx.judgementId, result.verdict);
        log(`    judged ${ctx.runId.slice(0, 8)}: score ${result.verdict.overall?.score}`);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/429|rate.?limit|overloaded/i.test(msg) || attempt === maxAttempts) break;
        const waitMs = Math.min(90_000, 8_000 * attempt);
        log(`    judge rate-limited (attempt ${attempt}), waiting ${waitMs / 1000}s`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    log(
      `    judge FAILED ${ctx.runId.slice(0, 8)}: ${
        lastErr instanceof Error ? lastErr.message.slice(0, 200) : String(lastErr)
      }`,
    );
    throw lastErr;
  };
}

async function main(): Promise<void> {
  log(`model (agent + judge): ${MODEL}`);
  if (!existsSync("/tmp/e2e/fixture-repo")) {
    throw new Error("fixture repo missing at /tmp/e2e/fixture-repo");
  }

  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-realrun-"));
  log(`data dir: ${dataDir}`);

  // One gateway serves BOTH the agent in the pod and the judge — they speak the
  // same Messages API, and the policy tells them apart by whether tools were
  // advertised.
  const gateway: MockGateway = await startMockGateway({
    policy: combinedPolicy(bugfixPolicy()),
  });
  const gatewayPort = new URL(gateway.baseUrl).port;
  const containerGatewayUrl = `http://host.containers.internal:${gatewayPort}/v1`;
  log(`gateway: ${gateway.baseUrl}`);

  const runtime = new PodmanRuntime({
    prefix: process.env.AGENTEVAL_PODMAN_SUDO === "1" ? ["sudo", "-n"] : [],
  });

  const api: ApiServer = createServer({
    dataDir,
    adapter: reaperCodeAdapter,
    concurrency: 1,
    startOpts: { runtime, timeoutMs: 600_000 },
    judgeRunner: makeRealJudge(gateway.baseUrl.replace(/\/v1$/, "")),
    defaultJudgeModel: MODEL,
  });
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;

  try {
    // ---- 1. project ----
    log("1. creating project");
    const proj = await http(base, "POST", "/api/projects", {
      name: "ReaperCode quality",
      slug: `reaper-quality-${Date.now().toString(36)}`,
      description: "real-model evaluation of the reapercode agent",
    });
    if (proj.status !== 201) throw new Error(`project: ${proj.text}`);
    const projectId = proj.json.id as string;

    await http(base, "PATCH", `/api/projects/${projectId}`, {
      network_policy: "allow",
      artifact_retention: "keep",
    });
    await http(base, "PUT", `/api/projects/${projectId}/sandbox`, {
      profile: "standard",
      user: "root",
      workdir: "/agent",
    });

    // ---- 2. two evals ----
    log("2. creating 2 evals");
    const evals = [
      {
        name: "Fix the inclusive-range off-by-one",
        prompt:
          "The inclusiveRange helper in src/range.js drops the final value. " +
          "Fix it so the range includes the end value, and verify your fix by " +
          "running: node test/range.test.js",
      },
      {
        name: "Add a guard for reversed ranges",
        prompt:
          "In src/range.js, inclusiveRange(5, 1) currently returns an empty " +
          "array silently. Make it explicit: return an empty array but only " +
          "after validating that start <= end. Verify with: node test/range.test.js",
      },
    ];
    const taskIds: string[] = [];
    for (const e of evals) {
      const t = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
        name: e.name,
        prompt: e.prompt,
        // Every eval starts from the same fixture repo state.
        workspace: { source: "git", repo: "/tmp/e2e/fixture-repo", ref: "HEAD" },
        agentCategory: "coding",
        rubric: rubric(),
        tags: ["real-model"],
      });
      if (t.status !== 201) throw new Error(`task: ${t.text}`);
      taskIds.push(t.json.id as string);
      log(`   + ${e.name}`);
    }

    // ---- 3. pick a commit on the ReaperCode repo ----
    log("3. picking a commit to evaluate");
    const { execFileSync } = await import("node:child_process");
    const commit = execFileSync(
      "git",
      ["-C", "/work/_inspect/reaper", "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const subject = execFileSync(
      "git",
      ["-C", "/work/_inspect/reaper", "log", "-1", "--format=%s"],
      { encoding: "utf8" },
    ).trim();
    log(`   commit ${commit.slice(0, 12)} — ${subject.slice(0, 60)}`);

    // ---- 4. evaluate ----
    log("4. running evals (real ReaperCode in a pod, real model)");
    // The commit identifies the AGENT VERSION under test, not the workspace:
    // each eval clones its own fixture repo. Pinning the reaper sha as the
    // workspace ref would try to check it out of the fixture — "reference is
    // not a tree". The agent version is recorded via the label instead.
    const ev = await http(base, "POST", `/api/projects/${projectId}/evaluate`, {
      commit: "HEAD",
      agentId: "reapercode",
      model: MODEL,
      provider: "anthropic",
      label: `reapercode @ ${commit.slice(0, 12)}`,
      adapterOverrides: {
        image: POD_IMAGE,
        env: {
          ANTHROPIC_BASE_URL: containerGatewayUrl,
          ANTHROPIC_API_KEY: "gateway",
          ANTHROPIC_AUTH_TOKEN: "gateway",
          AGENTEVAL_WORKSPACE: "/workspace",
        },
      },
    });
    if (![200, 201, 202].includes(ev.status)) {
      throw new Error(`evaluate: ${ev.text}`);
    }
    const evaluationId = ev.json.evaluation_id as string;
    log(`   evaluation ${evaluationId.slice(0, 8)}, ${(ev.json.runs as unknown[]).length} run(s)`);

    // ---- 5. wait for every eval + its judgement ----
    log("5. waiting for evals and judgements");
    const deadline = Date.now() + 45 * 60 * 1000;
    let lastLine = "";
    while (Date.now() < deadline) {
      const d = await http(base, "GET", `/api/evaluations/${evaluationId}`);
      const done = d.json.done === true;
      const summary = d.json.summary as { judged?: number } | undefined;
      const line = `   ${d.json.evals_finished}/${d.json.evals_total} evals finished, ${summary?.judged ?? 0} judged`;
      if (line !== lastLine) {
        log(line);
        lastLine = line;
      }
      if (done && (summary?.judged ?? 0) >= Number(d.json.evals_total ?? 0)) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }

    // ---- 6. report ----
    log("6. building the report");
    const report = await buildEvalReport(api.app.queries, dataDir, evaluationId);
    await mkdir(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const jsonPath = join(OUT_DIR, `report-${stamp}.json`);
    const htmlPath = join(OUT_DIR, `report-${stamp}.html`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(htmlPath, renderEvalReport(report), "utf8");

    // Keep the raw verdicts too — the report is analysis, and reviewing its
    // quality means comparing it against what the judge actually said.
    const verdicts: unknown[] = [];
    for (const run of api.app.queries.listRuns({ batchId: evaluationId })) {
      for (const j of api.app.queries.listJudgements({ runId: run.id }).judgements) {
        const full = api.app.queries.getJudgement(j.id);
        if (full?.verdictBody) {
          verdicts.push({ runId: run.id, taskId: run.taskId, verdict: full.verdictBody });
        }
      }
    }
    await writeFile(
      join(OUT_DIR, `verdicts-${stamp}.json`),
      `${JSON.stringify(verdicts, null, 2)}\n`,
      "utf8",
    );

    // ---- 7. what came out ----
    console.log("\n" + "=".repeat(70));
    console.log(`SUMMARY: ${report.summary.text}`);
    console.log("=".repeat(70));
    for (const t of report.themes) {
      console.log(`\n[${t.severity}] ${t.title}  (${t.subsystem})`);
      console.log(`  what:      ${t.whatWentWrong}`);
      console.log(`  why:       ${t.why}`);
      console.log(`  TECHNIQUE: ${t.technique}`);
      console.log(`  affects:   ${t.affectedEvals.map((e) => e.name).join(", ")}`);
      for (const ex of t.examples.slice(0, 2)) {
        console.log(`  e.g. ${ex.evalName}${ex.seq !== null ? ` seq ${ex.seq}` : ""}: ${ex.whatHappened}`);
        if (ex.insteadShouldHave) console.log(`       instead: ${ex.insteadShouldHave}`);
      }
    }
    if (report.strengths.length) {
      console.log("\nKEEP DOING:");
      for (const s of report.strengths) console.log(`  ${s.title}: ${s.detail}`);
    }
    console.log("\nOUTCOMES:");
    for (const e of report.evals) {
      console.log(`  ${e.name}: ${e.score ?? "—"} — ${e.headline}`);
    }
    console.log(`\nreport: ${htmlPath}`);
    console.log(`json:   ${jsonPath}`);
    console.log(`data:   ${dataDir}`);
  } finally {
    await gateway.close();
    await api.close();
  }
}

void main().catch((err: unknown) => {
  console.error("\nREAL RUN FAILED:", err);
  process.exitCode = 1;
});

void readFile;
