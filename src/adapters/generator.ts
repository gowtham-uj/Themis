/** User-authored adapter generator: clone, provision env, run script, parse JSON. */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareWorkspace } from "../runner/workspace.js";
import type { CreateProjectAgentAdapterInput } from "../db/queries.js";

export interface RunAdapterGeneratorInput {
  projectId: string;
  agentId: string;
  generatorScript: string;
  sourceRepo: string;
  sourceRef?: string | null;
  provider: string;
  model: string;
  /** Named credentials the project has access to (name → secret value). */
  credentials: Record<string, string>;
}

export interface RunAdapterGeneratorResult {
  adapter: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

/**
 * Clone the agent source, provision AGENTEVAL_* env, run the user's generator
 * script (bash or JS), and parse the emitted adapter JSON from stdout.
 *
 * The script receives a clone at AGENTEVAL_WORKSPACE_DIR and one file per
 * credential at AGENTEVAL_CREDENTIALS_DIR. It must NOT print credentials to
 * stdout — only the adapter JSON contract (which references credential names,
 * never values).
 */
export async function runAdapterGenerator(
  input: RunAdapterGeneratorInput,
): Promise<RunAdapterGeneratorResult> {
  const sourceDir = await mkdtemp(join(tmpdir(), "agenteval-gen-src-"));
  const credsDir = await mkdtemp(join(tmpdir(), "agenteval-gen-creds-"));
  const scriptFile = join(sourceDir, ".agenteval-generator");
  try {
    // Clone the agent source so the generator can inspect it.
    await prepareWorkspace(
      {
        source: "git",
        repo: input.sourceRepo,
        ...(input.sourceRef ? { ref: input.sourceRef } : {}),
      },
      { targetDir: sourceDir },
    );

    // Provision one file per named credential.
    await mkdir(credsDir, { recursive: true });
    for (const [name, value] of Object.entries(input.credentials)) {
      if (value) await writeFile(join(credsDir, name), value, "utf8");
    }

    // Write the generator script to a file.
    await writeFile(scriptFile, input.generatorScript, "utf8");

    const env: Record<string, string> = {
      ...process.env,
      AGENTEVAL_PROJECT_ID: input.projectId,
      AGENTEVAL_AGENT_ID: input.agentId,
      AGENTEVAL_SOURCE_REPO: input.sourceRepo,
      AGENTEVAL_SOURCE_REF: input.sourceRef ?? "",
      AGENTEVAL_PROVIDER: input.provider,
      AGENTEVAL_MODEL: input.model,
      AGENTEVAL_CREDENTIALS_DIR: credsDir,
      AGENTEVAL_WORKSPACE_DIR: sourceDir,
      AGENTEVAL_OUTPUT_PATH: "", // empty = stdout
    } as Record<string, string>;

    const { stdout, stderr } = await runScript(scriptFile, env);
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error(
        `adapter generator produced no stdout output${stderr ? `: ${stderr.slice(0, 1000)}` : ""}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `adapter generator stdout is not valid JSON: ${message}\nstdout (first 500): ${trimmed.slice(0, 500)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("adapter generator must emit a JSON object");
    }
    return { adapter: parsed as Record<string, unknown>, stdout: trimmed, stderr };
  } finally {
    await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(credsDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Detect script type from shebang and run it. */
function runScript(
  scriptFile: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveFn, reject) => {
    const child = spawn("bash", [scriptFile], {
      env,
      cwd: resolve(scriptFile, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as {
      stdout: NodeJS.ReadableStream;
      stderr: NodeJS.ReadableStream;
      on(event: "error", cb: (err: Error) => void): unknown;
      on(event: "close", cb: (code: number | null) => void): unknown;
    };
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(
          new Error(
            `adapter generator exited ${code}${stderr ? `: ${stderr.slice(0, 1000)}` : ""}`,
          ),
        );
        return;
      }
      resolveFn({ stdout, stderr });
    });
  });
}

/**
 * The input/output contract description for the discovery endpoint.
 * Callers render this as JSON; authors use it to write a generator.
 */
export const GENERATOR_CONTRACT = {
  inputEnv: [
    "AGENTEVAL_PROJECT_ID",
    "AGENTEVAL_AGENT_ID",
    "AGENTEVAL_SOURCE_REPO",
    "AGENTEVAL_SOURCE_REF",
    "AGENTEVAL_PROVIDER",
    "AGENTEVAL_MODEL",
    "AGENTEVAL_CREDENTIALS_DIR (one file per credential name; values are secrets — never print)",
    "AGENTEVAL_WORKSPACE_DIR (a clone of the agent source at source_ref)",
  ],
  output:
    "One JSON object on stdout matching POST /api/projects/:id/adapters body (snake_case). See plan/agent-adapter-sdk.md for the full field list.",
  outputRequiredFields: [
    "agent_id",
    "name",
    "image",
    "command {argv, env?, cwd?, timeout_ms?}",
    "connection_check {argv,...} OR derive_connection_check: true",
    "evidence {paths, required_paths?}",
    "parser_kind (canonical-jsonl | pi-jsonl | reapercode-jsonl)",
    "source_repo",
    "containerfile",
    "default_provider",
    "default_model",
  ],
  examples: {
    bash: `#!/bin/bash
set -euo pipefail
# Inspect the cloned agent source at $AGENTEVAL_WORKSPACE_DIR.
ENTRY=$(jq -r '.bin' "$AGENTEVAL_WORKSPACE_DIR/package.json" | head -1)
cat <<JSON
{
  "agent_id": "$AGENTEVAL_AGENT_ID",
  "name": "$AGENTEVAL_AGENT_ID",
  "image": "localhost/my-agent:latest",
  "source_repo": "$AGENTEVAL_SOURCE_REPO",
  "source_ref": "$AGENTEVAL_SOURCE_REF",
  "containerfile": "FROM node:22-bookworm\\nRUN apt-get update && apt-get install -y bash git sudo procps\\nWORKDIR /opt/agent\\nCOPY . .\\nRUN npm ci && npm run build && ln -s /opt/agent/$ENTRY /usr/local/bin/agent\\nCMD [\\"agent\\", \\"--help\\"]",
  "default_provider": "$AGENTEVAL_PROVIDER",
  "default_model": "$AGENTEVAL_MODEL",
  "command": {
    "argv": ["agent", "run", "--jsonl", "--prompt", "{{prompt}}", "--provider", "{{provider}}", "--model", "{{model}}", "--workspace", "{{workspace}}"],
    "cwd": "/workspace",
    "timeout_ms": 600000
  },
  "derive_connection_check": true,
  "provider_config": {
    "credentialEnv": {
      "default": { "AGENT_API_KEY": "AGENT_API_KEY" }
    }
  },
  "parser_kind": "canonical-jsonl",
  "evidence": {
    "paths": [".agent-runs", ".agent-logs"],
    "required_paths": [".agent-runs"]
  },
  "enabled": true
}
JSON`,
  },
} as const;
