import { createServer } from "../src/api/server.js";

async function main(): Promise<void> {
  const dataDir = process.env.AGENTEVAL_DATA!;
  const api = createServer({ dataDir, outboundDispatcher: null });
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const qc = api.queries as unknown as {
    listEvalQueues(): Array<{ id: string; projectId: string; judgeModel?: string | null; judgeProvider?: string | null }>;
    listQueueContainers(queueId: string): Array<{ batchId: string }>;
  };
  const q = qc.listEvalQueues()[0];
  if (!q) throw new Error("no queue");
  const containers = qc.listQueueContainers(q.id);
  const batchId = containers[0]?.batchId;
  console.log("queue", q.id, "batch", batchId);
  const res = await fetch(`${base}/api/projects/${q.projectId}/queues/${q.id}/analyses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      batch_id: batchId,
      all: true,
      judge_model: q.judgeModel ?? "deepseek-v4-flash",
      judge_provider: q.judgeProvider ?? "neuralwatt",
      judge_params: { maxTokens: 16384 },
    }),
  });
  const body = (await res.json()) as { analysis?: { status?: string; id?: string; error?: string | null; reportPath?: string | null } };
  console.log("HTTP", res.status, "analysis.status", body.analysis?.status, "error", body.analysis?.error);
  if (body.analysis?.reportPath) {
    const aid = body.analysis.id!;
    const report = await fetch(`${base}/api/projects/${q.projectId}/queues/${q.id}/analyses/${aid}/report`);
    const text = await report.text();
    console.log("report bytes", text.length);
    const events = await (await fetch(`${base}/api/projects/${q.projectId}/queues/${q.id}/analyses/${aid}/events`)).text();
    console.log("events has tool_execution_start:", events.includes("tool_execution_start"), "agent_start:", events.includes("agent_start"));
    const v = (await (await fetch(`${base}/api/projects/${q.projectId}/queues/${q.id}/analyses/${aid}/verdict`)).json()) as { perEval?: unknown[] };
    console.log("perEval count", v.perEval?.length);
  }
  await api.close();
}

void main().catch((err) => {
  console.error("REJUDGE ERROR:", err);
  process.exitCode = 1;
});
