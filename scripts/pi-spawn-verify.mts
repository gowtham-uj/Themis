import { runPiOrchestrator, loadPromptAsset } from "../src/judge/pi/runtime.js";
const r = await runPiOrchestrator({
  connection: { baseUrl: process.env.OPENAI_BASE_URL!, apiKey: process.env.OPENAI_API_KEY!, model: "deepseek-v4-flash", reasoningEffort: "low" },
  systemPrompt: "You are a test orchestrator.",
  userPrompt: "Reply with exactly OK.",
  agentDir: "/tmp/claude/verify-agent",
  workDir: "/tmp/claude/verify-work",
  archiveDir: "/tmp",
  timeoutMs: 60_000,
});
console.log("RESULT exit", r.exitCode, "timedOut", r.timedOut, "stdoutLen", r.stdout.length, "content", JSON.stringify(r.content.slice(0,80)));
