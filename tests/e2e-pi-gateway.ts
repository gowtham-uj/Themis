/**
 * Real pi agent driven by the mock model gateway.
 *
 * Companion to e2e-podman-reaper.ts, which covers ReaperCode. Same principle:
 * the AGENT is the real published `@earendil-works/pi-coding-agent` binary
 * running its genuine loop and tools; only the MODEL is ours.
 *
 * pi does not read ANTHROPIC_BASE_URL — it resolves provider endpoints from
 * `<agentDir>/models.json`. That is a real difference between the two agents,
 * so this exercises the seam pi actually has rather than pretending otherwise.
 *
 * Run: npx tsx tests/e2e-pi-gateway.ts
 */

import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePiStream } from "../src/adapters/pi.js";
import type { RunContext } from "../src/adapters/types.js";
import { bugfixPolicy, startMockGateway } from "./fixtures/mock-model-gateway.js";

const PI_CLI =
  process.env.AGENTEVAL_PI_BIN ??
  join(
    process.cwd(),
    "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  );
const FIXTURE = "/tmp/e2e/fixture-repo";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  console.log("agenteval end-to-end: REAL pi agent + mock model gateway\n");
  if (!existsSync(FIXTURE)) throw new Error(`fixture repo missing: ${FIXTURE}`);
  if (!existsSync(PI_CLI)) throw new Error(`pi cli missing: ${PI_CLI}`);

  const gateway = await startMockGateway({ policy: bugfixPolicy() });
  const ws = mkdtempSync(join(tmpdir(), "agenteval-pi-ws-"));
  const agentDir = mkdtempSync(join(tmpdir(), "agenteval-pi-agent-"));

  try {
    execSync(`cp -r ${FIXTURE}/. ${ws}/`);

    // pi's own seam: provider endpoints come from models.json, not env.
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            anthropic: {
              baseUrl: gateway.baseUrl,
              apiKey: "mock-gateway-key",
              models: [
                {
                  id: "mock-model",
                  api: "anthropic-messages",
                  baseUrl: gateway.baseUrl,
                  contextWindow: 200_000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    console.log("1. run the real pi binary against the gateway");
    const child = spawn(
      process.execPath,
      [
        PI_CLI,
        "--mode",
        "json",
        "-p",
        "Fix the off-by-one in src/range.js so the range includes the end value.",
        "--provider",
        "anthropic",
        "--model",
        "mock-model",
      ],
      {
        cwd: ws,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          ANTHROPIC_API_KEY: "mock-gateway-key",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", () => undefined);
    const exitCode = await new Promise<number>((r) =>
      child.on("close", (c) => r(c ?? 1)),
    );

    check("pi exited cleanly", exitCode === 0, `exit=${exitCode}`);
    check("pi called the mock gateway", gateway.calls.length > 0, `calls=${gateway.calls.length}`);
    check(
      "pi advertised its real toolset",
      gateway.calls[0]?.toolNames.includes("edit") === true,
      gateway.calls[0]?.toolNames.join(",") ?? "none",
    );

    console.log("\n2. pi really did the work in the workspace");
    const src = readFileSync(join(ws, "src/range.js"), "utf8");
    check("the loop bound was actually fixed", src.includes("i <= end"));
    check("the extra guard was actually applied", src.includes("typeof start"));

    console.log("\n3. the pi ADAPTER parses its real stdout");
    const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    check("pi emitted JSONL on stdout", lines.length > 0, `lines=${lines.length}`);

    const ctx: RunContext = {
      runId: "pi-e2e-1",
      project: { id: "p" },
      task: { prompt: "fix it", workspace: { source: "empty" } },
      model: "mock-model",
      provider: "anthropic",
      params: {},
      workspaceDir: ws,
      apiKeys: {},
    };
    const streams = {
      stdout: (async function* () {
        yield Buffer.from(stdout, "utf8");
      })(),
      stderr: (async function* () {
        // no stderr needed for parsing
      })(),
      exitCode: Promise.resolve(0),
    };
    const counts: Record<string, number> = {};
    for await (const ev of parsePiStream(streams as never, ctx)) {
      counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    }
    console.log(
      "   canonical events:",
      Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
    );
    check("adapter produced run.start", (counts["run.start"] ?? 0) === 1);
    check("adapter produced tool calls", (counts["tool.call"] ?? 0) > 0);
    check("adapter produced tool results", (counts["tool.result"] ?? 0) > 0);
    check("adapter produced messages", (counts.message ?? 0) > 0);
    // pi DOES stream thinking deltas when the model emits them; our gateway
    // sends none, so absence here is the gateway's choice, not an adapter gap.

    console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed check(s)\n`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await gateway.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

void main().catch((err: unknown) => {
  console.error("\nPI E2E ERROR:", err);
  process.exitCode = 1;
});
