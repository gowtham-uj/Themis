/** Queue analysis event, transcript, verdict, and report artifacts over the real API. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";

const servers: ApiServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("queue analysis artifact API", () => {
  it("serves the persisted PI trace, transcript, verdict, and HTML report", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agenteval-analysis-api-"));
    dirs.push(dataDir);
    const api = createServer({ dataDir });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;

    const project = api.queries.createProject({
      name: "Analysis API",
      slug: `analysis-api-${Date.now()}`,
    });
    const agent = api.queries.registerAgent({
      id: `analysis-agent-${Date.now()}`,
      displayName: "Analysis Agent",
    });
    const task = api.queries.createTask(project.id, {
      name: "Stored eval",
      prompt: "Inspect stored evidence",
      workspace: { source: "empty" },
      rubric: {
        version: 1,
        profile: "bugfix",
        criteria: [
          {
            id: "A1",
            axis: "A",
            label: "outcome",
            weight: 1,
            appliesTo: "coding",
            anchors: { full: "done", partial: "partial", none: "missing" },
          },
        ],
      },
      agentCategory: "coding",
    });
    const queue = api.queries.createEvalQueue(project.id, {
      name: "analysis queue",
      agentId: agent.id,
      model: "deepseek-v4-flash",
      provider: "nuralwatt",
      judgeModel: "deepseek-v4-flash",
      judgeProvider: "nuralwatt",
    });
    const batch = api.queries.createBatch({
      taskId: task.id,
      projectId: project.id,
      agentId: agent.id,
      model: queue.model,
      provider: queue.provider,
      repeats: 1,
      queueId: queue.id,
      queueRevision: queue.revision,
    });
    const run = api.queries.createRun({
      batchId: batch.id,
      taskId: task.id,
      projectId: project.id,
      queueId: queue.id,
      agentId: agent.id,
      model: queue.model,
      provider: queue.provider,
      repeatIndex: 0,
      status: "completed",
    });
    const analysis = api.queries.createQueueAnalysis({
      queueId: queue.id,
      projectId: project.id,
      batchId: batch.id,
      selectedRunIds: [run.id],
      evidenceHashes: { [run.id]: "a".repeat(64) },
      judgeModel: "deepseek-v4-flash",
      judgeProvider: "nuralwatt",
      systemPromptVersion: "2-queue-pi-v1",
      status: "running",
    });

    const analysisDir = join(dataDir, "projects", project.id, "queue-analyses", analysis.id);
    await mkdir(analysisDir, { recursive: true });
    const eventsPath = join(analysisDir, "pi-judge-events.jsonl");
    const transcriptPath = join(analysisDir, "pi-session.json");
    const verdictPath = join(analysisDir, "verdict.json");
    const reportPath = join(analysisDir, "report.html");
    await Promise.all([
      writeFile(eventsPath, '{"type":"agent_start"}\n', "utf8"),
      writeFile(transcriptPath, '{"engine":"pi","messages":[]}\n', "utf8"),
      writeFile(verdictPath, '{"schemaVersion":1,"perEval":[]}\n', "utf8"),
      writeFile(reportPath, "<!doctype html><html><body>analysis report</body></html>", "utf8"),
    ]);
    api.queries.updateQueueAnalysis(analysis.id, {
      status: "completed",
      eventsPath,
      rawResponsePath: transcriptPath,
      verdictPath,
      reportPath,
      endedAt: new Date().toISOString(),
    });

    const root = `/api/projects/${project.id}/queues/${queue.id}/analyses/${analysis.id}`;
    const events = await fetch(`${base}${root}/events`);
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await events.text()).toContain('"agent_start"');

    const transcript = await fetch(`${base}${root}/transcript`);
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toMatchObject({ engine: "pi" });

    const verdict = await fetch(`${base}${root}/verdict`);
    expect(verdict.status).toBe(200);
    expect(await verdict.json()).toMatchObject({ schemaVersion: 1 });

    const report = await fetch(`${base}${root}/report`);
    expect(report.status).toBe(200);
    expect(report.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await report.text()).toContain("analysis report");
  });
});
