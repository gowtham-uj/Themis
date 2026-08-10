import { createServer } from "../src/api/server.js";

async function main(): Promise<void> {
  const dataDir = process.env.AGENTEVAL_DATA!;
  const queueId = process.env.AGENTEVAL_QUEUE!;
  const projectId = process.env.AGENTEVAL_PROJECT!;
  const batchId = process.env.AGENTEVAL_BATCH!;
  const api = createServer({ dataDir, outboundDispatcher: null });
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  console.log("queue", queueId, "batch", batchId);
  const res = await fetch(`${base}/api/projects/${projectId}/queues/${queueId}/analyses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      batch_id: batchId,
      all: true,
      judge_model: "deepseek-v4-flash",
      judge_provider: "neuralwatt",
      judge_params: { maxTokens: 16384 },
    }),
  });
  const body = (await res.json()) as { analysis?: { status?: string; id?: string; error?: string | null; reportPath?: string | null } };
  console.log("HTTP", res.status, "analysis.status", body.analysis?.status, "error", body.analysis?.error);
  if (body.analysis?.id) {
    const aid = body.analysis.id;
    const report = await fetch(`${base}/api/projects/${projectId}/queues/${queueId}/analyses/${aid}/report`);
    const text = await report.text();
    console.log("report bytes", text.length);
    const events = await (await fetch(`${base}/api/projects/${projectId}/queues/${queueId}/analyses/${aid}/events`)).text();
    console.log("events: agent_start=", events.includes("agent_start"), "tool_execution_start=", events.includes("tool_execution_start"), "lines=", events.split("\n").filter(Boolean).length);
    const v = (await (await fetch(`${base}/api/projects/${projectId}/queues/${queueId}/analyses/${aid}/verdict`)).json()) as { perEval?: unknown[] };
    console.log("perEval count", v.perEval?.length);
    for (const section of ["Cross-eval themes", "Reliability", "Ranked defects", "Per-eval verdicts", "Improvement plan"]) {
      console.log("report has", section, ":", text.includes(section));
    }
  }
  await api.close();
}

void main().catch((err) => {
  console.error("REJUDGE ERROR:", err);
  process.exitCode = 1;
});
