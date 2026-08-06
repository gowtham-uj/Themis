/**
 * P6b-UI — listIssues / getIssue API client tests (offline, mocked fetch).
 *
 * Asserts the client unwraps the `{ findings: [...] }` envelope (mirrors
 * listProjects / listRuns) and wires filters + detail correctly.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createApiClient,
  getIssue,
  listIssues,
  listIssuesUrl,
  normalizeIssueDetail,
  normalizeIssueListItem,
  runIssuesUrl,
  type IssueListItem,
} from "../src/ui/lib/api.ts";
import { sortIssuesForBacklog } from "../src/ui/app/projects/[id]/issues/IssuesPageClient.tsx";

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

const sampleFinding = {
  fingerprint: "abc123def456",
  taskId: "task-1",
  projectId: "proj-1",
  category: "test_gaming",
  kind: "defect",
  claim: "Agent edited tests to pass without fixing the bug",
  latestSeverity: "major",
  latestConfidence: 0.9,
  firstSeenJudgement: "j1",
  lastSeenJudgement: "j2",
  firstSeenAt: "2026-08-01T10:00:00.000Z",
  lastSeenAt: "2026-08-05T12:00:00.000Z",
  occurrenceCount: 3,
  resolvedAt: null,
  status: "open",
  recurrence: {
    firstSeenRunId: "run-a",
    lastSeenRunId: "run-c",
    count: 3,
  },
};

describe("listIssues", () => {
  it("GETs /api/projects/:id/findings and unwraps {findings:[]} envelope", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("GET");
      expect(c.url).toBe("http://api.test/api/projects/proj-1/findings");
      return jsonResponse({ findings: [sampleFinding] });
    });

    const rows = await listIssues("proj-1", { ...base, fetch: fetchFn });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fingerprint).toBe("abc123def456");
    expect(rows[0]?.claim).toContain("edited tests");
    expect(rows[0]?.occurrenceCount).toBe(3);
    expect(rows[0]?.recurrence?.firstSeenRunId).toBe("run-a");
    // Must return the array, NOT the envelope object.
    expect(Array.isArray(rows)).toBe(true);
  });

  it("forwards status/category/task/kind/severity/limit query params", async () => {
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("GET");
      const u = new URL(c.url);
      expect(u.pathname).toBe("/api/projects/p1/findings");
      expect(u.searchParams.get("status")).toBe("open");
      expect(u.searchParams.get("category")).toBe("test_gaming");
      expect(u.searchParams.get("task")).toBe("t1");
      expect(u.searchParams.get("kind")).toBe("defect");
      expect(u.searchParams.get("severity")).toBe("blocker");
      expect(u.searchParams.get("limit")).toBe("25");
      return jsonResponse({ findings: [] });
    });

    const rows = await listIssues("p1", {
      ...base,
      fetch: fetchFn,
      status: "open",
      category: "test_gaming",
      task: "t1",
      kind: "defect",
      severity: "blocker",
      limit: 25,
    });
    expect(rows).toEqual([]);
  });

  it("tolerates a bare-array response (no envelope)", async () => {
    const fetchFn = mockFetch(() => jsonResponse([sampleFinding]));
    const rows = await listIssues("proj-1", { ...base, fetch: fetchFn });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fingerprint).toBe("abc123def456");
  });

  it("normalizes snake_case fields", async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({
        findings: [
          {
            fingerprint: "fp1",
            task_id: "t1",
            project_id: "p1",
            category: "x",
            kind: "defect",
            claim: "c",
            latest_severity: "nit",
            latest_confidence: 0.5,
            first_seen_judgement: "j1",
            last_seen_judgement: "j1",
            first_seen_at: "2026-01-01T00:00:00.000Z",
            last_seen_at: "2026-01-01T00:00:00.000Z",
            occurrence_count: 1,
            resolved_at: null,
            status: "open",
            recurrence: {
              first_seen_run_id: "r1",
              last_seen_run_id: "r1",
              count: 1,
            },
          },
        ],
      }),
    );
    const rows = await listIssues("p1", { ...base, fetch: fetchFn });
    expect(rows[0]?.taskId).toBe("t1");
    expect(rows[0]?.projectId).toBe("p1");
    expect(rows[0]?.latestSeverity).toBe("nit");
    expect(rows[0]?.occurrenceCount).toBe(1);
    expect(rows[0]?.recurrence?.firstSeenRunId).toBe("r1");
  });
});

describe("getIssue", () => {
  it("GETs /api/projects/:id/findings/:fingerprint and decodes refs/fix", async () => {
    const fp = "deadbeefcafe";
    const fetchFn = mockFetch((c) => {
      expect(c.method).toBe("GET");
      expect(c.url).toBe(
        `http://api.test/api/projects/proj-1/findings/${fp}`,
      );
      return jsonResponse({
        finding: {
          ...sampleFinding,
          fingerprint: fp,
          occurrences: [
            {
              id: "occ-1",
              findingFingerprint: fp,
              judgementId: "j2",
              runId: "run-c",
              severity: "major",
              confidence: 0.88,
              claim: sampleFinding.claim,
              criterion: "A1",
              refsJson: JSON.stringify([
                { kind: "diff", file: "src/a.ts", hunk: 2, lines: [10, 20] },
                { kind: "tool", toolCallId: "tc-9" },
              ]),
              fixJson: JSON.stringify({
                direction: "restore original assertion",
                repro: { command: "npm test", expected: "pass" },
              }),
              status: "persisted",
              createdAt: "2026-08-05T12:00:00.000Z",
            },
          ],
        },
        recurrence: {
          firstSeenRunId: "run-a",
          lastSeenRunId: "run-c",
          count: 3,
        },
        kByBatch: [
          { batchId: "b1", k: 3, n: 3 },
          { batchId: "b2", k: 1, n: 3 },
        ],
      });
    });

    const detail = await getIssue("proj-1", fp, { ...base, fetch: fetchFn });
    expect(detail.finding.fingerprint).toBe(fp);
    expect(detail.finding.occurrences).toHaveLength(1);
    const occ = detail.finding.occurrences[0]!;
    expect(occ.refs).toHaveLength(2);
    expect(occ.refs?.[0]).toMatchObject({
      kind: "diff",
      file: "src/a.ts",
      hunk: 2,
    });
    expect(occ.fix?.direction).toBe("restore original assertion");
    expect(detail.kByBatch).toEqual([
      { batchId: "b1", k: 3, n: 3 },
      { batchId: "b2", k: 1, n: 3 },
    ]);
    expect(detail.recurrence.count).toBe(3);
  });

  it("URL-encodes the fingerprint path segment", async () => {
    const fetchFn = mockFetch((c) => {
      // hex is already safe; encodeURIComponent still applied
      expect(c.url).toContain("/findings/ab%2Fcd");
      return jsonResponse({
        finding: { ...sampleFinding, fingerprint: "ab/cd", occurrences: [] },
        recurrence: {},
        kByBatch: [],
      });
    });
    await getIssue("p1", "ab/cd", { ...base, fetch: fetchFn });
  });
});

describe("URL builders", () => {
  it("listIssuesUrl includes filters", () => {
    const url = listIssuesUrl("p1", {
      baseUrl: "http://api.test",
      status: "open",
      severity: "major",
    });
    expect(url).toBe(
      "http://api.test/api/projects/p1/findings?status=open&severity=major",
    );
  });

  it("runIssuesUrl encodes fingerprint", () => {
    const url = runIssuesUrl("p1", "fp-1", { baseUrl: "" });
    expect(url).toBe("/api/projects/p1/findings/fp-1");
  });
});

describe("createApiClient wires listIssues + getIssue", () => {
  it("exposes listIssues/getIssue bound to options", async () => {
    const fetchFn = mockFetch((c) => {
      if (c.url.includes("/findings/") && !c.url.endsWith("/findings")) {
        return jsonResponse({
          finding: { ...sampleFinding, occurrences: [] },
          recurrence: { count: 1 },
          kByBatch: [],
        });
      }
      return jsonResponse({ findings: [sampleFinding] });
    });
    const client = createApiClient({ ...base, fetch: fetchFn });
    const list = await client.listIssues("proj-1", { status: "open" });
    expect(list).toHaveLength(1);
    const detail = await client.getIssue("proj-1", sampleFinding.fingerprint);
    expect(detail.finding.fingerprint).toBe(sampleFinding.fingerprint);
  });
});

describe("normalize helpers", () => {
  it("normalizeIssueListItem fills defaults", () => {
    const row = normalizeIssueListItem({ fingerprint: "x" });
    expect(row.fingerprint).toBe("x");
    expect(row.status).toBe("open");
    expect(row.occurrenceCount).toBe(0);
  });

  it("normalizeIssueDetail accepts top-level finding-shaped payload", () => {
    const d = normalizeIssueDetail({
      fingerprint: "f1",
      taskId: "t",
      projectId: "p",
      category: "c",
      kind: "defect",
      claim: "claim",
      status: "open",
      occurrenceCount: 1,
      occurrences: [],
      recurrence: { firstSeenRunId: "r1", lastSeenRunId: "r1", count: 1 },
      kByBatch: [{ batchId: "b", k: 1, n: 1 }],
    });
    expect(d.finding.fingerprint).toBe("f1");
    expect(d.kByBatch[0]?.k).toBe(1);
  });
});

describe("sortIssuesForBacklog", () => {
  it("orders by occurrenceCount desc then lastSeenAt desc", () => {
    const rows: IssueListItem[] = [
      {
        fingerprint: "a",
        taskId: "t",
        projectId: "p",
        category: "c",
        kind: "defect",
        claim: "a",
        latestSeverity: "minor",
        latestConfidence: 1,
        firstSeenJudgement: null,
        lastSeenJudgement: null,
        firstSeenAt: null,
        lastSeenAt: "2026-08-05T00:00:00.000Z",
        occurrenceCount: 1,
        resolvedAt: null,
        status: "open",
      },
      {
        fingerprint: "b",
        taskId: "t",
        projectId: "p",
        category: "c",
        kind: "defect",
        claim: "b",
        latestSeverity: "major",
        latestConfidence: 1,
        firstSeenJudgement: null,
        lastSeenJudgement: null,
        firstSeenAt: null,
        lastSeenAt: "2026-08-01T00:00:00.000Z",
        occurrenceCount: 5,
        resolvedAt: null,
        status: "open",
      },
      {
        fingerprint: "c",
        taskId: "t",
        projectId: "p",
        category: "c",
        kind: "defect",
        claim: "c",
        latestSeverity: "blocker",
        latestConfidence: 1,
        firstSeenJudgement: null,
        lastSeenJudgement: null,
        firstSeenAt: null,
        lastSeenAt: "2026-08-06T00:00:00.000Z",
        occurrenceCount: 5,
        resolvedAt: null,
        status: "open",
      },
    ];
    const sorted = sortIssuesForBacklog(rows);
    expect(sorted.map((r) => r.fingerprint)).toEqual(["c", "b", "a"]);
  });
});
