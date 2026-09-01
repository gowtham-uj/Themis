/** API-facing Phase-2 PI control: durable work dir, status, resume. */
import {readdir, readFile, stat} from "node:fs/promises";
import {join} from "node:path";
import type {PiConnection} from "../pi/runtime.js";
import {runPhase2PiCampaign, type Phase2PiResult} from "./phase2-pi.js";
import type {Phase2Case, Phase2Pattern} from "./types.js";

export function phase2PlatformDir(dataDir: string, campaignId: string): string {
  return join(dataDir, "platform", "phase2", campaignId);
}

const inFlight = new Map<string, Promise<Phase2PiResult>>();

export interface Phase2PiStatus {
  campaignId: string;
  workDir: string;
  exists: boolean;
  resumable: boolean;
  running: boolean;
  filed: string[];
  subagents: Array<{ agent: string; exitCode: number | null; turns: number | null; file: string }>;
  session: string | null;
}

export async function getPhase2PiStatus(dataDir: string, campaignId: string): Promise<Phase2PiStatus> {
  const workDir = phase2PlatformDir(dataDir, campaignId);
  const filed: string[] = [];
  let exists = false;
  try {
    const names = await readdir(join(workDir, "judge"));
    exists = true;
    filed.push(...names.filter((n) => n.endsWith(".yaml")).sort());
  } catch { /* no judge yet */ }
  let session: string | null = null;
  try {
    const jsonl = (await readdir(join(workDir, "sessions"))).filter((n) => n.endsWith(".jsonl")).sort();
    if (jsonl.length) session = jsonl[jsonl.length - 1]!;
    exists = true;
  } catch { /* no sessions */ }
  const subagents: Phase2PiStatus["subagents"] = [];
  try {
    const art = join(workDir, "sessions", "subagent-artifacts");
    for (const name of await readdir(art)) {
      if (!name.endsWith("_meta.json")) continue;
      try {
        const meta = JSON.parse(await readFile(join(art, name), "utf8")) as {
          agent?: string; exitCode?: number; usage?: { turns?: number };
        };
        subagents.push({
          agent: String(meta.agent ?? name),
          exitCode: typeof meta.exitCode === "number" ? meta.exitCode : null,
          turns: meta.usage?.turns ?? null,
          file: name,
        });
      } catch { /* ignore corrupt meta */ }
    }
  } catch { /* none */ }
  return {
    campaignId,
    workDir,
    exists,
    resumable: session !== null,
    running: inFlight.has(campaignId),
    filed,
    subagents,
    session,
  };
}

/** Resume or continue the durable PI session for this campaign. */
export async function resumePhase2Pi(input: {
  dataDir: string;
  campaignId: string;
  projectId: string;
  connection: PiConnection;
  platformFaults?: string[];
}): Promise<{ started: boolean; running: boolean }> {
  const workDir = phase2PlatformDir(input.dataDir, input.campaignId);
  if (inFlight.has(input.campaignId)) return { started: false, running: true };
  let cases: Phase2Case[] = [];
  let patterns: Phase2Pattern[] = [];
  let viewDirs: Record<string, string> = {};
  try {
    cases = JSON.parse(await readFile(join(workDir, "campaign", "cases.json"), "utf8")) as Phase2Case[];
    patterns = JSON.parse(await readFile(join(workDir, "campaign", "patterns.json"), "utf8")) as Phase2Pattern[];
    viewDirs = JSON.parse(await readFile(join(workDir, "campaign", "views.json"), "utf8")) as Record<string, string>;
  } catch {
    throw new Error("Phase 2 campaign snapshot missing — run Phase 2 once before resume");
  }
  const task = runPhase2PiCampaign({
    connection: input.connection,
    campaignId: input.campaignId,
    projectId: input.projectId,
    cases,
    patterns,
    viewDirs,
    platformFaults: input.platformFaults ?? [],
    workDir,
  }).finally(() => { inFlight.delete(input.campaignId); });
  inFlight.set(input.campaignId, task);
  return { started: true, running: true };
}

export async function pausePhase2Pi(dataDir: string, campaignId: string): Promise<{ killed: boolean; pid: number | null }> {
  const { pausePiWorkDir } = await import("../pi/runtime.js");
  return pausePiWorkDir(phase2PlatformDir(dataDir, campaignId));
}

export function phase2PiInFlight(campaignId: string): boolean {
  return inFlight.has(campaignId);
}

export async function waitPhase2Pi(campaignId: string): Promise<Phase2PiResult | null> {
  return (await inFlight.get(campaignId)) ?? null;
}
