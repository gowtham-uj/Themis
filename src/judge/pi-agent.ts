/** Reusable PI SDK host for real tool-using judge agents. */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface PiJudgeAgentInput {
  cwd: string;
  agentDir: string;
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: ToolDefinition[];
  eventsPath: string;
  transcriptPath: string;
  timeoutMs?: number;
  maxTokens?: number;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Optional serialized observer for adapting PI events into another trace schema. */
  onEvent?: (event: AgentSessionEvent) => void | Promise<void>;
}

export interface PiJudgeAgentResult {
  sessionId: string;
  model: string;
  provider: string;
  eventCount: number;
}

/** Run one isolated PI judge session with only the supplied custom tools. */
export async function runPiJudgeAgent(
  input: PiJudgeAgentInput,
): Promise<PiJudgeAgentResult> {
  await Promise.all([
    mkdir(input.cwd, { recursive: true }),
    mkdir(input.agentDir, { recursive: true }),
    mkdir(dirname(input.eventsPath), { recursive: true }),
    mkdir(dirname(input.transcriptPath), { recursive: true }),
  ]);

  const provider = normalizeProviderId(input.provider);
  const modelRuntime = await createJudgeModelRuntime(
    provider,
    input.model,
    input.maxTokens,
  );
  const model = modelRuntime.getModel(provider, input.model);
  if (!model) {
    throw new Error(`PI judge model is not registered: ${provider}/${input.model}`);
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => input.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRuntime,
    model,
    thinkingLevel: input.thinkingLevel ?? "high",
    noTools: "builtin",
    tools: input.tools.map((tool) => tool.name),
    customTools: input.tools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(input.cwd),
  });

  let eventCount = 0;
  let eventWrites = Promise.resolve();
  const unsubscribe = session.subscribe((event) => {
    eventCount += 1;
    eventWrites = eventWrites.then(async () => {
      await appendFile(input.eventsPath, `${stringifyJson(event)}\n`, "utf8");
      await input.onEvent?.(event);
    });
  });

  const prompt = session.prompt(input.userPrompt);
  const timeoutMs = input.timeoutMs ?? 30 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`PI judge timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([prompt, timeout]);
    await eventWrites;
    await writeFile(
      input.transcriptPath,
      `${stringifyJson({
        schemaVersion: 1,
        engine: "pi",
        sessionId: session.sessionId,
        provider,
        model: input.model,
        thinkingLevel: session.thinkingLevel,
        messages: session.messages,
      })}\n`,
      "utf8",
    );
    return {
      sessionId: session.sessionId,
      model: input.model,
      provider,
      eventCount,
    };
  } catch (error) {
    await session.abort().catch(() => undefined);
    await prompt.catch(() => undefined);
    await eventWrites.catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
    session.dispose();
  }
}

/** Normalize historical NeuralWatt spelling without changing other provider ids. */
export function normalizeProviderId(provider: string): string {
  const id = provider.trim().toLowerCase();
  return id === "neuralwatt" ? "nuralwatt" : id;
}

async function createJudgeModelRuntime(
  provider: string,
  model: string,
  maxTokens = 32_768,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ modelsPath: null });
  if (provider === "nuralwatt" || provider === "openai-compatible") {
    const apiKey = process.env.NEURALWATT_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("PI judge requires NEURALWATT_API_KEY for NeuralWatt");
    }
    runtime.registerProvider(provider, {
      baseUrl: (process.env.NEURALWATT_BASE_URL ?? "https://api.neuralwatt.com/v1").replace(
        /\/$/,
        "",
      ),
      apiKey: "$NEURALWATT_API_KEY",
      api: "openai-completions",
      models: [
        {
          id: model,
          name: model,
          reasoning: true,
          // NeuralWatt (vLLM) rejects the `developer` role and only accepts
          // `system`. Disable it so the openai-completions path uses `system`.
          compat: { supportsDeveloperRole: false },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens,
        },
      ],
    });
    await runtime.setRuntimeApiKey(provider, apiKey);
    return runtime;
  }

  const envKey = providerApiKey(provider);
  if (envKey) {
    const apiKey = process.env[envKey] ?? "";
    if (!apiKey) throw new Error(`PI judge requires ${envKey} for ${provider}`);
    await runtime.setRuntimeApiKey(provider, apiKey);
  }
  return runtime;
}

function providerApiKey(provider: string): string | null {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "google") return "GEMINI_API_KEY";
  return null;
}

function stringifyJson(value: AgentSessionEvent | Record<string, unknown>): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}
