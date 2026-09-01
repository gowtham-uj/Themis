/**
 * Phase-2 PI board — investigator / researcher / designer / reviewer run as
 * real pi-subagents under one PI orchestrator (same coding-agent runtime as
 * Phase 1 Node 4). Campaign manager + pattern analyzer stay deterministic.
 */
import {createReadStream, createWriteStream} from "node:fs";
import {mkdir, mkdtemp, readFile, readdir, stat, writeFile, cp} from "node:fs/promises";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {pipeline} from "node:stream/promises";
import {createGzip} from "node:zlib";
import {parseAllDocuments} from "yaml";
import {
  loadPromptAsset, runPiOrchestrator, writePiModelsJson, type PiConnection,
} from "../pi/runtime.js";
import {coerceRecommendations, coerceReview} from "./analyst.js";
import type {Phase2Board, Phase2BoardContext} from "./board.js";
import type {Phase2Analyst} from "./analyst.js";
import type {
  Phase2Case, Phase2Hypothesis, Phase2MemoryRecord, Phase2Pattern,
  Phase2PlatformFinding, Phase2Recommendation, Phase2ResearchNote, Phase2Review,
} from "./types.js";

const PHASE2_TOOLS =
  "subagent,list_evals,list_patterns,read_pattern,read_improvements,read_lifecycle,read_judge_report,read_court_record,write_to_yaml_template,web_search";

const READ_TOOLS = "list_evals,list_patterns,read_pattern,read_improvements,read_lifecycle,read_judge_report,read_court_record,write_to_yaml_template";

export async function writePhase2PiSubagentDefs(
  agentDir: string,
  prompts: { investigator: string; researcher: string; designer: string; reviewer: string },
  conn?: { model: string },
): Promise<string[]> {
  const agentsDir = join(agentDir, "agents");
  await mkdir(agentsDir, { recursive: true });
  const themisToolsExt = join(process.cwd(), "src", "judge", "tools", "themis-tools-extension.ts");
  const modelSpec = `themis-proxy/${conn?.model ?? "deepseek-v4-flash"}`;
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
    subagents: {
      defaultModel: modelSpec,
      defaultExtensions: [themisToolsExt],
      agentOverrides: {
        investigator: { model: modelSpec, thinking: "medium" },
        researcher: { model: modelSpec, thinking: "medium" },
        designer: { model: modelSpec, thinking: "medium" },
        reviewer: { model: modelSpec, thinking: "medium" },
      },
    },
  }, null, 2)}\n`);
  const tierDir = join(homedir(), ".pi", "workflows");
  await mkdir(tierDir, { recursive: true });
  await writeFile(join(tierDir, "model-tiers.json"), `${JSON.stringify({ tiers: { small: modelSpec, medium: modelSpec, big: modelSpec } }, null, 2)}\n`);

  const defs = [
    {
      name: "investigator",
      description: "Phase-2 investigator: confirm patterns across evals and infer black-box mechanisms",
      tools: READ_TOOLS,
      body: prompts.investigator,
    },
    {
      name: "researcher",
      description: "Phase-2 researcher: provider web_search for techniques addressing confirmed mechanisms",
      tools: "web_search, read_court_record, list_patterns, write_to_yaml_template",
      body: prompts.researcher,
    },
    {
      name: "designer",
      description: "Phase-2 designer: black-box implementation handoffs and developer-run experiment plans",
      tools: READ_TOOLS,
      body: prompts.designer,
    },
    {
      name: "reviewer",
      description: "Phase-2 reviewer: keep or drop recommendations; never investigates",
      tools: "read_court_record, list_evals, list_patterns, read_judge_report, write_to_yaml_template",
      body: prompts.reviewer,
    },
  ];
  const written: string[] = [];
  for (const def of defs) {
    const path = join(agentsDir, `${def.name}.md`);
    await writeFile(path,
      `---\nname: ${def.name}\ndescription: ${def.description}\ntools: ${def.tools}\n` +
      `subagentOnlyExtensions: ${themisToolsExt}\n` +
      `model: ${modelSpec}\n` +
      `inheritProjectContext: false\ninheritSkills: false\ndefaultContext: fresh\n` +
      `turnBudget: {"maxTurns":40,"graceTurns":4}\n` +
      `defaultTimeoutMs: 600000\n` +
      `thinking: medium\nsystemPromptMode: replace\n---\n\n${def.body}\n`);
    written.push(path);
  }
  return written;
}

export interface Phase2PiResult {
  hypotheses: Phase2Hypothesis[];
  research: Phase2ResearchNote[];
  recommendations: Phase2Recommendation[];
  review: Phase2Review;
  workDir: string;
}

function parseYamlFile(raw: string): Record<string, unknown> {
  const docs = parseAllDocuments(raw);
  const merged: Record<string, unknown> = {};
  for (const d of docs) {
    const v = d.toJS();
    if (v && typeof v === "object") Object.assign(merged, v as object);
  }
  return merged;
}

async function loadYaml(workDir: string, name: string): Promise<Record<string, unknown>> {
  try {
    return parseYamlFile(await readFile(join(workDir, "judge", name), "utf8"));
  } catch {
    return {};
  }
}

/** Run the Phase-2 PI courtroom once and load filed YAML. */
export async function runPhase2PiCampaign(input: {
  connection: PiConnection;
  campaignId: string;
  projectId: string;
  cases: readonly Phase2Case[];
  patterns: readonly Phase2Pattern[];
  viewDirs: Readonly<Record<string, string>>;
  platformFaults: readonly string[];
  workDir?: string;
  timeoutMs?: number;
}): Promise<Phase2PiResult> {
  // Durable campaign traces live under data/platform/phase2/<campaignId>/ —
  // same idea as Phase-1 judge_traces/, campaign-level because Phase 2 is
  // cross-eval. Ephemeral mkdtemp is only a fallback.
  const workDir = input.workDir ?? join(process.cwd(), "data", "platform", "phase2", input.campaignId);
  const agentDir = await mkdtemp(join(tmpdir(), "ae-p2-pi-agent-"));
  const campaignDir = join(workDir, "campaign");
  await mkdir(campaignDir, { recursive: true });
  await mkdir(join(workDir, "judge"), { recursive: true });
  await writeFile(join(campaignDir, "cases.json"), `${JSON.stringify(input.cases, null, 2)}\n`);
  await writeFile(join(campaignDir, "patterns.json"), `${JSON.stringify(input.patterns, null, 2)}\n`);
  await writeFile(join(campaignDir, "views.json"), `${JSON.stringify(input.viewDirs, null, 2)}\n`);

  const [orchestrator, investigator, researcher, designer, reviewer] = await Promise.all([
    loadPromptAsset("phase2-orchestrator.md"),
    loadPromptAsset("phase2-investigator.md"),
    loadPromptAsset("phase2-researcher.md"),
    loadPromptAsset("phase2-designer.md"),
    loadPromptAsset("phase2-reviewer.md"),
  ]);
  await writePiModelsJson(agentDir, input.connection);
  await writePhase2PiSubagentDefs(agentDir, { investigator, researcher, designer, reviewer }, input.connection);

  const userPrompt = [
    `CAMPAIGN ${input.campaignId} project ${input.projectId}`,
    `Platform faults: ${input.platformFaults.join(" | ") || "(none)"}`,
    `Evals: ${input.cases.length}. Patterns: ${input.patterns.map((p) => p.id).join(", ") || "(none)"}`,
    "Dispatch investigator, then researcher, then designer, then reviewer. Blocking. Then stop.",
  ].join("\n");

  let resumeSessionPath: string | undefined;
  try {
    const sessionDir = join(workDir, "sessions");
    const jsonl = (await readdir(sessionDir)).filter((n) => n.endsWith(".jsonl")).sort();
    if (jsonl.length) resumeSessionPath = join(sessionDir, jsonl[jsonl.length - 1]!);
  } catch { /* fresh */ }

  await runPiOrchestrator({
    connection: input.connection,
    systemPrompt: orchestrator,
    userPrompt: resumeSessionPath
      ? "RESUME the Phase-2 courtroom. Do not re-run investigator if phase2-hypotheses.yaml exists. If research is filed, dispatch designer (blocking, async:false). If recommendations are filed, dispatch reviewer. Then stop. Never poll status."
      : userPrompt,
    agentDir,
    workDir,
    caseId: `phase2_${input.campaignId}`,
    timeoutMs: input.timeoutMs ?? 2_400_000,
    tools: PHASE2_TOOLS,
    resumeSessionPath,
    extraEnv: {
      THEMIS_PHASE2_CAMPAIGN_DIR: campaignDir,
      THEMIS_PROXY_BASE_URL: input.connection.baseUrl,
      THEMIS_PROXY_API_KEY: input.connection.apiKey,
      THEMIS_PROXY_MODEL: input.connection.model,
    },
  });

  const hypDoc = await loadYaml(workDir, "phase2-hypotheses.yaml");
  const resDoc = await loadYaml(workDir, "phase2-research.yaml");
  const recDoc = await loadYaml(workDir, "phase2-recommendations.yaml");
  const revDoc = await loadYaml(workDir, "phase2-review.yaml");
  const hypotheses = (Array.isArray(hypDoc.hypotheses) ? hypDoc.hypotheses : []) as Phase2Hypothesis[];
  const research = (Array.isArray(resDoc.notes) ? resDoc.notes : []) as Phase2ResearchNote[];
  const recommendations = coerceRecommendations(recDoc.recommendations ?? recDoc) as Phase2Recommendation[];
  const review = coerceReview(revDoc, recommendations.map((r) => r.id));
  return { hypotheses, research, recommendations, review, workDir };
}

/**
 * Copy PI orchestrator + subagent traces the same way Phase 1 seals judge_traces/.
 * pi-stdout.jsonl is gzipped; sessions/ and subagents/ stay raw (resume source).
 */
export async function copyPhase2Traces(srcWorkDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  let names: string[] = [];
  try { names = await readdir(srcWorkDir); } catch { return; }
  for (const name of names) {
    if (name === "judge" || name === "campaign") continue;
    const from = join(srcWorkDir, name);
    const st = await stat(from).catch(() => null);
    if (!st) continue;
    if (name === "pi-stdout.jsonl") {
      await pipeline(createReadStream(from), createGzip({ level: 6 }), createWriteStream(join(destDir, "pi-stdout.jsonl.gz")));
      continue;
    }
    await cp(from, join(destDir, name), { recursive: true, force: true });
  }
}

/** Phase2Board backed by one PI orchestrator run (cached). */
export class PiPhase2Board implements Phase2Board {
  private cache: Phase2PiResult | null = null;
  private pending: Parameters<NonNullable<Phase2Board["bind"]>>[0] | null = null;
  constructor(private connection: PiConnection, _designer?: Phase2Analyst) {}

  bind(input: Parameters<NonNullable<Phase2Board["bind"]>>[0]): void {
    this.pending = input;
  }

  private async ensure(): Promise<Phase2PiResult> {
    if (this.cache) return this.cache;
    if (!this.pending) throw new Error("PiPhase2Board.bind() was not called with campaign data");
    this.cache = await runPhase2PiCampaign({
      connection: this.connection,
      campaignId: this.pending.campaignId,
      projectId: this.pending.projectId,
      cases: this.pending.cases,
      patterns: this.pending.patterns,
      viewDirs: this.pending.viewDirs,
      platformFaults: [...this.pending.platformFaults],
    });
    return this.cache;
  }

  async investigate(): Promise<Phase2Hypothesis[]> {
    return (await this.ensure()).hypotheses;
  }
  async research(): Promise<Phase2ResearchNote[]> {
    return (await this.ensure()).research;
  }
  async recommend(): Promise<Phase2Recommendation[]> {
    return (await this.ensure()).recommendations;
  }
  async review(): Promise<Phase2Review> {
    return (await this.ensure()).review;
  }
}
