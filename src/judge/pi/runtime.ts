/**
 * PI runtime — launch the real `pi` coding-agent headlessly, configured with the
 * saved connection object (openai-compatible proxy, deepseek-v4-flash) and the
 * pi-subagents / pi-dynamic-workflows extensions.
 *
 * No SDK is imported here beyond what pi itself ships; this module writes the
 * exact `models.json` + agent definitions pi reads, then shells out to the pi
 * CLI the same way the eval runner does.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ProviderThrottledError } from "../gateway/errors.js";

export interface PiConnection {
  /** OpenAI-compatible base URL (e.g. the saved proxy). */
  baseUrl: string;
  /** API key for that endpoint. */
  apiKey: string;
  /** Model id (default deepseek-v4-flash). */
  model: string;
  /** Reasoning effort for the orchestrator run. */
  reasoningEffort: string;
}

export interface PiRunInput {
  connection: PiConnection;
  /** The orchestrator prompt (the themis-orchestrator system prompt). */
  systemPrompt: string;
  /** The concrete case brief (what the orchestrator must run). */
  userPrompt: string;
  /** Scratch dir this run owns (models.json + agents live here). */
  agentDir: string;
  /** Session/output dir. */
  workDir: string;
  /** Stable case identity — names the persisted session. */
  caseId?: string;
  /** Sealed archive root (read-only evidence for the mediated tools). */
  archiveDir?: string;
  /** Max wall-clock for the pi process. */
  timeoutMs?: number;
  /**
   * Where the PI session jsonl lives, so a pause/resume continues the SAME
   * orchestrator session instead of re-dispatching from scratch.
   */
  sessionDir?: string;
  /**
   * When set, resume this exact persisted session file via `--continue`
   * (session replay). The previous orchestrator/subagent work is preserved.
   */
  resumeSessionPath?: string;
}

export interface PiRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Final assistant content, when extractable from the JSON stream. */
  content: string;
  /** Path to the streamed stdout capture (always written). */
  stdoutPath: string;
}

/** Resolve the pi CLI entry. */
export function resolvePiBin(): string {
  const pkgRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
  return join(pkgRoot, "dist", "cli.js");
}

/** Stable, filesystem-safe session id for a case. */
function sessionId(caseId?: string): string {
  const base = (caseId ?? "case").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  return `ae-${base}`;
}

/**
 * Write pi's `models.json` for the saved connection. The proxy speaks the
 * OpenAI Chat Completions API and does NOT accept the `developer` role, so the
 * compat flags are load-bearing (the plan's §6 probe table records both).
 */
export async function writePiModelsJson(agentDir: string, conn: PiConnection): Promise<string> {
  const modelsPath = join(agentDir, "models.json");
  const payload = {
    providers: {
      "themis-proxy": {
        baseUrl: conn.baseUrl,
        api: "openai-completions",
        // Literal key, written only into this run's ephemeral mkdtemp agent dir
        // (removed after the run; never committed). Env interpolation breaks in
        // subagent child processes, which resolve against a different env (401).
        apiKey: conn.apiKey,
        // The proxy requires Authorization: Bearer. Without this pi never sends
        // the header and the first request hangs (observed live).
        authHeader: true,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
        },
        models: [
          {
            id: conn.model,
            reasoning: true,
            contextWindow: 128_000,
            // High reasoning effort burns most of the output budget on
            // reasoning_content before any report text; 8192 starved children
            // (stopReason "length", observed live). Give the model room to
            // finish the report after reasoning.
            maxTokens: 32768,
          },
        ],
      },
    },
  };
  await mkdir(agentDir, { recursive: true });
  await writeFile(modelsPath, `${JSON.stringify(payload, null, 2)}\n`);
  return modelsPath;
}

/**
 * Write the kratos/logos/minos subagent definitions (project `.pi/agents/*.md`),
 * each from the locked prompt draft with YAML frontmatter so pi-subagents
 * discovers them as real named subagents.
 *
 * Also writes `settings.json` so children inherit the themis-tools extension:
 * a child's `tools:` allowlist does not load extension code by itself — the
 * extension path must be listed in `subagents.defaultExtensions`, otherwise the
 * child fails with "requested unavailable child tools" (observed live).
 */
export async function writePiSubagentDefs(
  agentDir: string,
  prompts: { kratos: string; logos: string; minos: string; remedy: string },
  conn?: { model: string },
): Promise<string[]> {
  const agentsDir = join(agentDir, "agents");
  await mkdir(agentsDir, { recursive: true });

  const themisToolsExt = join(
    process.cwd(),
    "src",
    "judge",
    "tools",
    "themis-tools-extension.ts",
  );
  // Provider-QUALIFIED spec. A bare model name resolves against pi's builtin
  // catalogs, so children silently ran on the wrong model (observed live:
  // subagents resolved to gpt-5.5 and never produced reports).
  const modelSpec = `themis-proxy/${conn?.model ?? "deepseek-v4-flash"}`;
  const settings = {
    subagents: {
      defaultModel: modelSpec,
      defaultExtensions: [themisToolsExt],
      agentOverrides: {
        kratos: { model: modelSpec, thinking: "medium" },
        logos: { model: modelSpec, thinking: "medium" },
        minos: { model: modelSpec, thinking: "medium" },
        remedy: { model: modelSpec, thinking: "medium" },
      },
    },
  };
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );

  // pi-dynamic-workflows resolves subagent models through its OWN tier registry,
  // not the pi-subagents agent defs. Untagged agents fall back to the "medium"
  // tier, which defaulted to a builtin (gpt-5.5) and hit the proxy with a 401.
  // Pin every tier to the one configured model so both runners agree.
  const tierDir = join(homedir(), ".pi", "workflows");
  await mkdir(tierDir, { recursive: true });
  await writeFile(
    join(tierDir, "model-tiers.json"),
    `${JSON.stringify({ tiers: { small: modelSpec, medium: modelSpec, big: modelSpec } }, null, 2)}\n`,
  );

  const defs: Array<{ name: string; description: string; tools: string; body: string }> = [
    {
      name: "kratos",
      description: "Police investigator: wide trajectory/process canvassing, read-only over the record",
      // Tool NAMES only. The extension itself loads via subagents.defaultExtensions
      // in settings.json (written below); a path-like entry in `tools:` makes pi's
      // agent discovery hang (observed live).
      tools: "evidence_list, read_evidence, write_to_yaml_template, file_tangent, read_scratchpad, channel",
      body: prompts.kratos,
    },
    {
      name: "logos",
      description: "Forensic investigator: deep single-item artifact/diff examination, read-only",
      tools: "evidence_list, read_evidence, write_to_yaml_template, file_tangent, read_scratchpad, channel",
      body: prompts.logos,
    },
    {
      name: "minos",
      description: "The bench: receives the assembled case and rules; never investigates",
      tools: "evidence_list, read_evidence, write_to_yaml_template, petition, read_scratchpad, channel",
      body: prompts.minos,
    },
    {
      name: "remedy",
      description:
        "Remediation researcher: turns CONFIRMED findings into research-backed, applicability-filtered developer recommendations; never re-diagnoses the eval",
      tools: "web_search, write_to_yaml_template, read_scratchpad, channel",
      body: prompts.remedy,
    },
  ];

  const written: string[] = [];
  for (const def of defs) {
    const path = join(agentsDir, `${def.name}.md`);
    const md =
      `---\nname: ${def.name}\ndescription: ${def.description}\ntools: ${def.tools}\n` +
      // Loads the mediated tool surface in the CHILD process. Without this the
      // child's tools: allowlist names tools that don't exist there and the
      // launch fails with "requested unavailable child tools".
      `subagentOnlyExtensions: ${themisToolsExt}\n` +
      // Provider-qualified model in frontmatter (frontmatter outranks settings).
      `model: ${modelSpec}\n` +
      // Fresh context: investigators read the sealed archive through the
      // mediated tools, never fork the orchestrator's transcript (forking the
      // parent's reasoning-heavy session is what ballooned context and hung).
      `inheritProjectContext: false\ninheritSkills: false\ndefaultContext: fresh\n` +
      // A deep forensic sweep (logos) needs many turns to read the diff, decode
      // artifacts, and still FILE its report. The default budget cut it off at
      // 17 turns with "ran out of budget before filing" (observed live).
      // The frontmatter value must be VALID JSON (pi-subagents JSON-parses
      // object values): unquoted YAML flow keys were rejected as "invalid agent
      // definition" (observed live).
      `turnBudget: {"maxTurns":60,"graceTurns":4}\n` +
      `defaultTimeoutMs: 900000\n` +
      `thinking: medium\nsystemPromptMode: replace\n---\n\n${def.body}\n`;
    await writeFile(path, md);
    written.push(path);
  }
  return written;
}

/** Load a prompt asset relative to src/judge/prompts. */
export async function loadPromptAsset(name: string): Promise<string> {
  return readFile(join(process.cwd(), "src", "judge", "prompts", name), "utf8");
}

/**
 * Run the themis-orchestrator as a real pi process with the pi-subagents and
 * dynamic-workflows extensions loaded. Returns the raw JSON stream and final
 * content.
 */
export async function runPiOrchestrator(input: PiRunInput): Promise<PiRunResult> {
  const piBin = resolvePiBin();
  await writePiModelsJson(input.agentDir, input.connection);

  const subagentsExt = join(
    process.cwd(),
    "node_modules",
    "pi-subagents",
    "index.ts",
  );
  const dynamicExt = join(
    process.cwd(),
    "node_modules",
    "@quintinshaw",
    "pi-dynamic-workflows",
    "extensions",
    "workflow.ts",
  );
  const themisToolsExt = join(
    process.cwd(),
    "src",
    "judge",
    "tools",
    "themis-tools-extension.ts",
  );

  const argv = [
    piBin,
    "--mode", "json",
    // System prompt is folded into the user prompt: the pi CLI's --system-prompt
    // flag hangs this pi build under the headless JSON mode (observed live), so
    // the orchestrator receives its role as the first message instead.
    "-p", `${input.systemPrompt}\n\nCASE BRIEF:\n${input.userPrompt}`,
    "--provider", "themis-proxy",
    "--model", input.connection.model,
    "--thinking", input.connection.reasoningEffort,
    // Mediated surface only (plan §6): the orchestrator reads evidence, spawns
    // investigators/judge via the subagent tool, and writes judge/ output. No
    // general shell. The subagents' own allowlists are in their .md frontmatter.
    "--tools", "subagent,evidence_list,read_evidence,read_court_record,write_to_yaml_template,read_scratchpad,file_tangent,petition,grant,channel,web_search",
    "--extension", subagentsExt,
    "--extension", dynamicExt,
    "--extension", themisToolsExt,
    // PERSISTED session with a STABLE id, so a pause/resume continues the same
    // orchestrator session (session replay) instead of re-dispatching from
    // scratch. The session file lands in judge_traces/ and is the resume source.
    // NOTE: input.workDir is ALREADY the node4 dir (runNode4Pi passes it), so
    // the session dir is <workDir>/sessions — not a second nested node4.
    "--session-dir", input.sessionDir ?? join(input.workDir, "sessions"),
    "--offline",
    "--no-context-files",
  ];
  if (input.resumeSessionPath) {
    // Resume: --continue with the persisted session file. Mutually exclusive
    // with --session-id (fresh start), which is only added below on first run.
    argv.push("--continue", input.resumeSessionPath);
  } else {
    // Fresh start: stable session id so the persisted file is findable later.
    argv.push("--session-id", sessionId(input.caseId));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: input.agentDir,
    // Do NOT export OPENAI_API_KEY/OPENAI_BASE_URL. Subagent children inherit
    // the env but resolve providers from models.json; a bare OPENAI_API_KEY
    // makes pi's BUILTIN `openai` provider available, and children fell back to
    // it — sending the proxy key to api.openai.com (401, observed live).
    // models.json carries the literal key for themis-proxy, so the env is
    // unnecessary and actively harmful here.
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    // Same trap for pi's builtin `deepseek` provider: with DEEPSEEK_API_KEY set,
    // children resolved the bare model name to builtin deepseek/deepseek-v4-pro
    // and authenticated against the real DeepSeek API with our proxy key (401).
    DEEPSEEK_API_KEY: undefined,
    DEEPSEEK_BASE_URL: undefined,
    PI_OFFLINE: "1",
    // Scope pi-subagents' whole store (per-child session files, transcripts,
    // artifacts, run events) under this case's work dir. That is what makes the
    // subagent session jsonl land in judge_traces/ rather than a shared /tmp
    // dir that the next run would clobber.
    PI_SUBAGENTS_TEMP_ROOT: join(input.workDir, "subagents"),
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0",
    // Scoped judge/archive roots for the mediated tool surface (WP-7).
    THEMIS_JUDGE_DIR: input.workDir,
    THEMIS_ARCHIVE_DIR: input.archiveDir ?? process.env.THEMIS_ARCHIVE_DIR ?? "",
  };

  // Stream stdout to disk so a long courtroom run is observable and never
  // held only in memory. Resolve on close (with a wall-clock kill on timeout).
  await mkdir(input.workDir, { recursive: true });
  const stdoutPath = join(input.workDir, "pi-stdout.jsonl");
  const stderrPath = join(input.workDir, "pi-stderr.log");
  // Resume appends to the existing raw trace — never truncate the pre-pause
  // history. The persisted PI session is the execution source; these streams are
  // its complete examination/audit trail in judge_traces/.
  const streamFlags = input.resumeSessionPath ? "a" : "w";
  const outStream = createWriteStream(stdoutPath, { flags: streamFlags });
  const errStream = createWriteStream(stderrPath, { flags: streamFlags });
  let stdoutBuf = "";
  let stderrBuf = "";

  const child = spawn(process.execPath, argv, {
    env,
    // pi must not block on stdin: with the default pipe the child waits for
    // input and never starts (observed live — identical argv worked in bash
    // where stdin is inherited).
    stdio: ["ignore", "pipe", "pipe"],
  });
  // A courtroom run can stream hundreds of MB of JSONL (multi-round subagent
  // transcripts). Never accumulate it all in one JS string — that overflowed a
  // 200MB run with `Invalid string length`. We keep only a bounded TAIL in
  // memory for the final-content extraction and stream the rest straight to disk.
  const MAX_STDOUT_MEM = 1_000_000;
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBuf.length < MAX_STDOUT_MEM) {
      stdoutBuf = (stdoutBuf + chunk.toString("utf8")).slice(-MAX_STDOUT_MEM);
    }
    outStream.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBuf.length < 1_000_000) {
      stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-1_000_000);
    }
    errStream.write(chunk);
  });

  const timeoutMs = input.timeoutMs ?? 900_000;
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timer);
  outStream.end();
  errStream.end();

  // pi-subagents can fail INSIDE a parent process that itself exits 0. Inspect
  // the per-child metadata as the authority: HTTP 402/429 / quota / balance
  // exhaustion must pause the durable queue, not look like a clean courtroom
  // completion with missing reports.
  const throttle = await detectPiThrottle(input.workDir, `${stdoutBuf}\n${stderrBuf}`);
  if (throttle !== null) {
    throw new ProviderThrottledError(throttle.message, throttle.kind, throttle.status);
  }

  return {
    exitCode,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    timedOut: exitCode === 137 || exitCode === 124,
    content: extractFinalContent(stdoutBuf),
    stdoutPath,
  };
}

interface DetectedThrottle {
  kind: "quota" | "rate_limit";
  status: number;
  message: string;
}

/**
 * Inspect the parent tail plus the child metadata files pi-subagents writes.
 * The child metadata is authoritative because a failed child can leave the
 * parent pi process with exit 0 and no top-level exception.
 */
export async function detectPiThrottle(workDir: string, tail: string): Promise<DetectedThrottle | null> {
  let text = tail;
  const roots = [
    join(workDir, "sessions", "subagent-artifacts"),
    join(workDir, "subagents", "artifacts"),
    join(workDir, "subagents", "async-subagent-results"),
  ];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith("_meta.json") && !name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(root, name), "utf8");
        // Bounded: metadata is small, but never let a corrupt file explode the
        // classifier's memory.
        text += `\n${raw.slice(-200_000)}`;
      } catch {
        /* stale or concurrently-written metadata: ignore and keep scanning */
      }
    }
  }

  const lower = text.toLowerCase();
  const quota = /http\s*402|\b402:|insufficient\s+(?:balance|quota|credits?)|quota\s+exhaust|billing\s+quota|balance\s+exceeded/.test(lower);
  if (quota) {
    return { kind: "quota", status: 402, message: "provider quota/balance exhausted during PI courtroom" };
  }
  const rate = /http\s*429|\b429:|too many requests|rate[ _-]?limit/.test(lower);
  if (rate) {
    return { kind: "rate_limit", status: 429, message: "provider rate-limited the PI courtroom" };
  }
  return null;
}

/** Extract the last assistant text from a pi `--mode json` stream. */
function extractFinalContent(jsonStream: string): string {
  const lines = jsonStream.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let last = "";
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      if (
        (ev.type === "message_start" || ev.type === "message_end" || ev.type === "turn_end") &&
        ev.message?.role === "assistant"
      ) {
        const text = (ev.message.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
        if (text) last = text;
      }
    } catch {
      // ignore non-JSON lines in a partial stream
    }
  }
  return last;
}
