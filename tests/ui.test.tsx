/**
 * @vitest-environment jsdom
 *
 * P3c-UI tests: typed API client (mocked fetch), toolbar pure logic,
 * RunControlToolbar interaction, TasksList presentational render.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortRun,
  ApiError,
  createProject,
  createTask,
  deleteTask,
  getApiBaseUrl,
  getProject,
  getRun,
  getRunDiff,
  getRunReport,
  getRunEventsSSE,
  getRunEventsStream,
  listProjects,
  listRuns,
  listTasks,
  pauseRun,
  resumeRun,
  runEventsUrl,
  runReportUrl,
  setNetwork,
  startRun,
  syncTasks,
  updateTask,
  type Task,
} from "../src/ui/lib/api.ts";
import {
  getToolbarViewModel,
  showResultsSoFarBanner,
  TERMINAL_CONTROL_STATES,
} from "../src/ui/lib/toolbar-state.ts";
import { RunControlToolbar } from "../src/ui/components/RunControlToolbar.tsx";
import { TasksList } from "../src/ui/components/TasksList.tsx";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

type FetchCall = {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
};

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown;
      if (init?.body) {
        try {
          body = JSON.parse(String(init.body));
        } catch {
          body = init.body;
        }
      }
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
      }
      return handler({ url, method, body, headers });
    },
  );
  return fetchMock as unknown as typeof globalThis.fetch & {
    mock: { calls: unknown[] };
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getApiBaseUrl / URL helpers
// ---------------------------------------------------------------------------

describe("getApiBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(getApiBaseUrl({ AGENTEVAL_API_URL: "http://localhost:4000/" })).toBe(
      "http://localhost:4000",
    );
  });

  it("returns empty string when unset (same-origin)", () => {
    expect(getApiBaseUrl({})).toBe("");
  });
});

describe("runEventsUrl", () => {
  it("includes since query when provided", () => {
    const url = runEventsUrl("run-1", {
      since: 42,
      baseUrl: "http://api.test",
    });
    expect(url).toBe("http://api.test/api/runs/run-1/events?since=42");
  });

  it("omits since when undefined", () => {
    const url = runEventsUrl("run-1", { baseUrl: "" });
    expect(url).toBe("/api/runs/run-1/events");
  });

  it("encodes run id", () => {
    const url = runEventsUrl("a/b", { baseUrl: "" });
    expect(url).toContain(encodeURIComponent("a/b"));
  });
});

// ---------------------------------------------------------------------------
// API client — projects / tasks / runs / control
// ---------------------------------------------------------------------------

describe("api client (mocked fetch)", () => {
  const base = { baseUrl: "http://api.test" };

  it("createProject POSTs /api/projects with body", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("POST");
      expect(c.url).toBe("http://api.test/api/projects");
      expect(c.body).toEqual({ name: "Demo", slug: "demo" });
      expect(c.headers["content-type"]).toBe("application/json");
      return jsonResponse({ id: "p1", name: "Demo", slug: "demo" }, 201);
    });
    const p = await createProject(
      { name: "Demo", slug: "demo" },
      { ...base, fetch: fetchFn },
    );
    expect(p.id).toBe("p1");
  });

  it("listProjects GETs /api/projects", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("GET");
      expect(c.url).toBe("http://api.test/api/projects");
      return jsonResponse([{ id: "p1", name: "A", slug: "a" }]);
    });
    const list = await listProjects({ ...base, fetch: fetchFn });
    expect(list).toHaveLength(1);
  });

  it("getProject GETs /api/projects/:id", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.url).toBe("http://api.test/api/projects/p1");
      return jsonResponse({ id: "p1", name: "A", slug: "a" });
    });
    const p = await getProject("p1", { ...base, fetch: fetchFn });
    expect(p.slug).toBe("a");
  });

  it("listTasks GETs project tasks; include_archived as query (server snake_case)", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("GET");
      expect(c.url).toBe(
        "http://api.test/api/projects/p1/tasks?include_archived=1",
      );
      return jsonResponse({ tasks: [] });
    });
    const list = await listTasks("p1", {
      ...base,
      fetch: fetchFn,
      includeArchived: true,
    });
    expect(list).toEqual([]);
  });

  // Regression: the real API server wraps list responses in envelopes
  // ({projects:[...]}/{tasks:[...]}/{runs:[...]}). The client must unwrap, not
  // call .map on the object — otherwise the UI crashes against the real API.
  it("listProjects/listTasks/listRuns unwrap envelope-wrapped responses", async () => {
    const fp = mockFetch(() => jsonResponse({ projects: [{ id: "p1", name: "A", slug: "a" }] }));
    expect(await listProjects({ ...base, fetch: fp })).toHaveLength(1);

    const ft = mockFetch(() =>
      jsonResponse({ tasks: [{ id: "t1", name: "T", prompt: "p", rubricVersion: 1 }] }),
    );
    expect(await listTasks("p1", { ...base, fetch: ft })).toHaveLength(1);

    const fr = mockFetch(() =>
      jsonResponse({ runs: [{ id: "r1", status: "completed", controlState: "completed" }] }),
    );
    expect(await listRuns("p1", { ...base, fetch: fr })).toHaveLength(1);
  });

  // Tolerance: a bare-array response (older/mock servers) still works.
  it("list accessors tolerate a bare-array response", async () => {
    const fp = mockFetch(() => jsonResponse([{ id: "p1", name: "A", slug: "a" }]));
    expect(await listProjects({ ...base, fetch: fp })).toHaveLength(1);
  });

  it("createTask POSTs TaskSpec; promotes rubric_json → rubric", async () => {
    const rubric = {
      version: 1,
      profile: "bugfix",
      criteria: [
        {
          id: "A1",
          axis: "A" as const,
          label: "ok",
          weight: 1,
          appliesTo: "both" as const,
          anchors: { full: "f", partial: "p", none: "n" },
        },
      ],
    };
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("POST");
      expect(c.url).toBe("http://api.test/api/projects/p1/tasks");
      expect(c.body).toMatchObject({
        name: "t",
        prompt: "do it",
        workspace: { source: "empty" },
        rubric,
      });
      return jsonResponse({
        id: "t1",
        projectId: "p1",
        name: "t",
        prompt: "do it",
        workspace: { source: "empty" },
        rubric,
        agentCategory: "coding",
      });
    });
    await createTask(
      "p1",
      {
        name: "t",
        prompt: "do it",
        workspace: { source: "empty" },
        rubric_json: rubric,
      },
      { ...base, fetch: fetchFn },
    );
  });

  it("updateTask PATCHes /api/projects/:id/tasks/:taskId", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("PATCH");
      expect(c.url).toBe("http://api.test/api/projects/p1/tasks/t1");
      expect(c.body).toEqual({ name: "renamed" });
      return jsonResponse({
        id: "t1",
        projectId: "p1",
        name: "renamed",
        prompt: "x",
        workspace: { source: "empty" },
        rubric: { version: 1, profile: "general", criteria: [] },
        agentCategory: "coding",
      });
    });
    const t = await updateTask(
      "p1",
      "t1",
      { name: "renamed" },
      { ...base, fetch: fetchFn },
    );
    expect(t.name).toBe("renamed");
  });

  it("deleteTask DELETEs task (archive)", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("DELETE");
      expect(c.url).toBe("http://api.test/api/projects/p1/tasks/t1");
      return jsonResponse({ id: "t1", archived: true });
    });
    await deleteTask("p1", "t1", { ...base, fetch: fetchFn });
  });

  it("syncTasks POSTs /api/projects/:id/tasks/sync", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("POST");
      expect(c.url).toBe("http://api.test/api/projects/p1/tasks/sync");
      return jsonResponse({ synced: 2 });
    });
    const r = await syncTasks("p1", { ...base, fetch: fetchFn });
    expect(r.synced).toBe(2);
  });

  it("startRun POSTs /api/projects/:id/runs with config body", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("POST");
      expect(c.url).toBe("http://api.test/api/projects/p1/runs");
      expect(c.body).toEqual({
        taskId: "t1",
        agent: "pi",
        model: "m",
        provider: "anthropic",
        repeats: 2,
        params: { timeoutMs: 1000 },
      });
      return jsonResponse(
        { batchId: "b1", runIds: ["r1", "r2"] },
        202,
      );
    });
    const res = await startRun(
      "p1",
      {
        taskId: "t1",
        agent: "pi",
        model: "m",
        provider: "anthropic",
        repeats: 2,
        params: { timeoutMs: 1000 },
      },
      { ...base, fetch: fetchFn },
    );
    expect(res.runIds).toEqual(["r1", "r2"]);
  });

  it("getRun GETs /api/runs/:id", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.url).toBe("http://api.test/api/runs/r1");
      return jsonResponse({
        id: "r1",
        taskId: "t1",
        projectId: "p1",
        agentId: "pi",
        model: "m",
        status: "running",
        controlState: "running",
      });
    });
    const r = await getRun("r1", { ...base, fetch: fetchFn });
    expect(r.controlState).toBe("running");
  });

  it("listRuns GETs /api/projects/:id/runs", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.url).toBe("http://api.test/api/projects/p1/runs");
      return jsonResponse([]);
    });
    await listRuns("p1", { ...base, fetch: fetchFn });
  });

  it("getRunDiff GETs /api/runs/:id/diff as text", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("GET");
      expect(c.url).toBe("http://api.test/api/runs/r1/diff");
      return textResponse("diff --git a/x b/x\n+hello\n");
    });
    const patch = await getRunDiff("r1", { ...base, fetch: fetchFn });
    expect(patch).toContain("+hello");
  });

  it("runReportUrl builds GET /api/runs/:id/report (?download=1)", () => {
    expect(runReportUrl("r1", { baseUrl: "http://api.test" })).toBe(
      "http://api.test/api/runs/r1/report",
    );
    expect(
      runReportUrl("r1", { baseUrl: "http://api.test", download: true }),
    ).toBe("http://api.test/api/runs/r1/report?download=1");
    expect(runReportUrl("a/b", { baseUrl: "" })).toBe(
      `/api/runs/${encodeURIComponent("a/b")}/report`,
    );
  });

  it("getRunReport GETs /api/runs/:id/report as html text", async () => {
    const html = "<!doctype html><html><body>report</body></html>";
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("GET");
      expect(c.url).toBe("http://api.test/api/runs/r1/report");
      expect(c.headers.accept).toBe("text/html");
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });
    const body = await getRunReport("r1", { ...base, fetch: fetchFn });
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("report");
  });

  it("getRunReport throws ApiError on !ok", async () => {
    const fetchFn = mockFetch(() =>
      new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      getRunReport("missing", { ...base, fetch: fetchFn }),
    ).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });

  it("pauseRun POSTs /api/runs/:id/pause?mode=", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("POST");
      expect(c.url).toBe("http://api.test/api/runs/r1/pause?mode=hard");
      return jsonResponse({
        id: "r1",
        taskId: "t",
        projectId: "p",
        agentId: "pi",
        model: "m",
        status: "paused",
        controlState: "paused-hard",
      });
    });
    const r = await pauseRun("r1", "hard", { ...base, fetch: fetchFn });
    expect(r.controlState).toBe("paused-hard");
  });

  it("resumeRun POSTs /api/runs/:id/resume", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("POST");
      expect(c.url).toBe("http://api.test/api/runs/r1/resume");
      return jsonResponse({
        id: "r1",
        taskId: "t",
        projectId: "p",
        agentId: "pi",
        model: "m",
        status: "running",
        controlState: "running",
      });
    });
    await resumeRun("r1", { ...base, fetch: fetchFn });
  });

  it("abortRun POSTs /api/runs/:id/abort", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("POST");
      expect(c.url).toBe("http://api.test/api/runs/r1/abort");
      return jsonResponse({
        id: "r1",
        taskId: "t",
        projectId: "p",
        agentId: "pi",
        model: "m",
        status: "aborted",
        controlState: "aborted",
      });
    });
    await abortRun("r1", { ...base, fetch: fetchFn });
  });

  it("setNetwork POSTs /control with action network", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("POST");
      expect(c.url).toBe("http://api.test/api/runs/r1/control");
      expect(c.body).toEqual({ action: "network", enabled: false });
      return jsonResponse({ ok: true });
    });
    await setNetwork("r1", false, { ...base, fetch: fetchFn });
  });

  it("throws ApiError on non-2xx", async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse(
        { type: "about:blank", title: "Not Found", status: 404, detail: "nope" },
        404,
      ),
    );
    await expect(
      getRun("missing", { ...base, fetch: fetchFn }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      getRun("missing", { ...base, fetch: fetchFn }),
    ).rejects.toMatchObject({ status: 404, message: "nope" });
  });

  it("normalizes snake_case run + startRun envelopes from the server", async () => {
    const fetchRun = mockFetch(() =>
      jsonResponse({
        id: "r1",
        batch_id: "b1",
        task_id: "t1",
        project_id: "p1",
        agent_id: "pi",
        model: "m",
        status: "running",
        control_state: "paused-soft",
        pause_count: 2,
      }),
    );
    const run = await getRun("r1", { ...base, fetch: fetchRun });
    expect(run.controlState).toBe("paused-soft");
    expect(run.taskId).toBe("t1");
    expect(run.projectId).toBe("p1");
    expect(run.pauseCount).toBe(2);

    const fetchStart = mockFetch(() =>
      jsonResponse(
        {
          batch_id: "b9",
          run_ids: ["r9a", "r9b"],
          runs: [
            {
              id: "r9a",
              task_id: "t1",
              project_id: "p1",
              agent_id: "pi",
              model: "m",
              status: "queued",
              control_state: "running",
            },
          ],
          status: "accepted",
        },
        202,
      ),
    );
    const started = await startRun(
      "p1",
      { taskId: "t1", agent: "pi", model: "m" },
      { ...base, fetch: fetchStart },
    );
    expect(started.batchId).toBe("b9");
    expect(started.runIds).toEqual(["r9a", "r9b"]);
    expect(started.id).toBe("r9a");
    expect(started.runs?.[0]?.taskId).toBe("t1");
  });
});

// ---------------------------------------------------------------------------
// SSE / stream resume with since=
// ---------------------------------------------------------------------------

describe("getRunEventsStream / SSE since resume", () => {
  it("passes since= to events URL for resume", async () => {
    const lines = [
      JSON.stringify({ type: "message", seq: 5, text: "hi", turn: 1 }),
      JSON.stringify({ type: "run.end", seq: 6, status: "completed" }),
    ];
    const fetchFn = mockFetch((c) => {
      expect(c.url).toBe(
        "http://api.test/api/runs/r1/events?since=4&stream=ndjson",
      );
      return new Response(lines.join("\n") + "\n", {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    });
    const got: unknown[] = [];
    for await (const frame of getRunEventsStream("r1", 4, {
      baseUrl: "http://api.test",
      fetch: fetchFn,
    })) {
      got.push(frame.data);
    }
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ seq: 5 });
  });

  it("parses classic SSE data: lines", async () => {
    const body = [
      "data: {\"type\":\"thinking\",\"seq\":1,\"text\":\"...\",\"turn\":0}",
      "",
      "data: {\"type\":\"message\",\"seq\":2,\"text\":\"hi\",\"turn\":0}",
      "",
    ].join("\n");
    const fetchFn = mockFetch((c) => {
      expect(c.url).toContain("stream=ndjson");
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const got: unknown[] = [];
    for await (const frame of getRunEventsStream("r9", undefined, {
      baseUrl: "http://api.test",
      fetch: fetchFn,
    })) {
      got.push(frame.data);
    }
    expect(got).toHaveLength(2);
  });

  it("getRunEventsSSE constructs EventSource with since", () => {
    const constructed: string[] = [];
    class FakeES {
      url: string;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      constructor(url: string) {
        this.url = url;
        constructed.push(url);
      }
      addEventListener() {}
      close() {}
    }
    const es = getRunEventsSSE("run-xyz", 17, {
      baseUrl: "http://api.test",
      EventSourceImpl: FakeES as unknown as typeof EventSource,
    });
    expect(constructed[0]).toBe(
      "http://api.test/api/runs/run-xyz/events?since=17",
    );
    expect(es).toBeInstanceOf(FakeES);
  });
});

// ---------------------------------------------------------------------------
// Toolbar pure state machine
// ---------------------------------------------------------------------------

describe("getToolbarViewModel", () => {
  it("running: pause+abort enabled, resume disabled", () => {
    const vm = getToolbarViewModel({
      status: "running",
      controlState: "running",
    });
    expect(vm.isTerminal).toBe(false);
    expect(vm.isPaused).toBe(false);
    expect(vm.pauseSoft.disabled).toBe(false);
    expect(vm.pauseHard.disabled).toBe(false);
    expect(vm.resume.disabled).toBe(true);
    expect(vm.abort.disabled).toBe(false);
    expect(vm.network.disabled).toBe(false);
  });

  it("paused-soft: resume enabled, pause disabled", () => {
    const vm = getToolbarViewModel({
      status: "paused",
      controlState: "paused-soft",
    });
    expect(vm.isPaused).toBe(true);
    expect(vm.pauseSoft.disabled).toBe(true);
    expect(vm.resume.disabled).toBe(false);
    expect(vm.abort.disabled).toBe(false);
  });

  it("paused-hard: same as soft for button enablement", () => {
    const vm = getToolbarViewModel({
      status: "paused",
      controlState: "paused-hard",
    });
    expect(vm.resume.disabled).toBe(false);
    expect(vm.pauseSoft.disabled).toBe(true);
  });

  it("terminal states disable pause/resume/abort/network", () => {
    for (const control of TERMINAL_CONTROL_STATES) {
      if (control === "aborting") continue; // handled separately
      const vm = getToolbarViewModel({
        status: control === "done" ? "completed" : control,
        controlState: control,
      });
      expect(vm.isTerminal, control).toBe(true);
      expect(vm.pauseSoft.disabled, control).toBe(true);
      expect(vm.resume.disabled, control).toBe(true);
      expect(vm.abort.disabled, control).toBe(true);
      expect(vm.network.disabled, control).toBe(true);
    }
  });

  it("completed status alone is terminal even without control_state", () => {
    const vm = getToolbarViewModel({ status: "completed" });
    expect(vm.isTerminal).toBe(true);
    expect(vm.abort.disabled).toBe(true);
  });

  it("busy disables all actions", () => {
    const vm = getToolbarViewModel({
      status: "running",
      controlState: "running",
      busy: true,
    });
    expect(vm.pauseSoft.disabled).toBe(true);
    expect(vm.abort.disabled).toBe(true);
  });

  it("network label reflects enabled flag", () => {
    expect(
      getToolbarViewModel({
        status: "running",
        controlState: "running",
        networkEnabled: true,
      }).network.label,
    ).toContain("on");
    expect(
      getToolbarViewModel({
        status: "running",
        controlState: "running",
        networkEnabled: false,
      }).network.label,
    ).toContain("off");
  });

  it("showResultsSoFarBanner for running/paused/aborted", () => {
    expect(
      showResultsSoFarBanner({ status: "running", controlState: "running" }),
    ).toBe(true);
    expect(
      showResultsSoFarBanner({
        status: "paused",
        controlState: "paused-soft",
      }),
    ).toBe(true);
    expect(
      showResultsSoFarBanner({ status: "aborted", controlState: "aborted" }),
    ).toBe(true);
    expect(
      showResultsSoFarBanner({
        status: "completed",
        controlState: "completed",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RunControlToolbar component
// ---------------------------------------------------------------------------

describe("RunControlToolbar", () => {
  it("renders control buttons", () => {
    render(
      <RunControlToolbar
        runId="r1"
        status="running"
        controlState="running"
        api={{
          pauseRun: vi.fn(),
          resumeRun: vi.fn(),
          abortRun: vi.fn(),
          setNetwork: vi.fn(),
        }}
      />,
    );
    expect(screen.getByTestId("btn-pause")).toBeTruthy();
    expect(screen.getByTestId("btn-resume")).toBeTruthy();
    expect(screen.getByTestId("btn-abort")).toBeTruthy();
    expect(screen.getByTestId("btn-network")).toBeTruthy();
  });

  it("disables pause/resume on terminal completed run", () => {
    render(
      <RunControlToolbar
        runId="r1"
        status="completed"
        controlState="done"
      />,
    );
    expect(
      (screen.getByTestId("btn-pause") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("btn-resume") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("btn-abort") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("calls pauseRun with selected mode on click", async () => {
    const pauseRunFn = vi.fn().mockResolvedValue({});
    render(
      <RunControlToolbar
        runId="r1"
        status="running"
        controlState="running"
        api={{
          pauseRun: pauseRunFn,
          resumeRun: vi.fn(),
          abortRun: vi.fn(),
          setNetwork: vi.fn(),
        }}
      />,
    );
    fireEvent.change(screen.getByTestId("pause-mode"), {
      target: { value: "hard" },
    });
    fireEvent.click(screen.getByTestId("btn-pause"));
    await waitFor(() => {
      expect(pauseRunFn).toHaveBeenCalledWith("r1", "hard");
    });
  });

  it("calls resumeRun when paused", async () => {
    const resumeRunFn = vi.fn().mockResolvedValue({});
    render(
      <RunControlToolbar
        runId="r1"
        status="paused"
        controlState="paused-soft"
        api={{
          pauseRun: vi.fn(),
          resumeRun: resumeRunFn,
          abortRun: vi.fn(),
          setNetwork: vi.fn(),
        }}
      />,
    );
    expect(
      (screen.getByTestId("btn-resume") as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByTestId("btn-resume"));
    await waitFor(() => {
      expect(resumeRunFn).toHaveBeenCalledWith("r1");
    });
  });

  it("calls abortRun on abort click", async () => {
    const abortRunFn = vi.fn().mockResolvedValue({});
    render(
      <RunControlToolbar
        runId="r1"
        status="running"
        controlState="running"
        api={{
          pauseRun: vi.fn(),
          resumeRun: vi.fn(),
          abortRun: abortRunFn,
          setNetwork: vi.fn(),
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("btn-abort"));
    await waitFor(() => {
      expect(abortRunFn).toHaveBeenCalledWith("r1");
    });
  });

  it("toggles network via setNetwork", async () => {
    const setNetworkFn = vi.fn().mockResolvedValue({});
    render(
      <RunControlToolbar
        runId="r1"
        status="running"
        controlState="running"
        networkEnabled={true}
        api={{
          pauseRun: vi.fn(),
          resumeRun: vi.fn(),
          abortRun: vi.fn(),
          setNetwork: setNetworkFn,
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("btn-network"));
    await waitFor(() => {
      expect(setNetworkFn).toHaveBeenCalledWith("r1", false);
    });
  });

  it("shows results-so-far banner while running", () => {
    render(
      <RunControlToolbar
        runId="r1"
        status="running"
        controlState="running"
      />,
    );
    expect(screen.getByTestId("results-so-far").textContent).toMatch(
      /Results so far/,
    );
  });
});

// ---------------------------------------------------------------------------
// TasksList presentational
// ---------------------------------------------------------------------------

describe("TasksList", () => {
  const sample: Task[] = [
    {
      id: "t1",
      projectId: "p1",
      name: "Hello eval",
      prompt: "Write hello world",
      workspace: { source: "empty" },
      agentCategory: "coding",
      profile: "feature",
      rubric: {
        version: 1,
        profile: "feature",
        criteria: [
          {
            id: "A1",
            axis: "A",
            label: "correctness",
            weight: 1,
            appliesTo: "coding",
            anchors: { full: "f", partial: "p", none: "n" },
          },
        ],
      },
    },
    {
      id: "t2",
      projectId: "p1",
      name: "Git task",
      prompt: "Fix bug",
      workspace: { source: "git", repo: "acme/api", ref: "main" },
      agentCategory: "coding",
      rubric: {
        version: 2,
        profile: "bugfix",
        criteria: [],
      },
    },
  ];

  it("renders rows from API payload", () => {
    render(<TasksList tasks={sample} />);
    expect(screen.getByTestId("tasks-list")).toBeTruthy();
    expect(screen.getByTestId("task-row-t1").textContent).toMatch(/Hello eval/);
    expect(screen.getByTestId("task-row-t1").textContent).toMatch(/coding/);
    expect(screen.getByTestId("task-row-t2").textContent).toMatch(
      /acme\/api@main/,
    );
  });

  it("shows empty state", () => {
    render(<TasksList tasks={[]} emptyMessage="Nothing here" />);
    expect(screen.getByTestId("tasks-list-empty").textContent).toBe(
      "Nothing here",
    );
  });

  it("invokes action callbacks", () => {
    const onRun = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <TasksList
        tasks={sample}
        onRun={onRun}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByTestId("task-run-t1"));
    fireEvent.click(screen.getByTestId("task-edit-t1"));
    fireEvent.click(screen.getByTestId("task-delete-t1"));
    expect(onRun).toHaveBeenCalledWith(sample[0]);
    expect(onEdit).toHaveBeenCalledWith(sample[0]);
    expect(onDelete).toHaveBeenCalledWith(sample[0]);
  });
});
