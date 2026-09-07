/**
 * PI runtime — launch the real `pi` coding-agent headlessly, configured with the
 * saved connection object (openai-compatible proxy from project config) and the
 * pi-subagents / pi-dynamic-workflows extensions.
 *
 * No SDK is imported here beyond what pi itself ships; this module writes the
 * exact `models.json` + agent definitions pi reads, then shells out to the pi
 * CLI the same way the eval runner does.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ProviderThrottledError } from "../gateway/errors.js";
import {
  mergeStoredModelConfig,
  resolveModelConfig,
  resolveWebSearchCredential,
  type ModelApiType,
  type ModelStage,
  type StoredModelConfig,
} from "../../config/model-config.js";

export interface PiConnection {
  /** OpenAI-compatible base URL (e.g. the saved proxy). */
  baseUrl: string;
  /** API key for that endpoint. */
  apiKey: string;
  /** Model id from the stage's project/global config. */
  model: string;
  /** Reasoning effort for the orchestrator run. */
  reasoningEffort: string;
  /** API compatibility type, written into pi's models.json. */
  apiType?: ModelApiType;
  /** Optional Serper credential passed only to the mediated web-search tool. */
  webSearchApiKey?: string;
  /** Variable name used for diagnostics; never contains the credential. */
  webSearchApiKeyEnv?: string;
}

/**
 * Build a PI connection from one stage's unified model config. Every PI call
 * site goes through here, so Phase 1 and Phase 2 cannot drift apart the way
 * the hand-rolled env chains they replace did.
 */
export function piConnectionFor(
  stage: ModelStage,
  env: NodeJS.ProcessEnv = process.env,
  project?: StoredModelConfig | null,
): PiConnection {
  const stored = mergeStoredModelConfig(project);
  const cfg = resolveModelConfig(stage, { env, stored });
  const web = resolveWebSearchCredential(stage, { env, stored });
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    reasoningEffort: cfg.reasoningEffort,
    apiType: cfg.apiType,
    ...(web ? { webSearchApiKey: web.apiKey, webSearchApiKeyEnv: web.apiKeyEnv } : {}),
  };
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
  /** Override the orchestrator --tools allowlist (Phase-2 PI board uses a different set). */
  tools?: string;
  /** Extra env for this PI process (Phase-2 campaign dir, proxy for provider search). */
  extraEnv?: NodeJS.ProcessEnv;
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
/** Linux /proc children of one pid. Empty on any other OS or if the process is gone. */
function childPids(pid: number): number[] {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    return raw.trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Parent last, so children are signalled first. */
function collectTree(pid: number, seen = new Set<number>()): number[] {
  if (seen.has(pid)) return [];
  seen.add(pid);
  const kids = childPids(pid).flatMap((c) => collectTree(c, seen));
  return [...kids, pid];
}

/** SIGTERM then SIGKILL a pid and every descendant. Session jsonl stays. */
export function killPidTree(pid: number): void {
  const tree = collectTree(pid);
  for (const p of tree) {
    try { process.kill(p, "SIGTERM"); } catch { /* already dead */ }
  }
}

/** SIGTERM then SIGKILL the PI process recorded in workDir/pi.pid, including investigator children. Session jsonl stays. */
export async function pausePiWorkDir(workDir: string): Promise<{ killed: boolean; pid: number | null }> {
  let raw = "";
  try { raw = await readFile(join(workDir, "pi.pid"), "utf8"); } catch { return { killed: false, pid: null }; }
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return { killed: false, pid: null };
  // `pi.pid` outlives the process that wrote it, so a stale file made this
  // report killed:true for a pid that exited hours ago. `collectTree` always
  // returns at least [pid], so the old empty-tree branch was unreachable and
  // `killPidTree` swallows every ESRCH. Callers use `killed` to decide whether
  // to try the alternate work dir (phase1-service.ts, judge-routes.ts,
  // pipeline-routes.ts), so a false positive silently skipped the real dir and
  // still answered 200.
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  // A crashed run never froze its own session, so freeze it even when the pid is
  // already gone; that is what makes the crash resumable instead of lost.
  if (!alive) { await freezePiSession(workDir); return { killed: false, pid }; }
  const tree = collectTree(pid);
  killPidTree(pid);
  await new Promise((r) => setTimeout(r, 1500));
  for (const p of [pid, ...tree]) {
    try { process.kill(p, "SIGKILL"); } catch { /* already dead */ }
  }
  // Freeze the orchestrator session so resume --continues this exact jsonl,
  // not a new session. Drop a torn last line from the SIGKILL, then snapshot.
  await freezePiSession(workDir);
  return { killed: true, pid };
}

/** Pointer file under sessions/: absolute path of the jsonl to --continue. */
export const PI_RESUME_POINTER = ".resume-session";
/** Recovery manifest for interrupted Kratos/Logos/Minos/etc. children. */
export const PI_CHILD_RESUME_MANIFEST = ".resume-children.json";

async function freezeJsonl(path: string): Promise<void> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  while (lines.length) {
    try {
      JSON.parse(lines[lines.length - 1]!);
      break;
    } catch {
      lines.pop();
    }
  }
  const frozen = `${lines.join("\n")}${lines.length ? "\n" : ""}`;
  await writeFile(path, frozen, "utf8");
  await copyFile(path, path.replace(/\.jsonl$/, ".frozen.jsonl"));
}

async function nestedSessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "session.jsonl") out.push(path);
    }
  };
  await walk(root);
  return out;
}

interface FrozenChild {
  runId: string;
  index: number;
  agent: string;
  sessionFile: string;
}

/**
 * pi-subagents' own retained-run record (`ForegroundResumeChild`). Only these
 * four statuses pass its `isRestorableForegroundStatus` gate; anything else
 * makes the package drop the whole run row on read.
 */
interface PiHistoryChild {
  agent: string;
  index: number;
  status: "completed" | "failed" | "paused" | "stopped";
  sessionFile?: string;
  model?: string;
  [key: string]: unknown;
}
interface PiHistoryRun {
  runId: string;
  mode: "single" | "parallel" | "chain";
  cwd: string;
  sessionId: string;
  updatedAt: number;
  children: PiHistoryChild[];
}

/** pi-subagents caps its own index at MAX_REMEMBERED_FOREGROUND_RUNS. */
const PI_MAX_REMEMBERED_RUNS = 50;

/**
 * Freeze all child session files and record the interrupted ones in
 * pi-subagents' own retained foreground history, in the exact shape its
 * `restoreForegroundRunHistory` / `resolveForegroundResumeTarget` pair reads.
 * That makes `subagent({action:"resume", id, index})` revive the exact child
 * jsonl, model, provider, tool contract, and already-read context, instead of
 * us maintaining a second parallel tracker the package cannot see.
 */
async function freezeChildSessions(
  workDir: string,
  parentSessionPath: string,
): Promise<FrozenChild[]> {
  const sessionDir = join(workDir, "sessions");
  const artifactsDir = join(sessionDir, "subagent-artifacts");
  // PI_SUBAGENTS_TEMP_ROOT is set to <workDir>/subagents, so the package's
  // RESULTS_DIR resolves here. Writing anywhere else is invisible to it.
  const resultsDir = join(workDir, "subagents", "async-subagent-results");
  const historyPath = join(resultsDir, "foreground-history.json");
  const childPaths = await nestedSessionFiles(sessionDir);
  if (childPaths.length === 0) return [];

  let runs: PiHistoryRun[] = [];
  try {
    const parsed = JSON.parse(await readFile(historyPath, "utf8")) as { version?: number; runs?: PiHistoryRun[] };
    if (parsed?.version === 1 && Array.isArray(parsed.runs)) runs = parsed.runs;
  } catch { /* first interrupted child */ }
  const known = new Map(runs.map((r) => [r.runId, r]));
  const frozen: FrozenChild[] = [];
  const candidates = await readdir(artifactsDir).catch(() => []);
  const discovered = new Map<string, Array<FrozenChild & { model?: string }>>();

  for (const sessionFile of childPaths) {
    await freezeJsonl(sessionFile);
    const parts = sessionFile.split(/[\\/]/);
    const runPos = parts.findIndex((p, i) => /^run-\d+$/.test(p) && parts[i + 1] === "session.jsonl");
    if (runPos < 1) continue;
    const runId = parts[runPos - 1]!;
    const index = Number(parts[runPos]!.slice(4));
    const prefix = `${runId}_`;
    const suffix = `_${index}_input.md`;
    const inputName = candidates.find((n) => n.startsWith(prefix) && n.endsWith(suffix));
    const agent = inputName?.slice(prefix.length, -suffix.length) || "worker";
    let model: string | undefined;
    try {
      for (const line of (await readFile(sessionFile, "utf8")).split("\n").reverse()) {
        if (!line) continue;
        const row = JSON.parse(line) as { message?: { provider?: string; model?: string } };
        const provider = row.message?.provider;
        const id = row.message?.model;
        // `<provider>/<model>:<thinking>` is the form the package's
        // splitThinkingSuffix + provider resolution expects on revive.
        if (provider && id) { model = `${provider}/${id}:medium`; break; }
      }
    } catch { /* model remains bound by the saved agent definition */ }
    const rows = discovered.get(runId) ?? [];
    rows.push({ runId, index, agent, sessionFile, ...(model ? { model } : {}) });
    discovered.set(runId, rows);
  }

  const now = Date.now();
  for (const [runId, children] of discovered) {
    const remembered = known.get(runId);
    // Merge per CHILD, not per run. pi persists a run row as soon as its first
    // child terminates, so a parallel run that already has a row can still have
    // a live sibling. Skipping the whole run (the earlier bug) left that
    // sibling unresumable; overwriting the row would resurrect siblings the
    // package already settled as completed/failed. Only children pi has NOT
    // recorded a terminal status for were live at this pause.
    const settled = new Set((remembered?.children ?? []).map((c) => c.index));
    const live = children.filter((c) => !settled.has(c.index));
    if (live.length === 0) continue;
    frozen.push(...live);
    const merged: PiHistoryChild[] = [
      ...(remembered?.children ?? []),
      ...live.map((child) => ({
        agent: child.agent,
        index: child.index,
        context: "fresh" as const,
        sessionFile: child.sessionFile,
        ...(child.model ? { model: child.model } : {}),
        thinking: "medium",
        // "paused" is one of the four statuses the package will restore.
        status: "paused" as const,
        outputState: "unknown" as const,
        updatedAt: now,
      })),
    ].sort((a, b) => a.index - b.index);
    const row: PiHistoryRun = {
      runId,
      mode: merged.length > 1 ? "parallel" : "single",
      // The package requires a non-empty cwd and rejects the run row otherwise.
      cwd: remembered?.cwd || process.cwd(),
      // resolveForegroundResumeTarget only matches runs whose sessionId equals
      // the live parent session identity, which pi reports as its session file.
      sessionId: parentSessionPath,
      updatedAt: now,
      children: merged,
    };
    if (remembered) runs[runs.indexOf(remembered)] = row;
    else runs.unshift(row);
    known.set(runId, row);
  }

  await mkdir(resultsDir, { recursive: true });
  // Same ordering and bound the package applies in persistForegroundRunHistory,
  // so our write and its next write agree on which runs survive.
  const bounded = [...runs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, PI_MAX_REMEMBERED_RUNS);
  await writeFile(historyPath, `${JSON.stringify({ version: 1, runs: bounded }, null, 2)}\n`);
  await writeFile(join(sessionDir, PI_CHILD_RESUME_MANIFEST), `${JSON.stringify({ version: 1, children: frozen }, null, 2)}\n`);
  return frozen;
}

/**
 * Repair and snapshot the orchestrator and subagent session jsonl files.
 * Resume reads the pointers and continues the same parent and child sessions.
 */
export async function freezePiSession(workDir: string): Promise<string | null> {
  const sessionDir = join(workDir, "sessions");
  let names: string[] = [];
  try {
    names = (await readdir(sessionDir)).filter(
      (n) => n.endsWith(".jsonl") && !n.endsWith(".frozen.jsonl"),
    );
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const chosen =
    names.filter((n) => n.includes("_ae-")).sort().at(-1) ?? names.sort().at(-1)!;
  const sessionPath = join(sessionDir, chosen);
  await freezeJsonl(sessionPath);
  await freezeChildSessions(workDir, sessionPath);
  await writeFile(join(sessionDir, PI_RESUME_POINTER), `${sessionPath}\n`, "utf8");
  return sessionPath;
}

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
        // pi names the two wire formats it speaks. The API compatibility type
        // comes from the stage's unified config, so an Anthropic-compatible
        // endpoint is reached with Anthropic's Messages API rather than a 404
        // against /chat/completions.
        api: conn.apiType === "anthropic" ? "anthropic-messages" : "openai-completions",
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
  if (!conn?.model) {
    throw new Error("subagent model is missing; set it on the project model settings");
  }
  const modelSpec = `themis-proxy/${conn.model}`;
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
      // read_court_record is load-bearing: minos does NOT investigate the sealed
      // archive, it weighs the COMMITTED investigator reports, which live in the
      // judge/ court-record store (THEMIS_JUDGE_DIR), not the archive. Without it
      // minos loops on read_evidence against archive paths that don't exist
      // (observed live: 136 denied reads, no minos-report filed).
      tools: "evidence_list, read_evidence, read_court_record, write_to_yaml_template, petition, read_scratchpad, channel",
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

/** Prompt files an operator may override per project. */
export const PROMPT_ASSET_IDS = [
  "themis-orchestrator.md",
  "kratos.md",
  "logos.md",
  "minos.md",
  "remedy.md",
  "clerk.md",
  "phase2-orchestrator.md",
  "phase2-investigator.md",
  "phase2-researcher.md",
  "phase2-designer.md",
  "phase2-reviewer.md",
] as const;

export type PromptAssetId = (typeof PROMPT_ASSET_IDS)[number];

/**
 * Load a prompt asset. A project override wins when it is a non-empty string;
 * otherwise the built-in draft in src/judge/prompts is used. Resume re-reads
 * this, so an edit on the project config page applies to the next continue.
 */
export async function loadPromptAsset(
  name: string,
  overrides?: Record<string, string> | null,
): Promise<string> {
  const override = overrides?.[name];
  if (typeof override === "string" && override.trim().length > 0) return override;
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

  // Fresh start folds the system prompt into -p (--system-prompt hangs this pi
  // build in json mode). Resume must NOT resend that brief: it would look like
  // a new case and the model redoes Kratos/Logos. -p is only the short
  // "continue this session" line; history lives in the frozen jsonl.
  const printPrompt = input.resumeSessionPath
    ? input.userPrompt
    : `${input.systemPrompt}\n\nCASE BRIEF:\n${input.userPrompt}`;
  const argv = [
    piBin,
    "--mode", "json",
    "-p", printPrompt,
    "--provider", "themis-proxy",
    "--model", input.connection.model,
    "--thinking", input.connection.reasoningEffort,
    // Mediated surface only (plan §6): the orchestrator reads evidence, spawns
    // investigators/judge via the subagent tool, and writes judge/ output. No
    // general shell. The subagents' own allowlists are in their .md frontmatter.
    "--tools", input.tools ?? "subagent,evidence_list,read_evidence,read_court_record,write_to_yaml_template,read_scratchpad,file_tangent,petition,grant,channel,web_search",
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
    // --continue does NOT take a path (that's a positional prompt). Pin the
    // file with --session, then --continue, and let -p send the resume brief
    // as the next user turn. Passing the jsonl path to --continue made pi
    // treat the file as a message and exit without running the court.
    argv.push("--session", input.resumeSessionPath);
    argv.push("--continue");
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
    // And pi's builtin `anthropic` provider, which was the one hole left in
    // this scrub. It bites hardest on an Anthropic-compatible stage, where a
    // child resolving a bare model name is most likely to reach for it.
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    PI_OFFLINE: "1",
    // Scope pi-subagents' whole store (per-child session files, transcripts,
    // artifacts, run events) under this case's work dir. That is what makes the
    // subagent session jsonl land in judge_traces/ rather than a shared /tmp
    // dir that the next run would clobber.
    PI_SUBAGENTS_TEMP_ROOT: join(input.workDir, "subagents"),
    // Disabling TLS verification for every courtroom child by default made a
    // MITM of judge model traffic trivial. It now requires the same explicit
    // operator opt-in the agent container already demands.
    ...(process.env.AGENTEVAL_ALLOW_INSECURE_TLS === "1"
      ? { NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0" }
      : {}),
    // Scoped judge/archive roots for the mediated tool surface (WP-7).
    THEMIS_JUDGE_DIR: input.workDir,
    THEMIS_ARCHIVE_DIR: input.archiveDir ?? process.env.THEMIS_ARCHIVE_DIR ?? "",
    // Search credentials for `web_search`. Serper covers the general web and
    // arXiv needs no key, so a court can retrieve real sources and earn
    // `fix_type: research_backed` instead of declining to cite anything. The
    // key is read from the environment and never written to a file.
    ...((input.connection.webSearchApiKey ?? process.env.SERPER_API_KEY ?? process.env.SERPER_SEARCH_API_KEY)
      ? { SERPER_API_KEY: input.connection.webSearchApiKey ?? process.env.SERPER_API_KEY ?? process.env.SERPER_SEARCH_API_KEY }
      : {}),
    ...(process.env.THEMIS_WEB_SEARCH_PROVIDERS
      ? { THEMIS_WEB_SEARCH_PROVIDERS: process.env.THEMIS_WEB_SEARCH_PROVIDERS }
      : {}),
    // Phase 2 still reads the proxy trio for its own purposes, and passes its
    // own values through extraEnv below.
    THEMIS_PROXY_BASE_URL: input.connection.baseUrl,
    THEMIS_PROXY_API_KEY: input.connection.apiKey,
    THEMIS_PROXY_MODEL: input.connection.model,
    ...(input.extraEnv ?? {}),
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
  await writeFile(join(input.workDir, "pi.pid"), `${child.pid ?? ""}\n`).catch(() => undefined);
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

  // A courtroom with Kratos + Logos + Minos routinely runs past 15 minutes.
  // The old 900s wall clock SIGKILL'd the parent mid-round; Minos never wrote
  // evalJudge.yaml, and resume then started a different work dir.
  const timeoutMs = input.timeoutMs ?? 2_700_000;
  const timer = setTimeout(() => {
    if (child.pid) killPidTree(child.pid);
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
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
