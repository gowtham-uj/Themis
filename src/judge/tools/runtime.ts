/**
 * Execute mediated judge tools by name (Node 4 tool loop).
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  buildEvidenceCatalog,
  readEvidence,
  type EvidenceCatalogItem,
} from "./evidence.js";
import { PetitionLog } from "./petition.js";
import { ScratchpadStore } from "./scratchpad.js";

/** Walk a directory into `{path, bytes}` relative paths (bounded, text files). */
export async function listCatalogPaths(root: string): Promise<Array<{ path: string; bytes: number }>> {
  const out: Array<{ path: string; bytes: number }> = [];
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else if (s.isFile()) out.push({ path: relative(root, p).replace(/\\/g, "/"), bytes: s.size });
    }
  }
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ToolRuntimeContext {
  archiveRoot: string;
  catalog: Map<string, EvidenceCatalogItem>;
  scratchpads: ScratchpadStore;
  petitions: PetitionLog;
  caseId: string;
  agentId: string;
}

export const JUDGE_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "evidence_read",
      description: "Read a bounded byte range from a catalogued archive file by catalog id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["catalogId"],
        properties: {
          catalogId: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          length: { type: "integer", minimum: 0, maximum: 65536 },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "scratchpad_append",
      description: "Append an immutable chunk to the calling agent's scratchpad.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: { body: { type: "string" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "scratchpad_read",
      description: "Read another agent's scratchpad after they complete (denied while in progress).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["ownerId"],
        properties: { ownerId: { type: "string" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "petition",
      description: "Petition for additional evidence or a dispatch.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "target", "suspicion", "idempotencyKey"],
        properties: {
          kind: { type: "string", enum: ["evidence", "dispatch"] },
          target: { type: "string" },
          suspicion: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
    },
  },
];

/** Dispatch one tool call and return JSON string result for the model. */
export async function executeJudgeTool(
  ctx: ToolRuntimeContext,
  name: string,
  argsJson: string,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: "invalid JSON arguments" });
  }
  try {
    switch (name) {
      case "evidence_read": {
        const got = await readEvidence(ctx.archiveRoot, ctx.catalog, {
          catalogId: String(args.catalogId ?? ""),
          offset: typeof args.offset === "number" ? args.offset : 0,
          length: typeof args.length === "number" ? args.length : 4096,
        });
        return JSON.stringify(got);
      }
      case "scratchpad_append": {
        ctx.scratchpads.open(ctx.agentId);
        const chunk = ctx.scratchpads.append(ctx.agentId, String(args.body ?? ""));
        return JSON.stringify({ sequence: chunk.sequence, sha256: chunk.sha256 });
      }
      case "scratchpad_read": {
        const chunks = ctx.scratchpads.read(String(args.ownerId ?? ""), ctx.agentId);
        return JSON.stringify({ chunks });
      }
      case "petition": {
        const { event, created } = ctx.petitions.petition({
          caseId: ctx.caseId,
          fromAgentId: ctx.agentId,
          kind: args.kind === "dispatch" ? "dispatch" : "evidence",
          target: String(args.target ?? ""),
          suspicion: String(args.suspicion ?? ""),
          idempotencyKey: String(args.idempotencyKey ?? ""),
        });
        return JSON.stringify({ created, event });
      }
      default:
        return JSON.stringify({ error: `unknown tool ${name}` });
    }
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      code: (err as { code?: string }).code,
    });
  }
}

export { buildEvidenceCatalog };
