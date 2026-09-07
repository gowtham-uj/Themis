/**
 * One chronological account of what a run is actually doing, across all stages.
 *
 * The eval feed tails only the agent container of whichever eval is live, so it
 * goes quiet the moment the courtroom takes over and it says nothing at all
 * about Phase 2. This module reads the durable trace each stage leaves on disk
 * and merges it into one ordered stream: eval seals, per-case Phase-1 node
 * commits, what the courtroom orchestrator is doing turn by turn, which
 * investigator seats it dispatched and how they came back, and the same detail
 * for the Phase-2 board. Every entry names its stage, its eval, and its node.
 */
import {open, readFile, readdir, stat} from "node:fs/promises";
import {join} from "node:path";
import type {PipelineEventRow, PipelineItemRow} from "../db/phase2/contracts.js";
import {PHASE1_NODES, PHASE1_NODE_LABELS} from "./stage-progress.js";

export type ActivityStage = "evals" | "phase1" | "phase2";

export interface RunActivityEntry {
  /** Sort key and display time, ISO-8601 UTC. */
  ts: string;
  stage: ActivityStage;
  /** Which graph node produced this, when one did. */
  node: string | null;
  /** Short kind the console styles on: sealed, node, round, dispatch, seat, filed, read, note, verdict. */
  kind: string;
  /** One sentence of plain language. */
  text: string;
  /** Longer detail the console can reveal on demand. */
  detail: string | null;
  evalName: string | null;
  evalId: string | null;
  runId: string | null;
  tone: "info" | "ok" | "warn" | "danger";
}

/** Newest bytes of a file, without loading a multi-gigabyte log into memory. */
async function tailBytes(path: string, max: number): Promise<string> {
  let fh;
  try { fh = await open(path, "r"); } catch { return ""; }
  try {
    const size = (await fh.stat()).size;
    const start = size > max ? size - max : 0;
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // A mid-line start would parse as garbage, so drop the partial first line.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    await fh.close();
  }
}

async function mtime(path: string): Promise<string | null> {
  try { return (await stat(path)).mtime.toISOString(); } catch { return null; }
}

async function listDir(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort(); } catch { return []; }
}

/** Plain name for a document the court committed under judge/. */
function docName(name: string): string {
  const base = name.replace(/\.(ya?ml|md|json)$/i, "");
  const known: Record<string, string> = {
    "evalJudge": "the verdict",
    "minos-report": "the Minos ruling",
    "kratos-report": "the Kratos trajectory report",
    "logos-report": "the Logos artifact report",
    "round-log": "the round log",
    "tangent-log": "the tangent log",
    "case-summary": "the case summary",
    "developer-brief": "the developer brief",
    "clerkReport": "the clerk report",
  };
  return known[base] ?? base;
}

/** The assignment code an orchestrator stamps on the first line of a brief. */
function assignmentCode(task: string): string | null {
  const m = /ASSIGNMENT\s+([A-Z0-9-]+)/.exec(task);
  return m ? m[1]! : null;
}

function firstSentence(text: string, cap = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

interface PiEvent {
  type?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: {content?: Array<{text?: string}>; isError?: boolean};
  isError?: boolean;
  message?: {timestamp?: number; role?: string};
  reason?: string;
}

/**
 * What a courtroom or board orchestrator did, from the tail of its PI stream.
 * Only tool activity becomes an entry. Token-level message updates are noise at
 * this altitude and there are thousands of them per round.
 */
async function piActivity(input: {
  workDir: string;
  stage: ActivityStage;
  node: string | null;
  evalName: string | null;
  evalId: string | null;
  runId: string | null;
}): Promise<RunActivityEntry[]> {
  const raw = await tailBytes(join(input.workDir, "pi-stdout.jsonl"), 768 * 1024);
  if (!raw.trim()) return [];
  const out: RunActivityEntry[] = [];
  let lastTs = Date.now();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: PiEvent;
    try { ev = JSON.parse(line) as PiEvent; } catch { continue; }
    if (typeof ev.message?.timestamp === "number") lastTs = ev.message.timestamp;
    const ts = new Date(lastTs).toISOString();
    const base = {
      ts, stage: input.stage, node: input.node,
      evalName: input.evalName, evalId: input.evalId, runId: input.runId,
    };

    if (ev.type === "compaction_start") {
      out.push({...base, kind: "note", tone: "info", detail: null,
        text: `the orchestrator context filled up and was compacted.`});
      continue;
    }
    if (ev.type === "agent_end") {
      out.push({...base, kind: "note", tone: "ok", detail: null,
        text: `the orchestrator finished and closed the case.`});
      continue;
    }
    if (ev.type !== "tool_execution_start" && ev.type !== "tool_execution_end") continue;

    const args = (ev.args ?? {}) as Record<string, unknown>;
    const str = (k: string): string => (typeof args[k] === "string" ? args[k] as string : "");

    if (ev.type === "tool_execution_start") {
      switch (ev.toolName) {
        case "subagent": {
          const agent = str("agent") || "an investigator";
          const task = str("task");
          const code = assignmentCode(task);
          out.push({...base, kind: "dispatch", tone: "info",
            text: `dispatched ${agent}${code ? ` on assignment ${code}` : ""}.`,
            detail: firstSentence(task, 600)});
          break;
        }
        case "write_to_yaml_template": {
          const tpl = str("template") || "a court document";
          out.push({...base, kind: "filed", tone: "ok", detail: null,
            text: `filed ${docName(tpl)}.`});
          break;
        }
        case "read_evidence": {
          const path = str("path") || "the archive";
          out.push({...base, kind: "read", tone: "info", detail: null,
            text: `read evidence ${path}.`});
          break;
        }
        case "channel": {
          const msg = str("message");
          out.push({...base, kind: "note", tone: "info", detail: firstSentence(msg, 900),
            text: `posted to the case channel: ${firstSentence(msg, 140)}`});
          break;
        }
        case "petition":
        case "grant": {
          out.push({...base, kind: "note", tone: "warn", detail: firstSentence(JSON.stringify(args), 400),
            text: `${ev.toolName === "petition" ? "petitioned for" : "granted"} access.`});
          break;
        }
        default:
          break;
      }
      continue;
    }

    // A failed tool call is the most useful thing in this whole stream.
    const failed = ev.isError === true || ev.result?.isError === true;
    if (failed) {
      const text = ev.result?.content?.[0]?.text ?? "";
      out.push({...base, kind: "error", tone: "warn", detail: firstSentence(text, 600),
        text: `${ev.toolName ?? "a tool"} was refused: ${firstSentence(text, 120)}`});
    }
  }
  return out;
}

/** Every investigator seat this orchestrator ran, from its artifact metadata. */
async function seatActivity(input: {
  workDir: string;
  stage: ActivityStage;
  node: string | null;
  evalName: string | null;
  evalId: string | null;
  runId: string | null;
}): Promise<RunActivityEntry[]> {
  const dir = join(input.workDir, "sessions", "subagent-artifacts");
  const out: RunActivityEntry[] = [];
  for (const name of await listDir(dir)) {
    if (!name.endsWith("_meta.json")) continue;
    let meta: {agent?: string; exitCode?: number; durationMs?: number; timestamp?: number;
      usage?: {turns?: number; input?: number; output?: number}; model?: string};
    try { meta = JSON.parse(await readFile(join(dir, name), "utf8")); } catch { continue; }
    const ts = meta.timestamp ? new Date(meta.timestamp).toISOString() : await mtime(join(dir, name));
    if (!ts) continue;
    const agent = meta.agent ?? "an investigator";
    const ok = meta.exitCode === 0;
    const turns = meta.usage?.turns;
    const secs = meta.durationMs ? Math.round(meta.durationMs / 1000) : null;
    out.push({
      ts, stage: input.stage, node: input.node,
      evalName: input.evalName, evalId: input.evalId, runId: input.runId,
      kind: "seat", tone: ok ? "ok" : "warn",
      text: `${agent} ${ok ? "reported back" : "came back failed"}`
        + `${turns ? ` after ${turns} turns` : ""}${secs !== null ? ` in ${secs}s` : ""}.`,
      detail: meta.model ? `model ${meta.model}` : null,
    });
  }
  return out;
}

interface EvalEvent {
  ts?: string;
  type?: string;
  turn?: number;
  name?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  /** Text for some adapters, a decoded object for others. */
  output?: unknown;
  durationMs?: number;
  text?: string;
  status?: string;
  level?: string;
  message?: string;
  totalTokens?: number;
}

/** First line of a tool result, which is where a failure says what went wrong. */
function resultGist(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  // Adapters report a result as plain text, as a JSON string, or as an already
  // decoded object. Normalize all three to the one field a reader wants: the
  // message that says what went wrong.
  let value: unknown = output;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (!text.startsWith("{") && !text.startsWith("[")) return firstSentence(text, 400);
    try { value = JSON.parse(text); } catch { return firstSentence(text, 400); }
  }
  if (typeof value !== "object" || value === null) return firstSentence(String(value), 400);
  const o = value as {message?: unknown; stderr?: unknown; stdout?: unknown; error?: unknown; exitCode?: unknown};
  for (const field of [o.message, o.stderr, o.error, o.stdout]) {
    if (typeof field === "string" && field.trim()) return firstSentence(field.trim(), 400);
  }
  if (typeof o.exitCode === "number") return `exit ${o.exitCode}`;
  return null;
}

/** Plain sentence for one tool the agent called, named by what it touched. */
function toolText(name: string, args: Record<string, unknown>): {what: string; detail: string | null} {
  const str = (k: string): string => (typeof args[k] === "string" ? args[k] as string : "");
  const cmd = str("cmd") || str("command");
  const file = str("path") || str("file_path") || str("filePath");
  switch (name) {
    case "bash":
    case "shell":
      return {what: `ran \`${firstSentence(cmd, 110)}\``, detail: str("description") || null};
    case "read_file":
    case "read":
    case "view_file":
    case "file_view":
      return {what: `read ${file || "a file"}`, detail: null};
    case "write_file":
    case "write":
      return {what: `wrote ${file || "a file"}`, detail: null};
    case "replace_in_file":
    case "edit":
    case "str_replace":
      return {what: `edited ${file || "a file"}`, detail: null};
    case "list_files":
    case "list_directory":
    case "glob":
    case "grep":
    case "search":
      return {what: `listed ${file || "the workspace"}`, detail: cmd || null};
    default:
      return {what: `used ${name}`, detail: file || cmd || null};
  }
}

/**
 * What the agent is doing inside the container right now.
 *
 * The eval stage used to report one line per eval, at seal. An eval runs for
 * up to 45 minutes, so the card sat empty for the whole thing and then said
 * "sealed". The canonical events.jsonl is written continuously by the adapter,
 * so read it directly: every tool call becomes one line naming the command or
 * file, failures carry the error text, and the run ends with its own outcome.
 * Token-level message deltas are skipped; there are thousands per eval.
 */
async function evalActivity(
  dataDir: string, item: PipelineItemRow, evalName: string, projectId: string,
): Promise<RunActivityEntry[]> {
  if (!item.runId) return [];
  // While the eval runs the trace sits at the archive root; sealing moves it
  // under eval_lifecycle_logs/. Read whichever exists so a finished eval keeps
  // its account instead of collapsing back to a single "sealed" line.
  const base = join(dataDir, "projects", projectId, "evals", item.runId);
  const live = await tailBytes(join(base, "events.jsonl"), 512 * 1024);
  const raw = live.trim()
    ? live
    : await tailBytes(join(base, "eval_lifecycle_logs", "events.jsonl"), 512 * 1024);
  if (!raw.trim()) return [];
  const ctx = {evalName, evalId: item.evalId, runId: item.runId, stage: "evals" as const, node: null};
  const out: RunActivityEntry[] = [];
  const pending = new Map<string, string>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: EvalEvent;
    try { ev = JSON.parse(line) as EvalEvent; } catch { continue; }
    if (!ev.ts) continue;
    const base = {...ctx, ts: ev.ts};
    const turn = ev.turn ? ` (turn ${ev.turn})` : "";

    switch (ev.type) {
      case "run.start":
        out.push({...base, kind: "note", tone: "info", detail: null,
          text: "the agent started in its container."});
        break;
      case "tool.call": {
        const {what, detail} = toolText(ev.name ?? "a tool", ev.args ?? {});
        const id = typeof (ev as {id?: unknown}).id === "string" ? (ev as {id: string}).id : null;
        if (id) pending.set(id, what);
        out.push({...base, kind: "tool", tone: "info", detail,
          text: `${what}${turn}.`});
        break;
      }
      case "tool.result": {
        // A successful call is already reported by its tool.call line. Only a
        // failure adds information, and it is the most useful line in the feed.
        if (!ev.isError) break;
        const id = typeof (ev as {id?: unknown}).id === "string" ? (ev as {id: string}).id : null;
        const what = (id && pending.get(id)) ?? `${ev.name ?? "a tool"} call`;
        out.push({...base, kind: "error", tone: "warn", detail: resultGist(ev.output),
          text: `${what} failed.`});
        break;
      }
      case "thinking":
        if (!ev.text?.trim()) break;
        out.push({...base, kind: "note", tone: "info", detail: firstSentence(ev.text, 600),
          text: firstSentence(ev.text, 150)});
        break;
      case "run.end": {
        const ok = ev.status === "completed";
        const secs = ev.durationMs ? Math.round(ev.durationMs / 1000) : null;
        out.push({...base, kind: "note", tone: ok ? "ok" : "warn", detail: null,
          text: `the agent ${ok ? "finished" : `stopped (${ev.status ?? "unknown"})`}`
            + `${secs !== null ? ` after ${secs}s` : ""}.`});
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Everything one Phase-1 case did: graph nodes, court documents, courtroom work. */
async function phase1Activity(
  dataDir: string, item: PipelineItemRow, evalName: string,
): Promise<RunActivityEntry[]> {
  if (!item.runId) return [];
  const workDir = join(dataDir, "judge_work", `case_${item.runId}`);
  const ctx = {evalName, evalId: item.evalId, runId: item.runId};
  const out: RunActivityEntry[] = [];

  for (const node of PHASE1_NODES) {
    const ts = await mtime(join(workDir, "checkpoints", `${node}.json`));
    if (!ts) continue;
    out.push({...ctx, ts, stage: "phase1", node, kind: "node", tone: "ok", detail: null,
      text: `${PHASE1_NODE_LABELS[node].toLowerCase()} committed.`});
    if (node !== "node4") continue;
    try {
      const cp = JSON.parse(await readFile(join(workDir, "checkpoints", "node4.json"), "utf8")) as {round?: number};
      if (typeof cp.round === "number") {
        out.push({...ctx, ts, stage: "phase1", node: "node4", kind: "round", tone: "info", detail: null,
          text: `the courtroom reached round ${cp.round}.`});
      }
    } catch { /* a half-written checkpoint is not worth reporting */ }
  }

  for (const name of await listDir(join(workDir, "node4", "judge"))) {
    const ts = await mtime(join(workDir, "node4", "judge", name));
    if (!ts) continue;
    out.push({...ctx, ts, stage: "phase1", node: "node4", kind: "filed",
      tone: name.startsWith("evalJudge") ? "ok" : "info", detail: null,
      text: `the court committed ${docName(name)}.`});
  }

  const node4 = {workDir: join(workDir, "node4"), stage: "phase1" as const, node: "node4", ...ctx};
  out.push(...await piActivity(node4), ...await seatActivity(node4));
  return out;
}

/** Everything the Phase-2 board did, from its platform work dir and artifacts. */
async function phase2Activity(dataDir: string, campaignId: string): Promise<RunActivityEntry[]> {
  const ctx = {evalName: null, evalId: null, runId: null};
  const out: RunActivityEntry[] = [];
  for (const name of await listDir(join(dataDir, "phase2_artifacts", campaignId))) {
    const ts = await mtime(join(dataDir, "phase2_artifacts", campaignId, name));
    if (!ts) continue;
    out.push({...ctx, ts, stage: "phase2", node: null, kind: "filed", tone: "ok", detail: null,
      text: `Looking across evals: the board produced ${name}.`});
  }
  const workDir = join(dataDir, "platform", "phase2", campaignId);
  for (const name of await listDir(join(workDir, "judge"))) {
    const ts = await mtime(join(workDir, "judge", name));
    if (!ts) continue;
    out.push({...ctx, ts, stage: "phase2", node: null, kind: "filed", tone: "info", detail: null,
      text: `Looking across evals: the board filed ${docName(name)}.`});
  }
  const board = {workDir, stage: "phase2" as const, node: null, ...ctx};
  out.push(...await piActivity(board), ...await seatActivity(board));
  return out;
}

/** Plain sentence for one durable pipeline event row. */
function eventEntry(row: PipelineEventRow, evalName: string): Omit<RunActivityEntry, "evalId" | "runId" | "evalName"> | null {
  const base = {ts: row.createdAt, detail: null, node: null};
  switch (row.eventType) {
    case "archive.sealed":
      return {...base, stage: "evals", kind: "sealed", tone: "ok",
        text: "the agent finished and its evidence archive sealed."};
    case "phase1.result_published":
      return {...base, stage: "phase1", node: "node4", kind: "verdict", tone: "ok",
        text: "the verdict published and judge/ was resealed into the archive."};
    case "phase1.retry":
      return {...base, stage: "phase1", kind: "error", tone: "warn",
        text: "Phase 1 failed and is being retried."};
    case "phase1.resume":
      return {...base, stage: "phase1", kind: "note", tone: "warn",
        text: "the judge session was resumed after a worker loss."};
    default:
      return null;
  }
}

/** Merge every stage's durable trace into one ordered account of the run. */
export async function runActivity(input: {
  dataDir: string;
  projectId: string;
  items: readonly PipelineItemRow[];
  events: readonly PipelineEventRow[];
  campaignId: string | null;
  evalNames: Readonly<Record<string, string>>;
  limit?: number;
}): Promise<RunActivityEntry[]> {
  const nameOf = (evalId: string | null | undefined): string =>
    (evalId && input.evalNames[evalId]) || "An eval";
  const out: RunActivityEntry[] = [];

  const byItem = new Map(input.items.map((x) => [x.id, x]));
  for (const row of input.events) {
    const item = row.itemId ? byItem.get(row.itemId) : undefined;
    const entry = eventEntry(row, nameOf(item?.evalId));
    if (entry) {
      out.push({...entry, evalName: item ? nameOf(item.evalId) : null,
        evalId: item?.evalId ?? null, runId: item?.runId ?? null});
    }
  }

  // One unreadable case must not blank the whole run's account. Report what
  // broke as an entry in the feed and keep every other stage's trace.
  const failed = async (
    what: string, evalId: string | null, runId: string | null, err: unknown,
  ): Promise<RunActivityEntry> => ({
    ts: new Date().toISOString(), stage: "evals", node: null, kind: "error", tone: "warn",
    text: `The console could not read ${what}.`,
    detail: err instanceof Error ? err.message : String(err),
    evalName: evalId ? nameOf(evalId) : null, evalId, runId,
  });

  const perCase = await Promise.all(
    input.items.map(async (item) => {
      const name = nameOf(item.evalId);
      try {
        return [
          ...await evalActivity(input.dataDir, item, name, input.projectId),
          ...await phase1Activity(input.dataDir, item, name),
        ];
      } catch (err) {
        return [await failed(`the trace for ${name}`, item.evalId, item.runId, err)];
      }
    }),
  );
  for (const list of perCase) out.push(...list);
  if (input.campaignId) {
    try {
      out.push(...await phase2Activity(input.dataDir, input.campaignId));
    } catch (err) {
      out.push(await failed("the across-evals board trace", null, null, err));
    }
  }

  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const limit = input.limit ?? 300;
  return out.length > limit ? out.slice(out.length - limit) : out;
}
