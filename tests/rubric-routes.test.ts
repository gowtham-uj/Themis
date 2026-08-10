/**
 * Project-scoped rubric CRUD — query layer + REST routes.
 *
 * Rubrics were previously only embeddable per-task (tasks.rubric_json). These
 * are the project's shared, versioned baselines: full CRUD, addressable by API,
 * with the same version-bump-on-semantic-edit rule as task rubrics
 * (plan/rubric.md).
 *
 * Boots the real API server; no agent or judge execution is involved.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import type { Rubric } from "../src/domain.ts";

const tempDirs: string[] = [];
const servers: ApiServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try {
      await s.close();
    } catch {
      // best-effort
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function sampleRubric(version = 1): Rubric {
  return {
    version,
    profile: "bugfix",
    criteria: [
      {
        id: "A1",
        axis: "A",
        label: "correctness",
        weight: 1,
        appliesTo: "coding",
        anchors: { full: "fully correct", partial: "partial", none: "wrong" },
      },
    ],
  };
}

async function boot(): Promise<{
  api: ApiServer;
  base: string;
  projectId: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-rubric-routes-"));
  tempDirs.push(dataDir);
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  const project = api.queries.createProject({
    name: "Rubrics",
    slug: `rb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { api, base: `http://127.0.0.1:${port}`, projectId: project.id };
}

async function http(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// Query layer
// ---------------------------------------------------------------------------

describe("project rubric queries", () => {
  it("creates, reads, lists and archives", async () => {
    const { api, projectId } = await boot();
    const q = api.queries;

    expect(q.listProjectRubrics(projectId)).toEqual([]);

    const created = q.createProjectRubric({
      projectId,
      name: "Bugfix baseline",
      description: "shared",
      rubric: sampleRubric(),
    });
    expect(created.id).toBeTruthy();
    expect(created.rubricVersion).toBe(1);
    expect(created.archived).toBe(false);
    expect(created.rubric.criteria[0]!.id).toBe("A1");

    expect(q.getProjectRubric(created.id)?.name).toBe("Bugfix baseline");
    expect(q.listProjectRubrics(projectId).length).toBe(1);

    const archived = q.archiveProjectRubric(created.id);
    expect(archived.archived).toBe(true);
    // Excluded by default, visible when asked.
    expect(q.listProjectRubrics(projectId).length).toBe(0);
    expect(
      q.listProjectRubrics(projectId, { includeArchived: true }).length,
    ).toBe(1);
  });

  it("bumps rubricVersion on a semantic edit but not on a rename", async () => {
    const { api, projectId } = await boot();
    const q = api.queries;
    const r = q.createProjectRubric({
      projectId,
      name: "v1",
      rubric: sampleRubric(),
    });
    expect(r.rubricVersion).toBe(1);

    const renamed = q.updateProjectRubric(r.id, { name: "v1 renamed" });
    expect(renamed.rubricVersion).toBe(1);
    expect(renamed.name).toBe("v1 renamed");

    const edited = q.updateProjectRubric(r.id, {
      rubric: {
        ...sampleRubric(),
        criteria: [
          {
            id: "A1",
            axis: "A",
            label: "correctness (tightened)",
            weight: 1,
            appliesTo: "coding",
            anchors: { full: "f", partial: "p", none: "n" },
          },
        ],
      },
    });
    expect(edited.rubricVersion).toBe(2);
    // The stored rubric carries the bumped version, so it is a new baseline.
    expect(edited.rubric.version).toBe(2);

    // Re-applying the SAME rubric does not bump again.
    const again = q.updateProjectRubric(r.id, { rubric: edited.rubric });
    expect(again.rubricVersion).toBe(2);
  });

  it("keeps at most one default rubric per project", async () => {
    const { api, projectId } = await boot();
    const q = api.queries;
    const a = q.createProjectRubric({
      projectId,
      name: "a",
      rubric: sampleRubric(),
      isDefault: true,
    });
    expect(q.getDefaultProjectRubric(projectId)?.id).toBe(a.id);

    const b = q.createProjectRubric({
      projectId,
      name: "b",
      rubric: sampleRubric(),
      isDefault: true,
    });
    expect(q.getDefaultProjectRubric(projectId)?.id).toBe(b.id);
    expect(q.getProjectRubric(a.id)?.isDefault).toBe(false);

    // Archiving the default clears the flag rather than leaving a dangling one.
    q.archiveProjectRubric(b.id);
    expect(q.getDefaultProjectRubric(projectId)).toBeNull();
  });

  it("scopes rubrics per project and rejects an unknown project", async () => {
    const { api, projectId } = await boot();
    const q = api.queries;
    const other = q.createProject({ name: "Other", slug: `o-${Date.now()}` });
    q.createProjectRubric({ projectId, name: "mine", rubric: sampleRubric() });
    expect(q.listProjectRubrics(other.id)).toEqual([]);
    expect(() =>
      q.createProjectRubric({
        projectId: "does-not-exist",
        name: "x",
        rubric: sampleRubric(),
      }),
    ).toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// REST routes
// ---------------------------------------------------------------------------

describe("project rubric routes", () => {
  it("full CRUD lifecycle over HTTP", async () => {
    const { base, projectId } = await boot();

    // Empty list.
    const empty = await http(base, "GET", `/api/projects/${projectId}/rubrics`);
    expect(empty.status).toBe(200);
    expect(empty.json.rubrics).toEqual([]);

    // Create.
    const created = await http(
      base,
      "POST",
      `/api/projects/${projectId}/rubrics`,
      { name: "Bugfix baseline", description: "shared", rubric: sampleRubric() },
    );
    expect(created.status).toBe(201);
    const id = created.json.rubric.id as string;
    expect(id).toBeTruthy();
    expect(created.json.rubric.rubric_version).toBe(1);
    expect(created.json.rubric.project_id).toBe(projectId);

    // Read back.
    const got = await http(
      base,
      "GET",
      `/api/projects/${projectId}/rubrics/${id}`,
    );
    expect(got.status).toBe(200);
    expect(got.json.rubric.name).toBe("Bugfix baseline");
    expect(got.json.rubric.rubric.criteria.length).toBe(1);

    // List has it.
    const list = await http(base, "GET", `/api/projects/${projectId}/rubrics`);
    expect(list.json.rubrics.length).toBe(1);

    // PATCH rename — no version bump.
    const renamed = await http(
      base,
      "PATCH",
      `/api/projects/${projectId}/rubrics/${id}`,
      { name: "Renamed" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.json.rubric.name).toBe("Renamed");
    expect(renamed.json.rubric.rubric_version).toBe(1);

    // PUT a changed rubric — version bump.
    const edited = await http(
      base,
      "PUT",
      `/api/projects/${projectId}/rubrics/${id}`,
      {
        rubric: {
          ...sampleRubric(),
          criteria: [
            {
              id: "A1",
              axis: "A",
              label: "much stricter",
              weight: 1,
              appliesTo: "coding",
              anchors: { full: "f", partial: "p", none: "n" },
            },
          ],
        },
      },
    );
    expect(edited.status).toBe(200);
    expect(edited.json.rubric.rubric_version).toBe(2);

    // DELETE → 204, then gone from the default list.
    const del = await http(
      base,
      "DELETE",
      `/api/projects/${projectId}/rubrics/${id}`,
    );
    expect(del.status).toBe(204);
    const after = await http(base, "GET", `/api/projects/${projectId}/rubrics`);
    expect(after.json.rubrics.length).toBe(0);
    const archived = await http(
      base,
      "GET",
      `/api/projects/${projectId}/rubrics?include_archived=1`,
    );
    expect(archived.json.rubrics.length).toBe(1);
    expect(archived.json.rubrics[0].archived).toBe(true);
  });

  it("rejects a malformed rubric with 400 rather than storing it", async () => {
    const { base, projectId } = await boot();

    // No criteria at all.
    const noCriteria = await http(
      base,
      "POST",
      `/api/projects/${projectId}/rubrics`,
      { name: "bad", rubric: { criteria: [], profile: "bugfix", version: 1 } },
    );
    expect(noCriteria.status).toBe(400);

    // Missing rubric entirely.
    const noRubric = await http(
      base,
      "POST",
      `/api/projects/${projectId}/rubrics`,
      { name: "bad" },
    );
    expect(noRubric.status).toBe(400);

    // Missing name.
    const noName = await http(
      base,
      "POST",
      `/api/projects/${projectId}/rubrics`,
      { rubric: sampleRubric() },
    );
    expect(noName.status).toBe(400);

    // Nothing was persisted by any of the rejected calls.
    const list = await http(base, "GET", `/api/projects/${projectId}/rubrics`);
    expect(list.json.rubrics.length).toBe(0);
  });

  it("404s for unknown project and unknown/cross-project rubric", async () => {
    const { api, base, projectId } = await boot();
    const other = api.queries.createProject({
      name: "Other",
      slug: `o2-${Date.now()}`,
    });
    const mine = api.queries.createProjectRubric({
      projectId,
      name: "mine",
      rubric: sampleRubric(),
    });

    expect(
      (await http(base, "GET", `/api/projects/nope/rubrics`)).status,
    ).toBe(404);
    expect(
      (await http(base, "GET", `/api/projects/${projectId}/rubrics/nope`))
        .status,
    ).toBe(404);
    // Right rubric id, wrong project → still 404 (no cross-project leakage).
    expect(
      (await http(base, "GET", `/api/projects/${other.id}/rubrics/${mine.id}`))
        .status,
    ).toBe(404);
  });

  it("marks a default rubric and demotes the previous one over HTTP", async () => {
    const { base, projectId } = await boot();
    const a = await http(base, "POST", `/api/projects/${projectId}/rubrics`, {
      name: "a",
      rubric: sampleRubric(),
      isDefault: true,
    });
    expect(a.json.rubric.is_default).toBe(true);

    const b = await http(base, "POST", `/api/projects/${projectId}/rubrics`, {
      name: "b",
      rubric: sampleRubric(),
      is_default: true,
    });
    expect(b.json.rubric.is_default).toBe(true);

    const listed = await http(base, "GET", `/api/projects/${projectId}/rubrics`);
    const defaults = listed.json.rubrics.filter(
      (r: { is_default: boolean }) => r.is_default,
    );
    expect(defaults.length).toBe(1);
    expect(defaults[0].id).toBe(b.json.rubric.id);
  });
});
