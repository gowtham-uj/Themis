/**
 * P7b-UI — getTaskTrend / getRunCompare / getReleaseCompare client tests
 * (offline, mocked fetch).
 *
 * Asserts the client unwraps the `{ points: [...] }` envelope (mirrors
 * listIssues / listProjects) and wires compare query params correctly.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createApiClient,
  getReleaseCompare,
  getRunCompare,
  getTaskTrend,
  isLikelyRegression,
  type TrendPointApi,
} from "../src/ui/lib/api.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchCall = {
  url: string;
  method: string;
};

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    return handler({ url, method });
  }) as unknown as typeof globalThis.fetch;
}

const base = { baseUrl: "http://api.test" };

const samplePoint: TrendPointApi = {
  order: 1,
  runId: "run-1",
  judgementId: "j-1",
  overallScore: 0.72,
  verdict: "pass",
  batchId: "batch-1",
  createdAt: "2026-08-01T10:00:00.000Z",
  findingDeltas: {
    introduced: [
      {
        fingerprint: "fp-a",
        category: "verification_skipped",
        kind: "defect",
        severity: "major",
        claim: "No verification step",
        refs: [{ kind: "diff", file: "src/a.ts", hunk: 1 }],
        occurrenceStatus: "introduced",
        runId: "run-1",
        judgementId: "j-1",
      },
    ],
    resolved: [],
  },
  batchStats: { mean: 0.7, spread: 0.05, n: 3 },
};

describe("getTaskTrend", () => {
  it("GETs /api/projects/:id/tasks/:taskId/trend and unwraps {points:[]} envelope", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("GET");
      expect(c.url).toBe(
        "http://api.test/api/projects/proj-1/tasks/task-1/trend",
      );
      return jsonResponse({ points: [samplePoint] });
    });

    const rows = await getTaskTrend("proj-1", "task-1", {
      ...base,
      fetch: fetchFn,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe("run-1");
    expect(rows[0]?.overallScore).toBe(0.72);
    expect(rows[0]?.findingDeltas.introduced).toHaveLength(1);
    expect(rows[0]?.batchStats?.n).toBe(3);
    // Must return the array, NOT the envelope object.
    expect(Array.isArray(rows)).toBe(true);
  });

  it("tolerates a bare-array response (no envelope)", async () => {
    const fetchFn = mockFetch(() => jsonResponse([samplePoint]));
    const rows = await getTaskTrend("proj-1", "task-1", {
      ...base,
      fetch: fetchFn,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.judgementId).toBe("j-1");
  });

  it("returns [] when envelope has empty points", async () => {
    const fetchFn = mockFetch(() => jsonResponse({ points: [] }));
    const rows = await getTaskTrend("p", "t", { ...base, fetch: fetchFn });
    expect(rows).toEqual([]);
  });

  it("URL-encodes project and task ids", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.url).toContain("/api/projects/proj%2F1/tasks/task%2F2/trend");
      return jsonResponse({ points: [] });
    });
    await getTaskTrend("proj/1", "task/2", { ...base, fetch: fetchFn });
  });
});

describe("getRunCompare", () => {
  it("GETs /api/projects/:id/compare/runs?a=&b= and returns the body", async () => {
    const body = {
      deltaOverall: -0.1,
      perCriterion: [
        {
          criterion: "c1",
          axis: "A",
          delta: -0.2,
          aScore: 0.8,
          bScore: 0.6,
        },
      ],
      findingSetDiff: {
        introduced: [],
        resolved: [],
        persisted: [],
      },
      diagnosticDeltas: [{ key: "verification_performed", a: true, b: false }],
      a: {
        runId: "run-a",
        judgementId: "j-a",
        agentCommit: "abc",
        overallScore: 0.8,
        verdict: "pass",
      },
      b: {
        runId: "run-b",
        judgementId: "j-b",
        triggerRef: "v2",
        overallScore: 0.7,
        verdict: "partial",
      },
    };
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("GET");
      const u = new URL(c.url);
      expect(u.pathname).toBe("/api/projects/proj-1/compare/runs");
      expect(u.searchParams.get("a")).toBe("run-a");
      expect(u.searchParams.get("b")).toBe("run-b");
      return jsonResponse(body);
    });

    const result = await getRunCompare("proj-1", "run-a", "run-b", {
      ...base,
      fetch: fetchFn,
    });
    expect(result.deltaOverall).toBe(-0.1);
    expect(result.a.runId).toBe("run-a");
    expect(result.b.verdict).toBe("partial");
    expect(result.perCriterion).toHaveLength(1);
  });
});

describe("getReleaseCompare", () => {
  it("GETs /api/projects/:id/compare/releases?from=&to=", async () => {
    const body = {
      from: "v1",
      to: "v2",
      suiteDelta: {
        deltaOverall: -0.05,
        spread: 0.02,
        nImproved: 1,
        nRegressed: 2,
        nFlat: 0,
        nNewTasks: 1,
        nRemovedTasks: 0,
      },
      perAxisRollup: [{ axis: "D", fromMean: 0.8, toMean: 0.6, delta: -0.2 }],
      findingCategoryDeltas: [
        {
          category: "verification_skipped",
          introduced: 4,
          resolved: 1,
          persisted: 2,
          deltaNet: 3,
        },
      ],
      diagnosticRateDeltas: [
        { key: "verification_performed", fromRate: 0.9, toRate: 0.7, delta: -0.2 },
      ],
      perTaskBreakdown: [
        {
          taskId: "t1",
          deltaOverall: -0.15,
          perAxis: [{ axis: "D", delta: -0.2 }],
          findingsDelta: 2,
          presentInBoth: true,
        },
      ],
      fromVersion: "v1",
      toVersion: "v2",
      fromTasks: 3,
      toTasks: 4,
    };
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("GET");
      const u = new URL(c.url);
      expect(u.pathname).toBe("/api/projects/proj-1/compare/releases");
      expect(u.searchParams.get("from")).toBe("v1");
      expect(u.searchParams.get("to")).toBe("v2");
      return jsonResponse(body);
    });

    const result = await getReleaseCompare("proj-1", "v1", "v2", {
      ...base,
      fetch: fetchFn,
    });
    expect(result.suiteDelta.nRegressed).toBe(2);
    expect(result.fromVersion).toBe("v1");
    expect(result.perTaskBreakdown[0]?.taskId).toBe("t1");
  });
});

describe("createApiClient regression bindings", () => {
  it("exposes getTaskTrend / getRunCompare / getReleaseCompare", async () => {
    const fetchFn = mockFetch((c) => {
      if (c.url.includes("/trend")) {
        return jsonResponse({ points: [samplePoint] });
      }
      if (c.url.includes("/compare/runs")) {
        return jsonResponse({
          deltaOverall: 0,
          perCriterion: [],
          findingSetDiff: { introduced: [], resolved: [], persisted: [] },
          diagnosticDeltas: [],
          a: {
            runId: "a",
            judgementId: "ja",
            overallScore: 0.5,
            verdict: "pass",
          },
          b: {
            runId: "b",
            judgementId: "jb",
            overallScore: 0.5,
            verdict: "pass",
          },
        });
      }
      return jsonResponse({
        from: "v1",
        to: "v2",
        suiteDelta: {
          deltaOverall: 0,
          spread: 0,
          nImproved: 0,
          nRegressed: 0,
          nFlat: 0,
          nNewTasks: 0,
          nRemovedTasks: 0,
        },
        perAxisRollup: [],
        findingCategoryDeltas: [],
        diagnosticRateDeltas: [],
        perTaskBreakdown: [],
        fromVersion: "v1",
        toVersion: "v2",
        fromTasks: 0,
        toTasks: 0,
      });
    });
    const client = createApiClient({ ...base, fetch: fetchFn });
    const trend = await client.getTaskTrend("p", "t");
    expect(trend).toHaveLength(1);
    const cmp = await client.getRunCompare("p", "a", "b");
    expect(cmp.deltaOverall).toBe(0);
    const rel = await client.getReleaseCompare("p", "v1", "v2");
    expect(rel.fromVersion).toBe("v1");
  });
});

describe("isLikelyRegression", () => {
  it("is true when |delta| exceeds spread", () => {
    expect(isLikelyRegression(-0.2, 0.05)).toBe(true);
    expect(isLikelyRegression(0.2, 0.05)).toBe(true);
  });
  it("is false when |delta| is within the noise band", () => {
    expect(isLikelyRegression(-0.02, 0.05)).toBe(false);
    expect(isLikelyRegression(0.05, 0.05)).toBe(false);
  });
});
