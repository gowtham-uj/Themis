/**
 * Typed HTTP client for the agenteval REST API (plan/api.md).
 *
 * Base URL is configurable via AGENTEVAL_API_URL (empty = same origin).
 * Every method maps 1:1 to a documented endpoint so the UI and tests share
 * one source of request shape truth.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Resolve the API base URL (no trailing slash). Empty string = same origin. */
export function getApiBaseUrl(
  env: { AGENTEVAL_API_URL?: string } = typeof process !== "undefined"
    ? process.env
    : {},
): string {
  const raw = env.AGENTEVAL_API_URL ?? "";
  return raw.replace(/\/+$/, "");
}

function joinUrl(base: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!base) return p;
  return `${base}${p}`;
}

/**
 * Unwrap a list response. The server returns envelope-wrapped objects
 * (e.g. `{ projects: [...] }`, `{ tasks: [...] }`, `{ runs: [...] }`); older mock
 * paths may return a bare array. Accept both so the client never crashes on a
 * real API round-trip: an object with a single array-typed value is unwrapped;
 * an array is returned as-is; anything else → [].
 */
function unwrapList(raw: unknown, expectedKey?: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (expectedKey !== undefined && Array.isArray(obj[expectedKey])) {
      return obj[expectedKey] as unknown[];
    }
    // Single array-valued property → that property is the list.
    const arrayVals = Object.values(obj).filter(Array.isArray);
    if (arrayVals.length === 1) return arrayVals[0] as unknown[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Shared types (API-facing; mirror plan/data-model.md + domain.ts)
// ---------------------------------------------------------------------------

export type AgentCategory =
  | "coding"
  | "research"
  | "general"
  | "browser"
  | "data"
  | "conversational";

export type RubricAxis = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
export type AppliesTo = "general" | "coding" | "both";

export interface Anchors {
  full: string;
  partial: string;
  none: string;
}

export interface Criterion {
  id: string;
  axis: RubricAxis;
  label: string;
  weight: number;
  critical?: boolean;
  appliesTo: AppliesTo;
  anchors: Anchors;
  checkId?: string;
}

export interface Rubric {
  criteria: Criterion[];
  checks?: unknown[];
  profile: string;
  version: number;
}

export type WorkspaceSpec =
  | { source: "git"; repo: string; ref?: string }
  | { source: "empty" };

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  taskSource?: { kind: string; params?: Record<string, unknown> };
  defaultAgentId?: string | null;
  defaultModel?: string | null;
  defaultProvider?: string | null;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface CreateProjectBody {
  name: string;
  slug: string;
  description?: string;
  taskSource?: { kind: string; params?: Record<string, unknown> };
  defaultAgentId?: string;
  defaultModel?: string;
  defaultProvider?: string;
  [key: string]: unknown;
}

export interface Task {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  workspace: WorkspaceSpec;
  rubric: Rubric;
  rubricVersion?: number;
  agentCategory: AgentCategory | string;
  profile?: string | null;
  tags?: string[] | null;
  sourceKind?: string | null;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface CreateTaskBody {
  name: string;
  prompt: string;
  workspace: WorkspaceSpec;
  rubric: Rubric | { criteria: Criterion[]; profile?: string; version?: number };
  /** When a form posts rubric as JSON string / object under this key. */
  rubric_json?: Rubric | string;
  agentCategory?: AgentCategory | string;
  profile?: string;
  tags?: string[];
  referenceSolution?: string;
  [key: string]: unknown;
}

export interface UpdateTaskBody {
  name?: string;
  prompt?: string;
  workspace?: WorkspaceSpec;
  rubric?: Rubric;
  rubric_json?: Rubric | string;
  agentCategory?: AgentCategory | string;
  profile?: string | null;
  tags?: string[] | null;
  [key: string]: unknown;
}

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "resuming"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout"
  | string;

export type ControlState =
  | "running"
  | "paused-soft"
  | "paused-hard"
  | "resuming"
  | "aborting"
  | "aborted"
  | "done"
  | "completed"
  | "failed"
  | "timeout"
  | string;

export interface Run {
  id: string;
  batchId?: string;
  taskId: string;
  projectId: string;
  agentId: string;
  model: string;
  provider?: string;
  status: RunStatus;
  controlState?: ControlState | null;
  repeatIndex?: number;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  eventsPath?: string | null;
  diffPath?: string | null;
  error?: string | null;
  pauseCount?: number;
  [key: string]: unknown;
}

export interface StartRunBody {
  taskId: string;
  agent: string;
  model: string;
  provider?: string;
  repeats?: number;
  params?: Record<string, unknown>;
  adapterOverrides?: Record<string, unknown>;
  autoJudge?: boolean;
  [key: string]: unknown;
}

export interface StartRunResponse {
  batchId?: string;
  runIds?: string[];
  runs?: Run[];
  /** Convenience: first run id when a single repeat. */
  id?: string;
  [key: string]: unknown;
}

export type PauseMode = "soft" | "hard";

export interface ApiErrorBody {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Client options / low-level request
// ---------------------------------------------------------------------------

export interface ApiClientOptions {
  /** Override base URL (else AGENTEVAL_API_URL / empty). */
  baseUrl?: string;
  /** Inject fetch (tests). Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** When true, return raw Response (for streams / text). */
  raw?: boolean;
}

function buildQuery(
  query?: Record<string, string | number | boolean | undefined | null>,
): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * Low-level JSON request helper used by every client method.
 * Throws {@link ApiError} on non-2xx responses.
 */
export async function apiRequest<T = unknown>(
  path: string,
  opts: RequestOptions & ApiClientOptions = {},
): Promise<T> {
  const base = opts.baseUrl !== undefined ? opts.baseUrl : getApiBaseUrl();
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const url = joinUrl(base, path) + buildQuery(opts.query);
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...opts.headers,
  };
  let body: string | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetchFn(url, { method, headers, body });
  if (opts.raw) {
    if (!res.ok) {
      let errBody: unknown;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text().catch(() => undefined);
      }
      throw new ApiError(
        res.status,
        `API ${method} ${path} failed: ${res.status}`,
        errBody,
      );
    }
    return res as unknown as T;
  }
  if (!res.ok) {
    let errBody: unknown;
    try {
      errBody = await res.json();
    } catch {
      errBody = await res.text().catch(() => undefined);
    }
    const detail =
      errBody &&
      typeof errBody === "object" &&
      errBody !== null &&
      "detail" in errBody
        ? String((errBody as ApiErrorBody).detail)
        : `API ${method} ${path} failed: ${res.status}`;
    throw new ApiError(res.status, detail, errBody);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** POST /api/projects */
export async function createProject(
  body: CreateProjectBody,
  opts: ApiClientOptions = {},
): Promise<Project> {
  const raw = await apiRequest<Record<string, unknown>>("/api/projects", {
    ...opts,
    method: "POST",
    body,
  });
  return normalizeProject(raw);
}

/** GET /api/projects */
export async function listProjects(
  opts: ApiClientOptions = {},
): Promise<Project[]> {
  const raw = await apiRequest<unknown>("/api/projects", {
    ...opts,
    method: "GET",
  });
  return unwrapList(raw, "projects").map((p) =>
    normalizeProject(p as Record<string, unknown>),
  );
}

/** GET /api/projects/:id */
export async function getProject(
  id: string,
  opts: ApiClientOptions = {},
): Promise<Project> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${encodeURIComponent(id)}`,
    {
      ...opts,
      method: "GET",
    },
  );
  return normalizeProject(raw);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** GET /api/projects/:id/tasks */
export async function listTasks(
  projectId: string,
  opts: ApiClientOptions & { includeArchived?: boolean } = {},
): Promise<Task[]> {
  const { includeArchived, ...client } = opts;
  const raw = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks`,
    {
      ...client,
      method: "GET",
      // Server reads snake_case include_archived (src/api/server.ts).
      query: includeArchived ? { include_archived: "1" } : undefined,
    },
  );
  return unwrapList(raw, "tasks").map((t) => normalizeTask(t as Record<string, unknown>));
}

/** POST /api/projects/:id/tasks — body is TaskSpec-shaped; rubric may be rubric_json. */
export async function createTask(
  projectId: string,
  body: CreateTaskBody,
  opts: ApiClientOptions = {},
): Promise<Task> {
  const payload = normalizeTaskBody(body);
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks`,
    { ...opts, method: "POST", body: payload },
  );
  return normalizeTask(raw);
}

/** PATCH /api/projects/:id/tasks/:taskId */
export async function updateTask(
  projectId: string,
  taskId: string,
  body: UpdateTaskBody,
  opts: ApiClientOptions = {},
): Promise<Task> {
  const payload = normalizeTaskBody(body);
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
    { ...opts, method: "PATCH", body: payload },
  );
  return normalizeTask(raw);
}

/** DELETE /api/projects/:id/tasks/:taskId (archive) */
export async function deleteTask(
  projectId: string,
  taskId: string,
  opts: ApiClientOptions = {},
): Promise<Task | void> {
  const raw = await apiRequest<Record<string, unknown> | undefined>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
    { ...opts, method: "DELETE" },
  );
  if (!raw) return;
  return normalizeTask(raw);
}

/** POST /api/projects/:id/tasks/sync */
export async function syncTasks(
  projectId: string,
  opts: ApiClientOptions = {},
): Promise<{ synced?: number; tasks?: Task[]; [key: string]: unknown }> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/sync`,
    { ...opts, method: "POST", body: {} },
  );
  const tasksRaw = raw?.tasks;
  return {
    ...raw,
    synced:
      (raw?.synced as number | undefined) ??
      (raw?.count as number | undefined),
    tasks: Array.isArray(tasksRaw)
      ? tasksRaw.map((t) => normalizeTask(t as Record<string, unknown>))
      : undefined,
  };
}

function normalizeTaskBody<T extends CreateTaskBody | UpdateTaskBody>(
  body: T,
): T {
  const out: Record<string, unknown> = { ...body };
  if (out.rubric_json !== undefined && out.rubric === undefined) {
    const rj = out.rubric_json;
    out.rubric =
      typeof rj === "string"
        ? (JSON.parse(rj) as Rubric)
        : (rj as Rubric);
  }
  return out as T;
}

/**
 * Normalize API JSON (snake_case per server serializers) into camelCase domain shapes
 * the UI components expect. Accepts already-camelCase payloads (tests / future).
 */
export function normalizeProject(raw: Record<string, unknown>): Project {
  return {
    ...raw,
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    slug: String(raw.slug ?? ""),
    description: (raw.description as string | null | undefined) ?? null,
    taskSource:
      (raw.taskSource as Project["taskSource"]) ??
      (raw.task_source as Project["taskSource"]),
    defaultAgentId:
      (raw.defaultAgentId as string | null | undefined) ??
      (raw.default_agent_id as string | null | undefined) ??
      null,
    defaultModel:
      (raw.defaultModel as string | null | undefined) ??
      (raw.default_model as string | null | undefined) ??
      null,
    defaultProvider:
      (raw.defaultProvider as string | null | undefined) ??
      (raw.default_provider as string | null | undefined) ??
      null,
    archived: Boolean(raw.archived),
    createdAt:
      (raw.createdAt as string | undefined) ??
      (raw.created_at as string | undefined),
    updatedAt:
      (raw.updatedAt as string | undefined) ??
      (raw.updated_at as string | undefined),
  };
}

export function normalizeTask(raw: Record<string, unknown>): Task {
  return {
    ...raw,
    id: String(raw.id ?? ""),
    projectId: String(
      raw.projectId ?? raw.project_id ?? "",
    ),
    name: String(raw.name ?? ""),
    prompt: String(raw.prompt ?? ""),
    workspace: (raw.workspace as WorkspaceSpec) ?? { source: "empty" },
    rubric: (raw.rubric as Rubric) ?? {
      version: 1,
      profile: "general",
      criteria: [],
    },
    rubricVersion:
      (raw.rubricVersion as number | undefined) ??
      (raw.rubric_version as number | undefined),
    agentCategory: String(
      raw.agentCategory ?? raw.agent_category ?? "coding",
    ),
    profile:
      (raw.profile as string | null | undefined) ?? null,
    tags: (raw.tags as string[] | null | undefined) ?? null,
    sourceKind:
      (raw.sourceKind as string | null | undefined) ??
      (raw.source_kind as string | null | undefined) ??
      null,
    archived: Boolean(raw.archived),
    createdAt:
      (raw.createdAt as string | undefined) ??
      (raw.created_at as string | undefined),
    updatedAt:
      (raw.updatedAt as string | undefined) ??
      (raw.updated_at as string | undefined),
  };
}

export function normalizeRun(raw: Record<string, unknown>): Run {
  return {
    ...raw,
    id: String(raw.id ?? ""),
    batchId:
      (raw.batchId as string | undefined) ??
      (raw.batch_id as string | undefined),
    taskId: String(raw.taskId ?? raw.task_id ?? ""),
    projectId: String(raw.projectId ?? raw.project_id ?? ""),
    agentId: String(raw.agentId ?? raw.agent_id ?? ""),
    model: String(raw.model ?? ""),
    provider:
      (raw.provider as string | undefined) ?? undefined,
    status: String(raw.status ?? "queued"),
    controlState:
      (raw.controlState as ControlState | null | undefined) ??
      (raw.control_state as ControlState | null | undefined) ??
      null,
    repeatIndex:
      (raw.repeatIndex as number | undefined) ??
      (raw.repeat_index as number | undefined),
    startedAt:
      (raw.startedAt as string | null | undefined) ??
      (raw.started_at as string | null | undefined) ??
      null,
    endedAt:
      (raw.endedAt as string | null | undefined) ??
      (raw.ended_at as string | null | undefined) ??
      null,
    durationMs:
      (raw.durationMs as number | null | undefined) ??
      (raw.duration_ms as number | null | undefined) ??
      null,
    eventsPath:
      (raw.eventsPath as string | null | undefined) ??
      (raw.events_path as string | null | undefined) ??
      null,
    diffPath:
      (raw.diffPath as string | null | undefined) ??
      (raw.diff_path as string | null | undefined) ??
      null,
    error: (raw.error as string | null | undefined) ?? null,
    pauseCount:
      (raw.pauseCount as number | undefined) ??
      (raw.pause_count as number | undefined),
  };
}

export function normalizeStartRunResponse(
  raw: Record<string, unknown>,
): StartRunResponse {
  const runIds =
    (raw.runIds as string[] | undefined) ??
    (raw.run_ids as string[] | undefined);
  const batchId =
    (raw.batchId as string | undefined) ??
    (raw.batch_id as string | undefined);
  const runsRaw = raw.runs as unknown;
  const runs = Array.isArray(runsRaw)
    ? runsRaw.map((r) => normalizeRun(r as Record<string, unknown>))
    : undefined;
  const id =
    (raw.id as string | undefined) ??
    runIds?.[0] ??
    runs?.[0]?.id;
  return {
    ...raw,
    batchId,
    runIds,
    runs,
    id,
  };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * POST /api/projects/:id/runs — start evals (202 + batch/run ids).
 */
export async function startRun(
  projectId: string,
  body: StartRunBody,
  opts: ApiClientOptions = {},
): Promise<StartRunResponse> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${encodeURIComponent(projectId)}/runs`,
    { ...opts, method: "POST", body },
  );
  return normalizeStartRunResponse(raw);
}

/** GET /api/runs/:id */
export async function getRun(
  runId: string,
  opts: ApiClientOptions = {},
): Promise<Run> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/runs/${encodeURIComponent(runId)}`,
    {
      ...opts,
      method: "GET",
    },
  );
  return normalizeRun(raw);
}

/** GET /api/projects/:id/runs — project-scoped list (falls back shape). */
export async function listRuns(
  projectId: string,
  opts: ApiClientOptions = {},
): Promise<Run[]> {
  const raw = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/runs`,
    { ...opts, method: "GET" },
  );
  return unwrapList(raw, "runs").map((r) => normalizeRun(r as Record<string, unknown>));
}

/** GET /api/runs/:id/diff — returns patch text. */
export async function getRunDiff(
  runId: string,
  opts: ApiClientOptions = {},
): Promise<string> {
  const base = opts.baseUrl !== undefined ? opts.baseUrl : getApiBaseUrl();
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const url = joinUrl(base, `/api/runs/${encodeURIComponent(runId)}/diff`);
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "text/plain, application/json", ...opts.headers },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `API GET /api/runs/${runId}/diff failed: ${res.status}`);
  }
  return res.text();
}

/**
 * Build the URL for a run's HTML verdict report.
 * Pass `download: true` to request Content-Disposition attachment.
 */
export function runReportUrl(
  runId: string,
  opts: { download?: boolean; baseUrl?: string } = {},
): string {
  const base = opts.baseUrl !== undefined ? opts.baseUrl : getApiBaseUrl();
  const path = `/api/runs/${encodeURIComponent(runId)}/report`;
  const query = opts.download ? { download: "1" } : undefined;
  return joinUrl(base, path) + buildQuery(query);
}

/** GET /api/runs/:id/report — returns self-contained report.html text. */
export async function getRunReport(
  runId: string,
  opts: ApiClientOptions = {},
): Promise<string> {
  const base = opts.baseUrl !== undefined ? opts.baseUrl : getApiBaseUrl();
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const url = runReportUrl(runId, { baseUrl: base });
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "text/html", ...opts.headers },
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `API GET /api/runs/${runId}/report failed: ${res.status}`,
    );
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// Run events — SSE URL + EventSource + fetch-stream reader
// ---------------------------------------------------------------------------

/**
 * Build the absolute (or origin-relative) URL for run event streaming.
 * Reconnect resume: pass `since` = last consumed seq.
 */
export function runEventsUrl(
  runId: string,
  opts: { since?: number; stream?: "ndjson" | "sse"; baseUrl?: string } = {},
): string {
  const base = opts.baseUrl !== undefined ? opts.baseUrl : getApiBaseUrl();
  const path = `/api/runs/${encodeURIComponent(runId)}/events`;
  const query: Record<string, string | number | undefined> = {};
  if (opts.since !== undefined && opts.since !== null) {
    query.since = opts.since;
  }
  if (opts.stream) query.stream = opts.stream;
  return joinUrl(base, path) + buildQuery(query);
}

/**
 * Open a browser EventSource for live run events.
 * Reconnect with `since` to resume from disk (plan/api.md Streaming).
 */
export function getRunEventsSSE(
  runId: string,
  since?: number,
  opts: { baseUrl?: string; EventSourceImpl?: typeof EventSource } = {},
): EventSource {
  const url = runEventsUrl(runId, { since, baseUrl: opts.baseUrl });
  const ES =
    opts.EventSourceImpl ??
    (typeof EventSource !== "undefined" ? EventSource : undefined);
  if (!ES) {
    throw new Error(
      "EventSource is not available in this environment; use getRunEventsStream instead",
    );
  }
  return new ES(url);
}

export interface StreamEvent {
  /** Parsed JSON payload (canonical event or control frame). */
  data: unknown;
  /** SSE event name when present. */
  event?: string;
  /** Raw data string. */
  raw: string;
}

/**
 * Fetch-based event stream reader for Node / tests / non-SSE clients.
 * Uses `?stream=ndjson` when available; also parses classic SSE `data:` lines.
 * Pass `since` to resume from the last sequence number.
 */
export async function* getRunEventsStream(
  runId: string,
  since?: number,
  opts: ApiClientOptions & { stream?: "ndjson" | "sse" } = {},
): AsyncGenerator<StreamEvent, void, undefined> {
  const base = opts.baseUrl !== undefined ? opts.baseUrl : getApiBaseUrl();
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const url = runEventsUrl(runId, {
    since,
    stream: opts.stream ?? "ndjson",
    baseUrl: base,
  });
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Accept: "text/event-stream, application/x-ndjson, application/json",
      ...opts.headers,
    },
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `API GET /api/runs/${runId}/events failed: ${res.status}`,
    );
  }
  if (!res.body) {
    // Fallback: whole body as text
    const text = await res.text();
    yield* parseEventText(text);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      const ev = parseEventLine(line);
      if (ev) yield ev;
    }
  }
  if (buffer.trim()) {
    const ev = parseEventLine(buffer);
    if (ev) yield ev;
  }
}

function* parseEventText(text: string): Generator<StreamEvent> {
  for (const line of text.split("\n")) {
    const ev = parseEventLine(line);
    if (ev) yield ev;
  }
}

function parseEventLine(line: string): StreamEvent | null {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed || trimmed.startsWith(":")) return null;
  if (trimmed.startsWith("data:")) {
    const raw = trimmed.slice(5).trimStart();
    if (!raw || raw === "[DONE]") return null;
    try {
      return { data: JSON.parse(raw), raw, event: "message" };
    } catch {
      return { data: raw, raw, event: "message" };
    }
  }
  // ndjson bare line
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { data: JSON.parse(trimmed), raw: trimmed };
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------

/** POST /api/runs/:id/pause?mode=soft|hard */
export async function pauseRun(
  runId: string,
  mode: PauseMode = "soft",
  opts: ApiClientOptions = {},
): Promise<Run> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/runs/${encodeURIComponent(runId)}/pause`,
    {
      ...opts,
      method: "POST",
      query: { mode },
    },
  );
  return normalizeRun(raw);
}

/** POST /api/runs/:id/resume */
export async function resumeRun(
  runId: string,
  opts: ApiClientOptions = {},
): Promise<Run> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/runs/${encodeURIComponent(runId)}/resume`,
    {
      ...opts,
      method: "POST",
    },
  );
  return normalizeRun(raw);
}

/** POST /api/runs/:id/abort */
export async function abortRun(
  runId: string,
  opts: ApiClientOptions = {},
): Promise<Run> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/runs/${encodeURIComponent(runId)}/abort`,
    {
      ...opts,
      method: "POST",
    },
  );
  return normalizeRun(raw);
}

/**
 * POST /api/runs/:id/control — live sandbox network cutoff.
 * Body: { action: "network", enabled: boolean }
 */
export function setNetwork(
  runId: string,
  enabled: boolean,
  opts: ApiClientOptions = {},
): Promise<unknown> {
  return apiRequest(`/api/runs/${encodeURIComponent(runId)}/control`, {
    ...opts,
    method: "POST",
    body: { action: "network", enabled },
  });
}

// ---------------------------------------------------------------------------
// Issues / Findings log (P6b)
// ---------------------------------------------------------------------------

/** Finding kind: defect / positive / meta (mirrors findings table). */
export type IssueKind = "defect" | "positive" | "meta" | string;

/** Lifecycle status of a de-duplicated finding fingerprint. */
export type IssueStatus =
  | "open"
  | "resolved"
  | "regressed"
  | "wontfix"
  | string;

/** Severity vocabulary used by the judge + issues log. */
export type IssueSeverity = "blocker" | "major" | "minor" | "nit" | string;

/** Structured evidence ref (same shape as judge verdict Ref). */
export type IssueRef =
  | { kind: "diff"; file: string; hunk: number; lines?: [number, number] }
  | { kind: "trace"; runId: string; seqs: [number, number] }
  | { kind: "tool"; toolCallId: string }
  | { kind: string; [key: string]: unknown };

/** Optional fix direction attached to a finding. */
export interface IssueFix {
  direction: string;
  repro?: { command: string; expected: string };
  [key: string]: unknown;
}

/** Recurrence summary returned alongside list + detail. */
export interface IssueRecurrence {
  firstSeenRunId?: string | null;
  lastSeenRunId?: string | null;
  count?: number;
}

/** Batch recurrence: k occurrences of this finding / n runs in the batch. */
export interface IssueBatchRecurrence {
  batchId: string;
  k: number;
  n: number;
}

/**
 * One row in the project issues log.
 * Mirrors FindingRow + a recurrence annotation from the list endpoint.
 */
export interface IssueListItem {
  fingerprint: string;
  taskId: string;
  projectId: string;
  category: string;
  kind: IssueKind;
  claim: string;
  latestSeverity: IssueSeverity | null;
  latestConfidence: number | null;
  firstSeenJudgement: string | null;
  lastSeenJudgement: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  occurrenceCount: number;
  resolvedAt: string | null;
  status: IssueStatus;
  recurrence?: IssueRecurrence;
  [key: string]: unknown;
}

/** One occurrence of a finding (decoded refs/fix for the client). */
export interface IssueOccurrence {
  id: string;
  findingFingerprint: string;
  judgementId: string;
  runId: string;
  severity: IssueSeverity | string;
  confidence: number;
  claim: string;
  criterion: string | null;
  /** Decoded from refsJson. */
  refs?: IssueRef[];
  refsJson?: string;
  /** Decoded from fixJson. */
  fix?: IssueFix | null;
  fixJson?: string | null;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

/** Detail payload for GET /api/projects/:id/findings/:fingerprint. */
export interface IssueDetail {
  finding: IssueListItem & { occurrences: IssueOccurrence[] };
  recurrence: IssueRecurrence;
  kByBatch: IssueBatchRecurrence[];
  [key: string]: unknown;
}

export interface ListIssuesOptions {
  status?: IssueStatus;
  category?: string;
  /** taskId filter (query key: task). */
  task?: string;
  kind?: IssueKind;
  severity?: IssueSeverity;
  limit?: number;
  cursor?: string | number;
}

/**
 * Build the URL for the project issues log.
 * Filters map 1:1 to the GET /api/projects/:id/findings query string.
 */
export function listIssuesUrl(
  projectId: string,
  opts: ListIssuesOptions & { baseUrl?: string } = {},
): string {
  const base = opts.baseUrl !== undefined ? opts.baseUrl : getApiBaseUrl();
  const path = `/api/projects/${encodeURIComponent(projectId)}/findings`;
  const query: Record<string, string | number | undefined> = {};
  if (opts.status) query.status = String(opts.status);
  if (opts.category) query.category = opts.category;
  if (opts.task) query.task = opts.task;
  if (opts.kind) query.kind = String(opts.kind);
  if (opts.severity) query.severity = String(opts.severity);
  if (opts.limit !== undefined && opts.limit !== null) query.limit = opts.limit;
  if (opts.cursor !== undefined && opts.cursor !== null) {
    query.cursor = opts.cursor;
  }
  return joinUrl(base, path) + buildQuery(query);
}

/**
 * Build the URL for a single finding's lifecycle detail.
 * Fingerprint is URL-encoded (sha256 hex is safe, but we encode defensively).
 */
export function runIssuesUrl(
  projectId: string,
  fingerprint: string,
  opts: { baseUrl?: string } = {},
): string {
  const base = opts.baseUrl !== undefined ? opts.baseUrl : getApiBaseUrl();
  const path = `/api/projects/${encodeURIComponent(projectId)}/findings/${encodeURIComponent(fingerprint)}`;
  return joinUrl(base, path);
}

/** Normalize a list-item row (tolerates snake_case + missing recurrence). */
export function normalizeIssueListItem(
  raw: Record<string, unknown>,
): IssueListItem {
  const recurrenceRaw =
    (raw.recurrence as Record<string, unknown> | undefined) ?? undefined;
  const recurrence: IssueRecurrence | undefined = recurrenceRaw
    ? {
        firstSeenRunId:
          (recurrenceRaw.firstSeenRunId as string | null | undefined) ??
          (recurrenceRaw.first_seen_run_id as string | null | undefined) ??
          null,
        lastSeenRunId:
          (recurrenceRaw.lastSeenRunId as string | null | undefined) ??
          (recurrenceRaw.last_seen_run_id as string | null | undefined) ??
          null,
        count:
          (recurrenceRaw.count as number | undefined) ??
          (raw.occurrenceCount as number | undefined) ??
          (raw.occurrence_count as number | undefined),
      }
    : undefined;

  return {
    ...raw,
    fingerprint: String(raw.fingerprint ?? ""),
    taskId: String(raw.taskId ?? raw.task_id ?? ""),
    projectId: String(raw.projectId ?? raw.project_id ?? ""),
    category: String(raw.category ?? ""),
    kind: String(raw.kind ?? "defect"),
    claim: String(raw.claim ?? ""),
    latestSeverity:
      ((raw.latestSeverity as string | null | undefined) ??
        (raw.latest_severity as string | null | undefined) ??
        null) as IssueSeverity | null,
    latestConfidence:
      (raw.latestConfidence as number | null | undefined) ??
      (raw.latest_confidence as number | null | undefined) ??
      null,
    firstSeenJudgement:
      (raw.firstSeenJudgement as string | null | undefined) ??
      (raw.first_seen_judgement as string | null | undefined) ??
      null,
    lastSeenJudgement:
      (raw.lastSeenJudgement as string | null | undefined) ??
      (raw.last_seen_judgement as string | null | undefined) ??
      null,
    firstSeenAt:
      (raw.firstSeenAt as string | null | undefined) ??
      (raw.first_seen_at as string | null | undefined) ??
      null,
    lastSeenAt:
      (raw.lastSeenAt as string | null | undefined) ??
      (raw.last_seen_at as string | null | undefined) ??
      null,
    occurrenceCount: Number(
      raw.occurrenceCount ?? raw.occurrence_count ?? 0,
    ),
    resolvedAt:
      (raw.resolvedAt as string | null | undefined) ??
      (raw.resolved_at as string | null | undefined) ??
      null,
    status: String(raw.status ?? "open"),
    recurrence,
  };
}

/** Parse refsJson / fixJson if the server left them as strings. */
function decodeJsonField<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/** Normalize a detail occurrence (decode refs/fix). */
export function normalizeIssueOccurrence(
  raw: Record<string, unknown>,
): IssueOccurrence {
  const refsJson =
    (raw.refsJson as string | undefined) ??
    (raw.refs_json as string | undefined);
  const fixJson =
    (raw.fixJson as string | null | undefined) ??
    (raw.fix_json as string | null | undefined) ??
    null;
  const refs =
    (raw.refs as IssueRef[] | undefined) ??
    decodeJsonField<IssueRef[]>(refsJson, []);
  const fix =
    (raw.fix as IssueFix | null | undefined) ??
    (fixJson ? decodeJsonField<IssueFix | null>(fixJson, null) : null);

  return {
    ...raw,
    id: String(raw.id ?? ""),
    findingFingerprint: String(
      raw.findingFingerprint ?? raw.finding_fingerprint ?? "",
    ),
    judgementId: String(raw.judgementId ?? raw.judgement_id ?? ""),
    runId: String(raw.runId ?? raw.run_id ?? ""),
    severity: String(raw.severity ?? "nit"),
    confidence: Number(raw.confidence ?? 0),
    claim: String(raw.claim ?? ""),
    criterion:
      (raw.criterion as string | null | undefined) ?? null,
    refs,
    refsJson,
    fix,
    fixJson,
    status: String(raw.status ?? "introduced"),
    createdAt: String(
      raw.createdAt ?? raw.created_at ?? "",
    ),
  };
}

/** Normalize the issue detail envelope. */
export function normalizeIssueDetail(
  raw: Record<string, unknown>,
): IssueDetail {
  const findingRaw =
    (raw.finding as Record<string, unknown> | undefined) ?? raw;
  const occurrencesRaw =
    (findingRaw.occurrences as unknown[]) ??
    (raw.occurrences as unknown[]) ??
    [];
  const base = normalizeIssueListItem(findingRaw);
  const occurrences = Array.isArray(occurrencesRaw)
    ? occurrencesRaw.map((o) =>
        normalizeIssueOccurrence(o as Record<string, unknown>),
      )
    : [];

  const recurrenceRaw =
    (raw.recurrence as Record<string, unknown> | undefined) ??
    (base.recurrence as Record<string, unknown> | undefined) ??
    {};
  const recurrence: IssueRecurrence = {
    firstSeenRunId:
      (recurrenceRaw.firstSeenRunId as string | null | undefined) ??
      (recurrenceRaw.first_seen_run_id as string | null | undefined) ??
      null,
    lastSeenRunId:
      (recurrenceRaw.lastSeenRunId as string | null | undefined) ??
      (recurrenceRaw.last_seen_run_id as string | null | undefined) ??
      null,
    count:
      (recurrenceRaw.count as number | undefined) ??
      base.occurrenceCount,
  };

  const kByBatchRaw = (raw.kByBatch as unknown[]) ?? (raw.k_by_batch as unknown[]) ?? [];
  const kByBatch: IssueBatchRecurrence[] = Array.isArray(kByBatchRaw)
    ? kByBatchRaw.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          batchId: String(r.batchId ?? r.batch_id ?? ""),
          k: Number(r.k ?? 0),
          n: Number(r.n ?? 0),
        };
      })
    : [];

  return {
    ...raw,
    finding: { ...base, occurrences },
    recurrence,
    kByBatch,
  };
}

/**
 * GET /api/projects/:id/findings — project issues log.
 * Unwraps the `{ findings: [...] }` envelope via {@link unwrapList}.
 */
export async function listIssues(
  projectId: string,
  opts: ApiClientOptions & ListIssuesOptions = {},
): Promise<IssueListItem[]> {
  const {
    status,
    category,
    task,
    kind,
    severity,
    limit,
    cursor,
    ...client
  } = opts;
  const path = `/api/projects/${encodeURIComponent(projectId)}/findings`;
  const query: Record<string, string | number | boolean | undefined | null> = {};
  if (status) query.status = String(status);
  if (category) query.category = category;
  if (task) query.task = task;
  if (kind) query.kind = String(kind);
  if (severity) query.severity = String(severity);
  if (limit !== undefined && limit !== null) query.limit = limit;
  if (cursor !== undefined && cursor !== null) query.cursor = cursor;

  const raw = await apiRequest<unknown>(path, {
    ...client,
    method: "GET",
    query,
  });
  return unwrapList(raw, "findings").map((row) =>
    normalizeIssueListItem(row as Record<string, unknown>),
  );
}

/**
 * GET /api/projects/:id/findings/:fingerprint — lifecycle detail
 * (occurrences + k/N by batch + recurrence).
 */
export async function getIssue(
  projectId: string,
  fingerprint: string,
  opts: ApiClientOptions = {},
): Promise<IssueDetail> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${encodeURIComponent(projectId)}/findings/${encodeURIComponent(fingerprint)}`,
    { ...opts, method: "GET" },
  );
  return normalizeIssueDetail(raw);
}

/** Bundle of client methods for DI into components/tests. */
export function createApiClient(opts: ApiClientOptions = {}) {
  return {
    createProject: (body: CreateProjectBody) => createProject(body, opts),
    listProjects: () => listProjects(opts),
    getProject: (id: string) => getProject(id, opts),
    listTasks: (projectId: string, o?: { includeArchived?: boolean }) =>
      listTasks(projectId, { ...opts, ...o }),
    createTask: (projectId: string, body: CreateTaskBody) =>
      createTask(projectId, body, opts),
    updateTask: (projectId: string, taskId: string, body: UpdateTaskBody) =>
      updateTask(projectId, taskId, body, opts),
    deleteTask: (projectId: string, taskId: string) =>
      deleteTask(projectId, taskId, opts),
    syncTasks: (projectId: string) => syncTasks(projectId, opts),
    startRun: (projectId: string, body: StartRunBody) =>
      startRun(projectId, body, opts),
    getRun: (runId: string) => getRun(runId, opts),
    listRuns: (projectId: string) => listRuns(projectId, opts),
    getRunDiff: (runId: string) => getRunDiff(runId, opts),
    getRunReport: (runId: string) => getRunReport(runId, opts),
    runReportUrl: (runId: string, o?: { download?: boolean }) =>
      runReportUrl(runId, { ...o, baseUrl: opts.baseUrl }),
    runEventsUrl: (runId: string, since?: number) =>
      runEventsUrl(runId, { since, baseUrl: opts.baseUrl }),
    getRunEventsSSE: (runId: string, since?: number) =>
      getRunEventsSSE(runId, since, { baseUrl: opts.baseUrl }),
    getRunEventsStream: (runId: string, since?: number) =>
      getRunEventsStream(runId, since, opts),
    pauseRun: (runId: string, mode?: PauseMode) => pauseRun(runId, mode, opts),
    resumeRun: (runId: string) => resumeRun(runId, opts),
    abortRun: (runId: string) => abortRun(runId, opts),
    setNetwork: (runId: string, enabled: boolean) =>
      setNetwork(runId, enabled, opts),
    listIssues: (projectId: string, o?: ListIssuesOptions) =>
      listIssues(projectId, { ...opts, ...o }),
    getIssue: (projectId: string, fingerprint: string) =>
      getIssue(projectId, fingerprint, opts),
    listIssuesUrl: (projectId: string, o?: ListIssuesOptions) =>
      listIssuesUrl(projectId, { ...o, baseUrl: opts.baseUrl }),
    runIssuesUrl: (projectId: string, fingerprint: string) =>
      runIssuesUrl(projectId, fingerprint, { baseUrl: opts.baseUrl }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
