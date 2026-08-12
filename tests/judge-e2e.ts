/**
 * Standalone judge E2E: run the judge against a saved run's 10 eval archives and
 * produce the report, so the judge can be iterated on independently of the full
 * eval-run pipeline.
 *
 * Usage (from repo root):
 *   AGENTEVAL_JUDGE_E2E_DATA=/path/to/agenteval-suite-e2e-XXX \
 *     NEURALWATT_API_KEY=... AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1 \
 *     npx tsx tests/judge-e2e.ts
 *
 * The data dir defaults to the newest /tmp/agenteval-suite-e2e-*.
 * Exit code 0 = report generated; non-zero = judge failed.
 */

import { execFileSync } from "node:child_process";
import { readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/api/server.js";

async function pickDataDir(): Promise<string> {
  const env = process.env.AGENTEVAL_JUDGE_E2E_DATA;
  if (env) return env;
  // newest agenteval-suite-e2e-* under /tmp
  const base = tmpdir();
  const matches = (await readdir(base, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("agenteval-suite-e2e-"))
    .map((e) => join(base, e.name));
  if (matches.length === 0) throw new Error("no agenteval-suite-e2e-* data dir found; set AGENTEVAL_JUDGE_E2E_DATA");
  let newest = matches[0]!;
  for (const m of matches) {
    if ((await stat(m)).mtimeMs > (await stat(newest)).mtimeMs) newest = m;
  }
  return newest;
}

async function main(): Promise<void> {
  const dataDir = await pickDataDir();
  console.log("data dir:", dataDir);
  const db = join(dataDir, "agenteval.db");
  const q = (q: string): string =>
    execFileSync("sqlite3", [db, q], { encoding: "utf8" }).trim();
  const projectId = q("SELECT project_id FROM queue_analyses ORDER BY created_at DESC LIMIT 1;")
    || q("SELECT project_id FROM runs LIMIT 1;");
  const queueId = q("SELECT queue_id FROM runs LIMIT 1;");
  const batchId = q("SELECT DISTINCT batch_id FROM runs LIMIT 1;");
  if (!projectId || !queueId || !batchId) throw new Error("no runs found in data dir");
  console.log("project", projectId, "queue", queueId, "batch", batchId);
  const completed = q(`SELECT count(*) FROM runs WHERE status='completed';`);
  console.log("completed runs:", completed);

  const api = createServer({ dataDir, outboundDispatcher: null }); // reconcileOrphans clears wedged analyses
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  console.log("server:", base);

  const res = await fetch(`${base}/api/projects/${projectId}/queues/${queueId}/analyses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      batch_id: batchId,
      all: true,
      judge_model: "deepseek-v4-flash",
      judge_provider: "neuralwatt",
      judge_params: { timeoutMs: 90 * 60_000 }, // let the model's configured max tokens / context window govern output
    }),
  });
  const body = (await res.json()) as { analysis?: { id?: string } };
  const aid = body.analysis?.id;
  if (!aid) throw new Error(`no analysis id: ${JSON.stringify(body).slice(0, 300)}`);
  console.log("analysis:", aid);

  // Wait for terminal status.
  let finalStatus = "running";
  let reportPath = "";
  for (let i = 0; i < 1200; i++) {
    const v = (await (await fetch(`${base}/api/projects/${projectId}/queues/${queueId}/analyses/${aid}`)).json()) as
      { analysis?: { status?: string; reportPath?: string | null; error?: string | null } };
    const a = v.analysis ?? v;
    if (a.status === "completed" || a.status === "failed") {
      finalStatus = a.status ?? "failed";
      reportPath = a.reportPath ?? "";
      console.log("FINAL", finalStatus, "report=", reportPath, "error=", a.error ?? "");
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (finalStatus === "completed" && reportPath) {
    const rep = await (await fetch(`${base}/api/projects/${projectId}/queues/${queueId}/analyses/${aid}/report`)).text();
    const out = "/work/agenteval-e2e-artifacts/reports/queue-report.html";
    await writeFile(out, rep);
    console.log("REPORT_SAVED", out, rep.length, "bytes");
    // Also confirm the queue-run archive bundle exists.
    const analysisDir = join(dataDir, "projects", projectId, "queue-analyses", aid);
    const bundle = join(analysisDir, "queue-run-archive.tar.gz");
    try { const s = await stat(bundle); console.log("QUEUE-RUN-ARCHIVE", bundle, s.size, "bytes"); }
    catch { console.log("WARN: queue-run-archive.tar.gz not found"); }
    await api.close();
    return;
  }

  await api.close();
  throw new Error(`judge ended ${finalStatus} without a report`);
}

main().catch((e) => {
  console.error("JUDGE_E2E ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
