import { createServer } from "/work/agenteval/src/api/server.js";
const DATA = "/tmp/agenteval-suite-e2e-iMI91i";
const PROJ = "fd5e2983-7435-4088-8ff1-bfff6ba1b924";
const Q = "1f1d9ed1-ab76-499b-9825-09f693179991";
const BATCH = "d3c0e810-7511-4120-95e7-f8633367012e";
async function main() {
  const api = createServer({ dataDir: DATA, outboundDispatcher: null });
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  console.log("server on", base);
  // Gather completed run ids from the batch.
  const runs = (api.queries as any).listRuns({ batchIds: [BATCH] }) ?? [];
  await api.close();
  // Use API to create analysis
  const api2 = createServer({ dataDir: DATA, outboundDispatcher: null });
  const port2 = await api2.listen(0);
  const base2 = `http://127.0.0.1:${port2}`;
  const res = await fetch(`${base2}/api/projects/${PROJ}/queues/${Q}/analyses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ batch_id: BATCH, all: true, judge_model: "deepseek-v4-flash", judge_provider: "neuralwatt", judge_params: { maxTokens: 16384 } }),
  });
  const body = await res.json();
  const analysis = body?.analysis ?? body;
  console.log("HTTP", res.status, "analysis", JSON.stringify(analysis).slice(0, 400));
  const aid = analysis?.id;
  if (!aid) { console.log("NO ANALYSIS ID", JSON.stringify(body).slice(0,300)); return; }
  // Wait for terminal
  for (let i = 0; i < 600; i++) {
    const v = await (await fetch(`${base2}/api/projects/${PROJ}/queues/${Q}/analyses/${aid}`)).json();
    const a = v?.analysis ?? v;
    if (a?.status === "completed" || a?.status === "failed") {
      console.log("FINAL", a.status, "report=", a.reportPath ?? "");
      if (a.reportPath) {
        const rep = await (await fetch(`${base2}/api/projects/${PROJ}/queues/${Q}/analyses/${aid}/report`)).text();
        console.log("REPORT_BYTES", rep.length);
        await import("node:fs/write").then(() => {});
        const fs = await import("node:fs");
        fs.writeFileSync("/tmp/agenteval-e2e-artifacts/reports/queue-report.html", rep);
        console.log("REPORT_SAVED /tmp/agenteval-e2e-artifacts/reports/queue-report.html");
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  await api2.close();
}
main().catch((e) => { console.error("REJUDGE ERROR:", e); process.exit(1); });
