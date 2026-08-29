import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { runNode4Pi } = await import("/work/agenteval/src/judge/graph/node4-pi.js");
const workDir = await mkdtemp(join(tmpdir(), "ae-direct-"));
const state = {
  caseId: "case_direct",
  runId: "run_direct",
  archiveDir: "/work/agenteval/data/archives/7b70d315-036d-4c14-a1a4-006fc2949c63",
  workDir,
  node: "node3",
  round: 0,
  paths: {
    sessionPath: "/work/agenteval/data/archives/7b70d315-036d-4c14-a1a4-006fc2949c63/session/conversation.md",
    clerkReportPath: "/dev/null",
  },
  hashes: {},
};
const { result } = await runNode4Pi(state, {
  connection: {
    baseUrl: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
    model: "deepseek-v4-flash",
    reasoningEffort: "low",
  },
  timeoutMs: 900_000,
});
console.log("RESULT exit", result.exitCode, "timedOut", result.timedOut, "stdoutLen", result.stdout.length);
