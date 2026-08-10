/** Declarative project adapter for a real CLI agent. */

import type { ProjectAgentAdapter } from "../db/queries.js";
import { validateCanonicalEvent, type CanonicalEvent } from "../schema/events.js";
import { linesFromStream, parseJsonlLine } from "../schema/jsonl.js";
import { piAdapter } from "./pi.js";
import { reaperCodeAdapter } from "./reapercode.js";
import type {
  Adapter,
  AdapterCommand,
  AgentStreams,
  RunContext,
} from "./types.js";

const TEMPLATE = /\{\{([^{}]+)\}\}/g;

/** Probe prompt used when an adapter derives its connection check from `command`. */
export const PROBE_PROMPT =
  "Reply with exactly AGENTEVAL_CONNECTION_OK. Do not use tools.";

/** Build the common Adapter interface from a persisted CLI adapter definition. */
export function createDeclarativeAdapter(definition: ProjectAgentAdapter): Adapter {
  return {
    id: definition.agentId,
    image(ctx) {
      return renderTemplate(definition.image, ctx);
    },
    connectionCheck(ctx) {
      // When the adapter derives its connection check from `command`, render the
      // command template against a probe context (prompt overridden) instead of
      // a hand-written probe block.
      if (definition.connectionCheckDerived) {
        const probeCtx: RunContext = {
          ...ctx,
          task: { ...ctx.task, prompt: PROBE_PROMPT },
        };
        const probeCommand = renderCommand(
          definition.command,
          probeCtx,
          definition.providerConfig,
        );
        return {
          command: probeCommand,
          cwd: definition.command.cwd ?? "/workspace",
          timeoutMs: definition.command.timeoutMs ?? 60_000,
        };
      }
      return {
        command: renderCommand(definition.connectionCheck, ctx, definition.providerConfig),
        ...(definition.connectionCheck.cwd
          ? { cwd: renderTemplate(definition.connectionCheck.cwd, ctx) }
          : {}),
        ...(definition.connectionCheck.timeoutMs
          ? { timeoutMs: definition.connectionCheck.timeoutMs }
          : {}),
      };
    },
    command(ctx) {
      return renderCommand(definition.command, ctx, definition.providerConfig);
    },
    evidence() {
      return {
        paths: [...definition.evidence.paths],
        ...(definition.evidence.requiredPaths
          ? { requiredPaths: [...definition.evidence.requiredPaths] }
          : {}),
      };
    },
    parse(streams, ctx) {
      switch (definition.parserKind) {
        case "pi-jsonl":
          return piAdapter.parse(streams, ctx);
        case "reapercode-jsonl":
          return reaperCodeAdapter.parse(streams, ctx);
        case "canonical-jsonl":
          return parseCanonicalJsonl(streams, ctx);
        default:
          throw new Error(
            `unsupported parser kind ${definition.parserKind} for adapter ${definition.agentId}`,
          );
      }
    },
  };
}

function renderCommand(
  template: ProjectAgentAdapter["command"],
  ctx: RunContext,
  providerConfig: Record<string, unknown> | null,
): AdapterCommand {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(template.env ?? {})) {
    env[name] = renderTemplate(value, ctx);
  }
  const credentialEnv = providerConfig?.credentialEnv;
  if (credentialEnv && typeof credentialEnv === "object" && !Array.isArray(credentialEnv)) {
    const byProvider = credentialEnv as Record<string, unknown>;
    const selected = byProvider[ctx.provider] ?? byProvider.default;
    if (selected && typeof selected === "object" && !Array.isArray(selected)) {
      for (const [targetName, sourceName] of Object.entries(
        selected as Record<string, unknown>,
      )) {
        if (typeof sourceName === "string" && ctx.apiKeys[sourceName]) {
          env[targetName] = ctx.apiKeys[sourceName]!;
        }
      }
    }
  }
  // Project overrides are explicit runtime configuration and win over adapter defaults.
  Object.assign(env, ctx.overrides?.env ?? {});
  return {
    argv: template.argv.map((value) => renderTemplate(value, ctx)),
    env,
  };
}

/** Render one adapter-format placeholder string against the real run context. */
export function renderTemplate(value: string, ctx: RunContext): string {
  return value.replace(TEMPLATE, (_full, rawKey: string) => {
    const key = rawKey.trim();
    if (key === "prompt") return ctx.task.prompt;
    if (key === "model") return ctx.model;
    if (key === "provider") return ctx.provider;
    if (key === "workspace") return "/workspace";
    if (key === "run_id") return ctx.runId;
    if (key === "project_id") return ctx.project.id;
    if (key.startsWith("credential:")) {
      return ctx.apiKeys[key.slice("credential:".length)] ?? "";
    }
    if (key.startsWith("param:")) {
      const found = readPath(ctx.params, key.slice("param:".length));
      return found === undefined || found === null
        ? ""
        : typeof found === "string"
          ? found
          : JSON.stringify(found);
    }
    if (key.startsWith("override_env:")) {
      return ctx.overrides?.env?.[key.slice("override_env:".length)] ?? "";
    }
    throw new Error(`unknown adapter template placeholder: {{${key}}}`);
  });
}

function readPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

async function* parseCanonicalJsonl(
  streams: AgentStreams,
  ctx: RunContext,
): AsyncIterable<CanonicalEvent> {
  for await (const line of linesFromStream(streams.stdout)) {
    if (!line.trim()) continue;
    const parsed = parseJsonlLine(line);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`adapter ${ctx.runId} emitted invalid canonical JSONL`);
    }
    const event = validateCanonicalEvent(parsed);
    yield event.runId === ctx.runId ? event : { ...event, runId: ctx.runId };
  }
}
