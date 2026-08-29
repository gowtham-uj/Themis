# pi-subagents — Agent Config Schema & Environment-Variable Support

## Summary Answer

**No.** pi-subagents has **no per-subagent environment-variable override** anywhere in its agent
config schema or launch API.

1. The `AgentConfig` object (used to describe/register an agent) has **no `env`/`environment`/
   `envVars` field**. The full field list is enumerated below.
2. The runtime `RuntimeAgentDefinition` accepted by `registerAgent` validates against an
   **explicit allow-list of fields** that does not include any env field; unknown fields are
   rejected with an error.
3. The per-launch params object (`SubagentParamsLike`) and the preflight `LaunchBindingInput`
   projection also have **no env field**.
4. The only mechanism by which a child subagent gets environment variables is **process
   inheritance**: at spawn time the child env is built as `{ ...process.env, ...sharedEnv }`
   (see below), i.e. it inherits the *entire parent process environment* wholesale. There is no
   API to inject a per-agent or per-run override map.

---

## 1. Does the agent config support an env override field?

**No.**

### Primary `AgentConfig` type
File: `node_modules/pi-subagents/src/agents/agents.ts` (lines 125–160)

```ts
export interface AgentConfig {
	name: string;
	runner?: AgentRunnerConfig;
	localName?: string;
	packageName?: string;
	packageSourceName?: string;
	packageSourceVersion?: string;
	packageSourceRoot?: string;
	description: string;
	aliases?: string[];
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	fallbackModels?: string[];
	thinking?: string | false;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	defaultAsync?: boolean;
	defaultTimeoutMs?: number;
	defaultToolTimeoutMs?: number;
	defaultTurnBudget?: TurnBudgetConfig;
	defaultAcceptance?: AcceptanceInput;
	acceptanceRole?: AcceptanceRole;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	discoveryPriority?: number;
	skills?: string[];
	skillPath?: string[];
	extensions?: string[];
	extensionsFromDefault?: boolean;
	subagentOnlyExtensions?: string[];
	output?: string;
	outputMode?: OutputMode;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number;
	completionGuard?: boolean;
	toolBudget?: ToolBudgetConfig;
	permissions?: PermissionRules;
	memory?: AgentMemoryConfig;
	disabled?: boolean;
	extraFields?: Record<string, string>;
	override?: BuiltinAgentOverrideInfo;
	modelSource?: AgentModelSourceInfo;
}
```

There is **no `env`, `environment`, `envVars`, or similar field** here. (`extraFields` is a
`Record<string, string>` for arbitrary/extra metadata but it is metadata only — it is not
injected into the child process environment; it appears nowhere in the child env builder.)

### Runtime `RuntimeAgentDefinition` (the programmatic create/update schema)
File: `node_modules/pi-subagents/src/agents/runtime-agent-registry.ts` (lines 18–57)

```ts
export interface RuntimeAgentDefinition {
	description: string;
	systemPrompt: string;
	aliases?: readonly string[];
	tools?: readonly string[];
	mcpDirectTools?: readonly string[];
	model?: string;
	// ... fallbackModels, thinking, systemPromptMode, inheritProjectContext,
	// inheritSkills, defaultContext, defaultAsync, defaultTimeoutMs,
	// defaultToolTimeoutMs, defaultTurnBudget, defaultAcceptance, acceptanceRole,
	// runner, skills, skillPath, extensions, subagentOnlyExtensions, output,
	// outputMode, defaultReads, defaultProgress, interactive, maxSubagentDepth,
	// completionGuard, toolBudget, permissions
	maxSubagentDepth?: number;
	completionGuard?: boolean;
	toolBudget?: ToolBudgetConfig;
	permissions?: PermissionRules;
}

export interface RegisterRuntimeAgentInput {
	pi: ExtensionAPI;
	name: string;
	definition: RuntimeAgentDefinition;
}
```

`validateDefinition` (runtime-agent-registry.ts lines ~202–243) enforces a **strict allow-list**
of supported keys:

```ts
const supported = new Set([
	"description", "systemPrompt", "aliases", "tools", "mcpDirectTools", "model", "fallbackModels", "thinking",
	"systemPromptMode", "inheritProjectContext", "inheritSkills", "defaultContext", "defaultAsync", "defaultTimeoutMs",
	"defaultToolTimeoutMs", "defaultTurnBudget", "defaultAcceptance", "acceptanceRole", "runner", "skills", "skillPath",
	"extensions", "subagentOnlyExtensions", "output", "outputMode", "defaultReads", "defaultProgress", "interactive",
	"maxSubagentDepth", "completionGuard", "toolBudget", "permissions",
]);
const unknown = Object.keys(definition).filter((key) => !supported.has(key));
if (unknown.length > 0) throw new Error(`Runtime agent definition has unknown fields: ${unknown.join(", ")}.`);
```

An `env` field would be rejected with "Runtime agent definition has unknown fields".

---

## 2. Any other mechanism to pass env vars to a child subagent at launch?

**No explicit/per-agent mechanism.** The only env injection is **whole-parent-process inheritance**.

### Per-launch params — `SubagentParamsLike`
File: `node_modules/pi-subagents/src/runs/foreground/subagent-executor.ts` (lines 270–360).
This is the object the runtime accepts for launching a subagent (`agent`, `task`, `model`,
`output`, `intercomBridge`, `timeoutMs`, `toolBudget`, `acceptance`, etc.). **No env field** exists
in it.

### Preflight launch binding — `LaunchBindingInput`
File: `node_modules/pi-subagents/src/shared/launch-contract.ts` (lines ~82–97).

```ts
export interface LaunchBindingInput {
	definitionDigest: string;
	task?: string;
	model?: string;
	modelCandidates?: string[];
	thinking?: string;
	systemPrompt?: string | null;
	systemPromptMode?: AgentConfig["systemPromptMode"];
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
	outputPath?: string;
	outputMode?: string;
	structuredOutputSchema?: unknown;
}
```

No env field. `projectLaunchBinding` (the canonical evidence projection of resolved inputs)
also contains no env.

### How the child env is actually built — inheritance only
File: `node_modules/pi-subagents/src/runs/foreground/execution.ts` (line 489):

```ts
const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
```

`sharedEnv` comes from `buildPiArgs` (`runs/shared/pi-args.ts`, lines ~678–863) and contains only
**internal pi plumbing variables** (e.g. `PI_SUBAGENT_CHILD`, `PI_SUBAGENT_PARENT_SESSION`,
`MCP_DIRECT_TOOLS`, capability-ceiling, watchdog config, etc.). There is no user-supplied env map.
Everything else in the child env is simply the parent's entire `process.env` copied through.

**Implication:** to set an env var visible to a subagent, a caller would have to mutate
`process.env` (or the parent process environment) before launching — there is no per-agent/
per-run override field, and such mutations would also leak to every other spawned child.

---

## 3. All fields accepted in the agent config object

### A. `AgentConfig` (agents.ts lines 125–160) — complete field list with types
- `name: string`
- `runner?: AgentRunnerConfig`
- `localName?: string`
- `packageName?: string`
- `packageSourceName?: string`
- `packageSourceVersion?: string`
- `packageSourceRoot?: string`
- `description: string`
- `aliases?: string[]`
- `tools?: string[]`
- `mcpDirectTools?: string[]`
- `model?: string`
- `fallbackModels?: string[]`
- `thinking?: string | false`
- `systemPromptMode: SystemPromptMode` ("replace" | "append")
- `inheritProjectContext: boolean`
- `inheritSkills: boolean`
- `defaultContext?: AgentDefaultContext` ("fresh" | "fork")
- `defaultAsync?: boolean`
- `defaultTimeoutMs?: number`
- `defaultToolTimeoutMs?: number`
- `defaultTurnBudget?: TurnBudgetConfig`
- `defaultAcceptance?: AcceptanceInput`
- `acceptanceRole?: AcceptanceRole` ("read-only" | "writer")
- `systemPrompt: string`
- `source: AgentSource`
- `filePath: string`
- `discoveryPriority?: number`
- `skills?: string[]`
- `skillPath?: string[]`
- `extensions?: string[]`
- `extensionsFromDefault?: boolean`
- `subagentOnlyExtensions?: string[]`
- `output?: string`
- `outputMode?: OutputMode` ("inline" | "file-only")
- `defaultReads?: string[]`
- `defaultProgress?: boolean`
- `interactive?: boolean`
- `maxSubagentDepth?: number`
- `completionGuard?: boolean`
- `toolBudget?: ToolBudgetConfig`
- `permissions?: PermissionRules`
- `memory?: AgentMemoryConfig`
- `disabled?: boolean`
- `extraFields?: Record<string, string>` (metadata only, not env)
- `override?: BuiltinAgentOverrideInfo`
- `modelSource?: AgentModelSourceInfo`

### B. Runtime `RuntimeAgentDefinition` (runtime-agent-registry.ts lines 18–51) — the strict
allow-listed create/update schema (the subset of AgentConfig accepted by `registerAgent`):
- `description: string`
- `systemPrompt: string`
- `aliases?: readonly string[]`
- `tools?: readonly string[]`
- `mcpDirectTools?: readonly string[]`
- `model?: string`
- `fallbackModels?: readonly string[]`
- `thinking?: string | false`
- `systemPromptMode?: "append" | "replace"`
- `inheritProjectContext?: boolean`
- `inheritSkills?: boolean`
- `defaultContext?: "fresh" | "fork"`
- `defaultAsync?: boolean`
- `defaultTimeoutMs?: number`
- `defaultToolTimeoutMs?: number`
- `defaultTurnBudget?: TurnBudgetConfig`
- `defaultAcceptance?: AcceptanceInput`
- `acceptanceRole?: "read-only" | "writer"`
- `runner?: AgentRunnerConfig`
- `skills?: readonly string[]`
- `skillPath?: readonly string[]`
- `extensions?: readonly string[]`
- `subagentOnlyExtensions?: readonly string[]`
- `output?: string`
- `outputMode?: "inline" | "file-only"`
- `defaultReads?: readonly string[]`
- `defaultProgress?: boolean`
- `interactive?: boolean`
- `maxSubagentDepth?: number`
- `completionGuard?: boolean`
- `toolBudget?: ToolBudgetConfig`
- `permissions?: PermissionRules`

Also `BuiltinAgentOverrideBase`/`BuiltinAgentOverrideConfig` (agents.ts lines 48–102) used for
builtin-agent overrides: same shape, no env field.

---

## Documentation check

`node_modules/pi-subagents/docs/`:
- `docs/agents.md` — no occurrence of "env" (grep returned no matches).
- `docs/configuration.md` — documents internal `PI_SUBAGENT_*` env vars (task delivery, wait-tool,
  command override, fs-retry caps, etc.) and the `config.json` keys. **None** allow per-agent env
  injection; they are library-internal plumbing knobs.

`/work/_inspect/pi/packages/coding-agent/docs/` exists but has **no `subagents.md`**. Docs present
are generic (extensions, rpc, sdk, settings, providers, etc.). No subagent config/env documentation
found there.

---

## Files Retrieved (evidence)

1. `node_modules/pi-subagents/src/agents/agents.ts` (lines 48–160) — `AgentConfig` + override config types; no env field.
2. `node_modules/pi-subagents/src/agents/runtime-agent-registry.ts` (lines 18–57, 202–243) — `RuntimeAgentDefinition`, allow-list validation rejecting env.
3. `node_modules/pi-subagents/src/shared/launch-contract.ts` (lines 82–130) — `LaunchBindingInput`, `projectLaunchBinding`; no env.
4. `node_modules/pi-subagents/src/runs/foreground/subagent-executor.ts` (lines 270–360) — `SubagentParamsLike`; no env.
5. `node_modules/pi-subagents/src/runs/foreground/execution.ts` (line 489) — `spawnEnv = { ...process.env, ...sharedEnv }`.
6. `node_modules/pi-subagents/src/runs/shared/pi-args.ts` (lines 678–863) — `buildPiArgs`; internal-only env plumbing.
7. `node_modules/pi-subagents/src/api/agents.ts` (lines 1–8) — exports `registerAgent` (wraps `registerRuntimeAgent`); no env.
8. `node_modules/pi-subagents/docs/agents.md`, `docs/configuration.md` — no per-agent env support.

## Residual Risks / Notes

- If the real need is to put an env var into the agent's process, the only supported route is to
  set it in the parent `process.env` before the subagent spawns (children inherit all of it).
  There is no scoped per-agent/per-run override.
- `extraFields` in `AgentConfig` might look like an escape hatch but is metadata only; it is not
  consulted when building the child env.
- Extension config file (`~/.pi/agent/extensions/subagent/config.json`) fields are validated
  (`extension/config.ts`) and none of them carry per-agent env injection.
