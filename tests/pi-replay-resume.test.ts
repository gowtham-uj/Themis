/**
 * Session-replay resume (real pi): a persisted orchestrator session resumes via
 * `--continue`, and the subagent store is scoped under the case work dir so its
 * session/transcript files land in judge_traces/ — nothing is lost on resume.
 *
 * Gated on OPENAI_BASE_URL + OPENAI_API_KEY + AGENTEVAL_PI_E2E=1.
 */
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runPiOrchestrator, writePiModelsJson, writePiSubagentDefs, loadPromptAsset } from "../src/judge/pi/runtime.ts";

const LIVE =
  Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) &&
  process.env.AGENTEVAL_PI_E2E === "1";

async function setupAgentDir(): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "ae-pi-replay-"));
  const conn = {
    baseUrl: process.env.OPENAI_BASE_URL!,
    apiKey: process.env.OPENAI_API_KEY!,
    model: "deepseek-v4-flash",
    reasoningEffort: "low",
  };
  await writePiModelsJson(agentDir, conn);
  const [k, l, m, r] = await Promise.all([
    loadPromptAsset("kratos.md"),
    loadPromptAsset("logos.md"),
    loadPromptAsset("minos.md"),
    loadPromptAsset("remedy.md"),
  ]);
  await writePiSubagentDefs(agentDir, { kratos: k, logos: l, minos: m, remedy: r }, conn);
  return agentDir;
}

describe.skipIf(!LIVE)("PI session-replay resume (real)", () => {
  it("persists a session, resumes it, and recovers prior work", async () => {
    const agentDir = await setupAgentDir();
    const workDir = await mkdtemp(join(tmpdir(), "ae-pi-replay-work-"));
    const sessionDir = join(workDir, "sessions");
    const conn = {
      baseUrl: process.env.OPENAI_BASE_URL!,
      apiKey: process.env.OPENAI_API_KEY!,
      model: "deepseek-v4-flash",
      reasoningEffort: "low",
    };

    // Run 1: fresh session, remember a phrase.
    const first = await runPiOrchestrator({
      connection: conn,
      systemPrompt: "You are a test orchestrator.",
      userPrompt: "Remember this exact phrase: BUTTERFLY-42. Reply ACK.",
      agentDir,
      workDir,
      caseId: "replay-case",
      sessionDir,
      archiveDir: "/tmp",
      timeoutMs: 180_000,
    });
    expect(first.exitCode).toBe(0);
    expect(first.content).toMatch(/ACK/i);

    // A session file was persisted under sessionDir.
    const sessions = (await readdir(sessionDir)).filter((f) => f.endsWith(".jsonl"));
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const resumePath = join(sessionDir, sessions[sessions.length - 1]!);
    const tracePath = join(workDir, "pi-stdout.jsonl");
    const traceBytesBeforeResume = (await stat(tracePath)).size;

    // Run 2: resume that exact session and ask for the remembered phrase.
    const second = await runPiOrchestrator({
      connection: conn,
      systemPrompt: "You are a test orchestrator.",
      userPrompt: "What phrase did you remember earlier? Answer with only that phrase.",
      agentDir,
      workDir,
      caseId: "replay-case",
      sessionDir,
      resumeSessionPath: resumePath,
      archiveDir: "/tmp",
      timeoutMs: 180_000,
    });
    expect(second.exitCode).toBe(0);
    // The resumed session recovered the prior turn's content.
    expect(second.content).toMatch(/BUTTERFLY-42/i);
    // Resume APPENDS to the raw trace; the pre-pause history was not truncated.
    expect((await stat(tracePath)).size).toBeGreaterThan(traceBytesBeforeResume);
  }, 10 * 60_000);
});
