/**
 * Full-platform end-to-end exercise: a REAL container run through the REAL
 * reapercode adapter, judged by the REAL judge worker, rendered to a REAL HTML
 * report — all over the public REST API.
 *
 * The AGENT is the real ReaperCode build (tests/fixtures/pods/
 * reapercode-real.Containerfile) running its genuine loop, tools and trajectory
 * logging. Only the two MODELS are mocked, at the gateway boundary:
 *  - the agent's model: an Anthropic-Messages-compatible server the agent calls
 *    over HTTP (tests/fixtures/mock-model-gateway.ts), scripted to produce a
 *    run with a genuine defect;
 *  - the judge's model: a scripted verdict grounded in the real captured trace.
 * Everything between them is production code: podman, event capture, redaction,
 * diff capture, checks, verdict validation, findings ingest, report render.
 *
 * Run (not part of `npm test` — needs podman + a built pod image):
 *   AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1 npx tsx tests/e2e-podman-reaper.ts
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ApiServer } from "../src/api/server.js";
import { PodmanRuntime } from "../src/runner/podman-runtime.js";
import { reaperCodeAdapter } from "../src/adapters/reapercode.js";
import type { JudgeRunContext } from "../src/api/judgements-routes.js";
import type { DbQueries } from "../src/db/queries.js";
import type { Verdict } from "../src/judge/verdict.js";
import { validateVerdict } from "../src/judge/verdict.js";
import { renderVerdictReport } from "../src/judge/report/render.js";
import {
  bugfixPolicy,
  startMockGateway,
  type MockGateway,
} from "./fixtures/mock-model-gateway.js";

const POD_IMAGE =
  process.env.AGENTEVAL_E2E_IMAGE ?? "localhost/agenteval/reapercode-real:latest";
const FIXTURE = "/tmp/e2e/fixture-repo";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

async function http(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResult> {
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

/** Sample rubric: what "fixed the bug" means, including verification. */
function sampleRubric(): Record<string, unknown> {
  return {
    version: 1,
    profile: "bugfix",
    criteria: [
      {
        id: "C1",
        axis: "A",
        label: "The off-by-one is actually fixed",
        weight: 3,
        appliesTo: "coding",
        anchors: {
          full: "inclusiveRange returns the end value; tests would pass",
          partial: "partially fixed or fixed with a regression",
          none: "not fixed",
        },
      },
      {
        id: "C2",
        axis: "D",
        label: "The agent verified its final state",
        weight: 2,
        appliesTo: "coding",
        anchors: {
          full: "ran the suite AFTER the last edit and saw it pass",
          partial: "ran tests at some point but not after the final edit",
          none: "never ran the tests",
        },
      },
      {
        id: "C3",
        axis: "F",
        label: "Stayed within the requested scope",
        weight: 1,
        appliesTo: "coding",
        anchors: {
          full: "changed only what the task asked for",
          partial: "small unrequested additions",
          none: "large unrelated rewrites",
        },
      },
    ],
  };
}

/**
 * MODEL GATEWAY (judge side).
 *
 * Stands in for the judge's LLM. Reads the REAL captured trace + diff from
 * disk and returns a verdict grounded in them — the analysis is authored here,
 * but the evidence it cites is real and every ref must resolve.
 */
function makeJudgeGateway(): (ctx: JudgeRunContext) => Promise<void> {
  return async (ctx: JudgeRunContext) => {
    const queries = ctx.queries as DbQueries;
    const runDir = join(ctx.dataDir, "projects", ctx.projectId, "runs", ctx.runId);

    // Read what the run actually produced — the gateway sees only what a real
    // judge would see.
    const eventsRaw = await readFile(join(runDir, "events.jsonl"), "utf8").catch(
      () => "",
    );
    const events = eventsRaw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const diff = await readFile(join(runDir, "diff.patch"), "utf8").catch(() => "");

    // Locate real evidence: the seq of the last test run, and of the last edit.
    const toolCalls = events.filter((e) => e.type === "tool.call");
    const lastTestRun = [...toolCalls]
      .reverse()
      .find((e) => e.name === "run_tests");
    const lastEdit = [...toolCalls].reverse().find((e) => e.name === "edit_file");
    const testSeq = Number(lastTestRun?.seq ?? 0);
    const editSeq = Number(lastEdit?.seq ?? 0);
    const editedAfterLastTest = editSeq > testSeq;

    const validationEdit = toolCalls.find(
      (e) =>
        e.name === "edit_file" &&
        JSON.stringify(e.args ?? {}).includes("validation"),
    );

    const verdict = {
      schemaVersion: 1,
      overall: {
        score: 0.62,
        verdict: "partial",
        summary:
          "The off-by-one is genuinely fixed, but the agent stopped without " +
          "re-running the suite after its final edit and asserted success anyway.",
      },
      criteria: [
        {
          criterion: "C1",
          weight: 3,
          score: 1,
          feedback:
            "The loop bound was changed from `i < end` to `i <= end`, which is " +
            "exactly the inclusive-range fix the task asked for.",
          evidence: ["diff: src/range.js loop bound"],
          findingIds: [],
        },
        {
          criterion: "C2",
          weight: 2,
          score: 0,
          feedback:
            "The suite was run once, BEFORE the fix, and never again. The final " +
            "claim that 'all tests pass' is unsupported by anything in the trace.",
          evidence: [`trace: last test run at seq ${testSeq}, last edit at seq ${editSeq}`],
          findingIds: ["f-unverified"],
        },
        {
          criterion: "C3",
          weight: 1,
          score: 0.5,
          feedback:
            "An input-validation guard was added that the task did not ask for. " +
            "It is small and harmless, but it is unrequested scope and untested.",
          evidence: ["diff: added typeof guard"],
          findingIds: ["f-scope"],
        },
      ],
      findings: [
        {
          id: "f-unverified",
          category: "verification_skipped",
          severity: "major",
          confidence: 0.95,
          claim:
            "The agent declared 'All tests pass' without running the suite after " +
            "its final edit — the claim is unverified.",
          refs: [
            {
              kind: "trace",
              runId: ctx.runId,
              seqs: [testSeq, editSeq] as [number, number],
            },
            ...(lastEdit?.id
              ? [{ kind: "tool", toolCallId: String(lastEdit.id) }]
              : []),
          ],
          fix: {
            direction:
              "Re-run the test suite after the final edit, and gate the success " +
              "message on that run passing.",
            repro: {
              command: "node test/range.test.js",
              expected: "all tests passed",
            },
          },
        },
        {
          id: "f-scope",
          category: "scope_creep",
          severity: "minor",
          confidence: 0.8,
          claim:
            "Added an unrequested input-validation guard, silently changing the " +
            "contract for non-numeric input from throwing to returning [].",
          refs: [
            { kind: "diff", file: "src/range.js", hunk: 1 },
            ...(validationEdit?.id
              ? [{ kind: "tool", toolCallId: String(validationEdit.id) }]
              : []),
          ],
        },
      ],
      positiveFindings: [
        {
          id: "p-diagnosis",
          category: "verification_thorough",
          severity: "nit",
          confidence: 0.9,
          claim:
            "Reproduced the failure before editing, so the fix was grounded in " +
            "an observed error rather than a guess.",
          refs: [{ kind: "trace", runId: ctx.runId, seqs: [1, testSeq] as [number, number] }],
        },
      ],
      metaFindings: [],
      diagnostics: {
        looping: { value: false, refs: [], note: "three linear turns, no repetition" },
        verification_skipped: {
          value: editedAfterLastTest,
          refs: [
            { kind: "trace", runId: ctx.runId, seqs: [testSeq, editSeq] as [number, number] },
          ],
          note: `last edit (seq ${editSeq}) came after the last test run (seq ${testSeq})`,
        },
        premature_success_claim: {
          value: true,
          refs: [{ kind: "trace", runId: ctx.runId, seqs: [editSeq, editSeq] as [number, number] }],
          note: "final message asserts passing tests with no supporting run",
        },
      },
      attribution: { agent_vs_environment: "agent" },
      observations: [
        `Captured ${events.length} canonical events across 3 turns.`,
        `Diff touched ${new Set(diff.split("\n").filter((l) => l.startsWith("+++ ")).map((l) => l.slice(4).replace(/^b\//, ""))).size} file(s).`,
      ],
      improvements: {
        summary:
          "One behavioural change would fix the real problem: verify after the " +
          "last mutation, not before it.",
        withoutSource: [
          {
            area: "verification",
            priority: "high",
            change:
              "Make the final step of any edit loop a fresh test run, and refuse " +
              "to emit a success message unless the most recent run passed.",
            why:
              "The trace shows edit-after-test ordering; the success claim is " +
              "therefore asserting something the agent never observed.",
            refs: [
              { kind: "trace", runId: ctx.runId, seqs: [testSeq, editSeq] as [number, number] },
            ],
            linkedFindings: ["f-unverified"],
          },
          {
            area: "process",
            priority: "medium",
            change:
              "Treat 'while I'm here' additions as a separate proposal rather " +
              "than folding them into the requested fix.",
            why:
              "The validation guard changed behaviour for inputs the task never " +
              "mentioned, and no test covers it.",
            refs: [{ kind: "tool", toolCallId: String(validationEdit?.id ?? "tc-3") }],
            linkedFindings: ["f-scope"],
          },
        ],
        withSource: [
          {
            area: "correctness",
            priority: "low",
            change:
              "Add a test asserting the non-numeric behaviour the guard now " +
              "introduces, or drop the guard.",
            why: "New behaviour with no test is a regression waiting to happen.",
            refs: [{ kind: "diff", file: "src/range.js", hunk: 1 }],
            linkedFindings: ["f-scope"],
          },
        ],
      },
    } as unknown as Verdict;

    // Validate through the REAL schema validator before storing — a verdict the
    // platform would reject must not be silently accepted here either.
    validateVerdict(verdict, { hasSourceArtifacts: true });
    queries.storeVerdict(ctx.judgementId, verdict);

    // Render the REAL report and persist it where the API serves it from.
    const { judgementDir } = await import("../src/db/queries.js");
    const dir = judgementDir(ctx.dataDir, ctx.projectId, ctx.judgementId);
    const html = renderVerdictReport(verdict, {
      runId: ctx.runId,
      judgeModel: ctx.judgeModel,
      systemPromptVersion: ctx.systemPromptVersion,
      hasSourceArtifacts: true,
    });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "report.html"), html, "utf8");
  };
}

async function main(): Promise<void> {
  console.log("agenteval end-to-end: REAL agent in a pod + real judge pipeline\n");

  if (!existsSync(FIXTURE)) {
    throw new Error(`fixture repo missing: ${FIXTURE}`);
  }

  // MODEL GATEWAY (agent side). The agent in the pod is the real ReaperCode
  // build; only its model is ours. It reaches this server through podman's
  // host gateway address, so the URL the container sees is not the loopback
  // one we bound.
  const gateway: MockGateway = await startMockGateway({ policy: bugfixPolicy() });
  const gatewayPort = new URL(gateway.baseUrl).port;
  const containerGatewayUrl = `http://host.containers.internal:${gatewayPort}/v1`;
  console.log(`   model gateway: ${gateway.baseUrl} (container: ${containerGatewayUrl})`);

  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-e2e-pod-"));
  const runtime = new PodmanRuntime({
    prefix: process.env.AGENTEVAL_PODMAN_SUDO === "1" ? ["sudo", "-n"] : [],
  });

  const api: ApiServer = createServer({
    dataDir,
    adapter: reaperCodeAdapter,
    concurrency: 1,
    startOpts: { runtime, timeoutMs: 120_000 },
    judgeRunner: makeJudgeGateway(),
  });
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;

  try {
    // ---- 1. sample project ----
    console.log("1. project + sandbox policy");
    const proj = await http(base, "POST", "/api/projects", {
      name: "Range Library",
      slug: "range-library",
      description: "sample project for the end-to-end exercise",
    });
    check("project created", proj.status === 201, `status ${proj.status}`);
    const projectId = proj.json.id as string;

    // Pin the pod image + keep artifacts, via the project API.
    // The agent must reach the model gateway, so this project allows network.
    // (The offline path is covered by tests/podman-live.test.ts.)
    const patched = await http(base, "PATCH", `/api/projects/${projectId}`, {
      network_policy: "allow",
      artifact_retention: "referenced",
    });
    check("network policy applied", patched.status === 200);

    // workdir is load-bearing: the adapter launches `node bin/reaper`, which
    // resolves relative to cwd. The real agent lives at /agent in the image, so
    // cwd points there — which also keeps its own files out of /workspace,
    // where anything written would land in the captured diff as agent work.
    const sandbox = await http(base, "PUT", `/api/projects/${projectId}/sandbox`, {
      profile: "standard",
      user: "root",
      workdir: "/agent",
      ulimits: { nofile: 4096 },
    });
    check("sandbox policy accepted", sandbox.status === 200);
    check(
      "sandbox resolved as requested",
      (sandbox.json.resolved as Record<string, unknown>).user === "root",
    );

    // ---- 2. project rubric (CRUD) ----
    console.log("\n2. project rubric");
    const rubricRes = await http(base, "POST", `/api/projects/${projectId}/rubrics`, {
      name: "Bugfix baseline",
      rubric: sampleRubric(),
      is_default: true,
    });
    check("project rubric created", rubricRes.status === 201, rubricRes.text.slice(0, 120));

    // ---- 3. sample task ----
    console.log("\n3. task");
    const taskRes = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
      name: "Fix inclusiveRange off-by-one",
      prompt:
        "The inclusiveRange helper in src/range.js drops the final value. " +
        "Fix it so the range includes the end value.",
      workspace: { source: "git", repo: FIXTURE, ref: "HEAD" },
      agentCategory: "coding",
      rubric: sampleRubric(),
      tags: ["sample", "bugfix"],
    });
    check("task created", taskRes.status === 201, taskRes.text.slice(0, 160));
    const taskId = taskRes.json.id as string;

    // ---- 4. real container run through the reapercode adapter ----
    console.log("\n4. run (real podman container, reapercode adapter)");
    await http(base, "POST", "/api/agents", {
      id: "reapercode",
      display_name: "ReaperCode",
    });
    const start = await http(base, "POST", `/api/projects/${projectId}/runs`, {
      taskId,
      agentId: "reapercode",
      // A real provider/model id the agent recognises — the MODEL is mocked at
      // the gateway (ANTHROPIC_BASE_URL), not by inventing a provider the agent
      // has no client for.
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      repeats: 1,
      adapterOverrides: {
        image: POD_IMAGE,
        env: {
          ANTHROPIC_BASE_URL: containerGatewayUrl,
          ANTHROPIC_API_KEY: "mock-gateway-key",
          AGENTEVAL_WORKSPACE: "/workspace",
        },
      },
    });
    check("run accepted", [200, 201, 202].includes(start.status), start.text.slice(0, 200));
    const runId = (start.json.runs as Array<{ id: string }>)[0]!.id;

    let status = "";
    for (let i = 0; i < 400; i++) {
      const r = await http(base, "GET", `/api/runs/${runId}`);
      status = String((r.json as { status?: string }).status ?? "");
      if (["completed", "failed", "aborted", "timeout"].includes(status)) break;
      await new Promise((r2) => setTimeout(r2, 250));
    }
    check("run completed", status === "completed", `status=${status}`);

    // ---- 5. trace capture ----
    console.log("\n5. trace + diff capture");
    const runDir = join(dataDir, "projects", projectId, "runs", runId);
    const eventsRaw = await readFile(join(runDir, "events.jsonl"), "utf8").catch(
      () => "",
    );
    const events = eventsRaw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const byType = new Map<string, number>();
    for (const e of events) {
      byType.set(String(e.type), (byType.get(String(e.type)) ?? 0) + 1);
    }
    console.log(
      "   event types:",
      [...byType.entries()].map(([k, v]) => `${k}=${v}`).join(" "),
    );
    // ReaperCode does not yet emit structured `thinking` (change ① of
    // plan/reapercode-changes.md is unlanded — verified against the live tree).
    // Assert the honest thing: the adapter maps it WHEN present, and today's
    // agent produces none, so this is reported rather than silently expected.
    const thinkingCount = byType.get("thinking") ?? 0;
    console.log(
      `   thinking events: ${thinkingCount}` +
        (thinkingCount === 0
          ? "  (expected 0 — ReaperCode has not landed structured thinking)"
          : ""),
    );
    check("captured tool calls", (byType.get("tool.call") ?? 0) > 0);
    check("captured tool results", (byType.get("tool.result") ?? 0) > 0);
    check("captured assistant messages", (byType.get("message") ?? 0) > 0);
    check("captured run.start + run.end", (byType.get("run.start") ?? 0) === 1 && (byType.get("run.end") ?? 0) === 1);
    check(
      "seq is strictly increasing",
      events.every((e, i) => i === 0 || Number(e.seq) > Number(events[i - 1]!.seq)),
    );

    const diff = await readFile(join(runDir, "diff.patch"), "utf8").catch(() => "");
    check("diff captured", diff.includes("range.js"), `len=${diff.length}`);
    check("diff shows the loop-bound fix", diff.includes("i <= end"));
    // The diff must contain ONLY the agent's work. Harness scaffolding leaking
    // into the workspace would be attributed to the agent by the judge.
    const changedFiles = [
      ...new Set(
        diff
          .split("\n")
          .filter((l) => l.startsWith("+++ "))
          .map((l) => l.slice(4).replace(/^b\//, "")),
      ),
    ];
    check(
      "diff contains only the agent's file (no harness scaffolding)",
      changedFiles.length === 1 && changedFiles[0] === "src/range.js",
      `files=${changedFiles.join(",")}`,
    );

    // The container really mutated the workspace.
    const finalSrc = await readFile(
      join(runDir, "workspace", "src", "range.js"),
      "utf8",
    ).catch(() => "");
    check("workspace really mutated by the container", finalSrc.includes("i <= end"));

    // ---- 6. judge ----
    console.log("\n6. judgement");
    const jud = await http(base, "POST", `/api/runs/${runId}/judgements`, {
      rubric: sampleRubric(),
    });
    check("judgement accepted", jud.status === 202, jud.text.slice(0, 160));
    const judgementId = jud.json.judgementId as string;

    let jstatus = "";
    let verdictBody: Record<string, unknown> | null = null;
    for (let i = 0; i < 300; i++) {
      const r = await http(base, "GET", `/api/judgements/${judgementId}`);
      jstatus = String((r.json as { status?: string }).status ?? "");
      if (jstatus === "completed") {
        verdictBody = r.json.verdict_body as Record<string, unknown>;
        break;
      }
      if (jstatus === "failed") break;
      await new Promise((r2) => setTimeout(r2, 200));
    }
    check("judgement completed", jstatus === "completed", `status=${jstatus}`);
    check("verdict persisted", verdictBody !== null);

    if (verdictBody) {
      const findings = verdictBody.findings as Array<Record<string, unknown>>;
      check("judge found the unverified-claim defect", findings.some((f) => f.category === "verification_skipped"));
      check("every finding carries ≥1 ref", findings.every((f) => Array.isArray(f.refs) && (f.refs as unknown[]).length > 0));
      const improvements = verdictBody.improvements as Record<string, unknown>;
      check("withoutSource lens populated", Array.isArray(improvements.withoutSource) && (improvements.withoutSource as unknown[]).length > 0);
      check("withSource lens populated", Array.isArray(improvements.withSource) && (improvements.withSource as unknown[]).length > 0);
    }

    // ---- 7. findings ingest (recurrence tracking) ----
    console.log("\n7. findings ingest");
    const findingsRes = await http(base, "GET", `/api/projects/${projectId}/findings`);
    const ingested = (findingsRes.json.findings ?? []) as Array<Record<string, unknown>>;
    check("findings ingested into the project store", ingested.length >= 2, `count=${ingested.length}`);

    // ---- 8. report ----
    console.log("\n8. HTML report");
    const report = await fetch(`${base}/api/runs/${runId}/report`);
    const html = await report.text();
    check("report served", report.status === 200, `status=${report.status}`);
    check("report is a full HTML document", html.includes("<!DOCTYPE html") || html.includes("<html"));
    check("report shows the overall verdict", html.toLowerCase().includes("partial"));
    check("report includes the findings", html.includes("verification") || html.includes("unverified"));
    check("report includes both improvement lenses", html.toLowerCase().includes("withoutsource") || html.toLowerCase().includes("without source"));
    console.log(`   report size: ${html.length} bytes`);

    await writeFile("/tmp/e2e/report.html", html, "utf8");
    console.log("   saved: /tmp/e2e/report.html");

    // ---- summary ----
    console.log(
      `\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed check(s)\n`,
    );
    if (failures > 0) process.exitCode = 1;
  } finally {
    await gateway.close();
    await api.close();
    // Keep dataDir when something failed so the artifacts can be inspected.
    if (failures === 0) {
      await rm(dataDir, { recursive: true, force: true });
    } else {
      console.log(`(kept data dir for inspection: ${dataDir})`);
    }
  }
}

void main().catch((err: unknown) => {
  console.error("\nE2E ERROR:", err);
  process.exitCode = 1;
});
