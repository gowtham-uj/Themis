import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectCtx, TaskSpec } from "../src/domain.ts";
import {
  CiArtifactSource,
  createMemoryTaskStore,
  createTaskSource,
  syncTasks,
  validateTaskSpec,
} from "../src/tasks/index.ts";

function ctx(
  partial: Partial<ProjectCtx> & Pick<ProjectCtx, "projectDir">,
): ProjectCtx {
  return {
    projectId: partial.projectId ?? "proj-ci",
    projectDir: partial.projectDir,
    workspaceDir: partial.workspaceDir,
    defaultAgentCategory: partial.defaultAgentCategory ?? "coding",
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

function minimalSpec(overrides: Partial<TaskSpec> & { id: string; name: string }): Record<string, unknown> {
  return {
    id: overrides.id,
    name: overrides.name,
    prompt: overrides.prompt ?? `prompt for ${overrides.name}`,
    workspace: overrides.workspace ?? { source: "empty" },
    agentCategory: overrides.agentCategory ?? "coding",
    tags: overrides.tags ?? ["ci"],
    profile: overrides.profile ?? "general",
    rubric: overrides.rubric ?? {
      profile: "general",
      version: 1,
      criteria: [
        {
          id: "A1",
          axis: "A",
          label: "Done",
          weight: 1,
          appliesTo: "both",
          anchors: { full: "full", partial: "partial", none: "none" },
        },
      ],
      checks: [
        { id: "tests", kind: "test_suite", command: "npm test" },
      ],
    },
    checks: overrides.checks ?? [
      { id: "tests", kind: "test_suite", command: "npm test" },
    ],
  };
}

describe("CiArtifactSource — directory of JSON", () => {
  it("loads JSON specs from a temp dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-ci-"));
    const dir = join(root, "ci-artifacts");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "t1.json"),
      JSON.stringify(minimalSpec({ id: "t1", name: "Task One" })),
      "utf8",
    );
    await writeFile(
      join(dir, "t2.json"),
      JSON.stringify(
        minimalSpec({
          id: "t2",
          name: "Task Two",
          agentCategory: "data",
          tags: ["etl"],
        }),
      ),
      "utf8",
    );

    const source = new CiArtifactSource({ artifactDir: dir });
    // artifactDir is absolute so workspaceDir is unused for path resolution
    const tasks = await collect(
      source.list(ctx({ projectDir: root, workspaceDir: root })),
    );
    expect(tasks).toHaveLength(2);
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["t1", "t2"]);
    const t1 = tasks.find((t) => t.id === "t1")!;
    expect(t1.name).toBe("Task One");
    expect(t1.tags).toEqual(["ci"]);
    expect(t1.checks?.[0]?.id).toBe("tests");
    expect(validateTaskSpec(t1).ok).toBe(true);

    const t2 = tasks.find((t) => t.id === "t2")!;
    expect(t2.agentCategory).toBe("data");
  });

  it("missing dir → empty yield (not error)", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-ci-miss-"));
    const source = new CiArtifactSource({
      artifactDir: join(root, "does-not-exist"),
    });
    const tasks = await collect(
      source.list(ctx({ projectDir: root, workspaceDir: root })),
    );
    expect(tasks).toEqual([]);
    expect(source.lastSkipReasons).toEqual([]);
  });

  it("bad JSON skipped with a recorded reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-ci-bad-"));
    const dir = join(root, "ci-artifacts");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "good.json"), JSON.stringify(minimalSpec({ id: "good", name: "Good" })), "utf8");
    await writeFile(join(dir, "bad.json"), "{ not valid json !!!", "utf8");

    const source = new CiArtifactSource({ artifactDir: dir });
    const tasks = await collect(
      source.list(ctx({ projectDir: root, workspaceDir: root })),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("good");
    expect(source.lastSkipReasons.length).toBeGreaterThan(0);
    expect(source.lastSkipReasons.some((s) => /bad JSON/i.test(s.reason))).toBe(
      true,
    );
  });
});

describe("CiArtifactSource — single manifest.json", () => {
  it("loads tasks from a manifest.json array", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-ci-man-"));
    const dir = join(root, "ci-artifacts");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        tasks: [
          minimalSpec({ id: "m1", name: "Manifest One" }),
          minimalSpec({ id: "m2", name: "Manifest Two", agentCategory: "browser" }),
        ],
      }),
      "utf8",
    );

    const source = new CiArtifactSource({ artifactDir: dir });
    const tasks = await collect(
      source.list(ctx({ projectDir: root, workspaceDir: root })),
    );
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.id).sort()).toEqual(["m1", "m2"]);
    expect(tasks.find((t) => t.id === "m2")!.agentCategory).toBe("browser");
  });

  it("loads a bare array manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-ci-arr-"));
    const dir = join(root, "ci-artifacts");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify([minimalSpec({ id: "a1", name: "A1" })]),
      "utf8",
    );
    const source = new CiArtifactSource({ artifactDir: dir });
    const tasks = await collect(
      source.list(ctx({ projectDir: root, workspaceDir: root })),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("a1");
  });
});

describe("CiArtifactSource — verbatim ingest + sync", () => {
  it("preserves prompt content verbatim", async () => {
    const syntheticKey = ["sk-ant-api03", "FAKE".repeat(12)].join("-");
    const root = await mkdtemp(join(tmpdir(), "agenteval-ci-verbatim-"));
    const dir = join(root, "ci-artifacts");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "secret.json"),
      JSON.stringify(
        minimalSpec({
          id: "sec",
          name: "Secret task",
          prompt: `use key ${syntheticKey}`,
        }),
      ),
      "utf8",
    );
    const source = new CiArtifactSource({ artifactDir: dir });
    const tasks = await collect(
      source.list(ctx({ projectDir: root, workspaceDir: root })),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt).toBe(
      `use key ${syntheticKey}`,
    );
  });

  it("syncTasks upserts into the memory store", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-ci-sync-"));
    const dir = join(root, "ci-artifacts");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "s1.json"),
      JSON.stringify(minimalSpec({ id: "s1", name: "Sync One" })),
      "utf8",
    );

    const store = createMemoryTaskStore();
    const source = new CiArtifactSource({ artifactDir: dir });
    const result = await syncTasks(
      ctx({ projectDir: root, workspaceDir: root }),
      source,
      store,
    );
    expect(result.sourceKind).toBe("ci-artifact");
    expect(result.upserted).toHaveLength(1);
    expect(store.get("proj-ci", "s1")).not.toBeNull();
  });
});

describe("createTaskSource(ci-artifact)", () => {
  it("returns a CiArtifactSource", () => {
    const s = createTaskSource("ci-artifact");
    expect(s.kind).toBe("ci-artifact");
    expect(s).toBeInstanceOf(CiArtifactSource);
  });
});
