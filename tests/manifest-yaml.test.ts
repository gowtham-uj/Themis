import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectCtx, TaskSpec } from "../src/domain.ts";
import {
  createTaskSource,
  createMemoryTaskStore,
  ManifestYamlSource,
  parseManifestYaml,
  syncTasks,
  validateTaskSpec,
} from "../src/tasks/index.ts";

function ctx(
  partial: Partial<ProjectCtx> & Pick<ProjectCtx, "projectDir">,
): ProjectCtx {
  return {
    projectId: partial.projectId ?? "proj-manifest",
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

const SAMPLE_MANIFEST = `
tasks:
  - id: hello-yaml
    name: Hello YAML
    prompt: Print hello from manifest
    agentCategory: coding
    tags:
      - smoke
      - yaml
    profile: feature
    workspace:
      source: empty
    checks:
      - id: tests
        kind: test_suite
        command: npm test
    rubric:
      profile: feature
      version: 1
      criteria:
        - id: A1
          axis: A
          label: Completeness
          weight: 1
          appliesTo: both
          critical: true
          checkId: tests
          anchors:
            full: fully met
            partial: partially met
            none: missing
  - id: research-task
    name: Research task
    prompt: Summarize the docs
    agentCategory: research
    tags:
      - research
    profile: research
    workspace:
      source: git
      repo: example/docs
      ref: main
    rubric:
      profile: research
      version: 1
      criteria:
        - id: B1
          axis: B
          label: Accuracy
          weight: 1
          appliesTo: general
          anchors:
            full: accurate
            partial: partial
            none: wrong
`;

describe("parseManifestYaml", () => {
  it("parses a sample manifest into TaskSpecs (rubric + tags + checks)", () => {
    const specs = parseManifestYaml(
      SAMPLE_MANIFEST,
      ctx({ projectDir: "/tmp/x" }),
    );
    expect(specs).toHaveLength(2);

    const hello = specs.find((s) => s.id === "hello-yaml");
    expect(hello).toBeDefined();
    expect(hello!.name).toBe("Hello YAML");
    expect(hello!.prompt).toContain("hello from manifest");
    expect(hello!.agentCategory).toBe("coding");
    expect(hello!.tags).toEqual(["smoke", "yaml"]);
    expect(hello!.profile).toBe("feature");
    expect(hello!.workspace).toEqual({ source: "empty" });
    expect(hello!.checks?.[0]?.id).toBe("tests");
    expect(hello!.checks?.[0]?.kind).toBe("test_suite");
    expect(hello!.rubric.criteria).toHaveLength(1);
    expect(hello!.rubric.criteria[0]!.id).toBe("A1");
    expect(hello!.rubric.criteria[0]!.critical).toBe(true);
    expect(hello!.rubric.criteria[0]!.anchors.full).toBe("fully met");
    expect(hello!.rubric.criteria[0]!.checkId).toBe("tests");

    const v = validateTaskSpec(hello!);
    expect(v.ok).toBe(true);

    const research = specs.find((s) => s.id === "research-task");
    expect(research).toBeDefined();
    expect(research!.agentCategory).toBe("research");
    expect(research!.workspace).toEqual({
      source: "git",
      repo: "example/docs",
      ref: "main",
    });
  });

  it("accepts a top-level sequence of task maps", () => {
    const yaml = `
- id: t1
  name: One
  prompt: do one
  rubric:
    profile: general
    version: 1
    criteria:
      - id: A1
        axis: A
        label: L
        weight: 1
        appliesTo: both
        anchors:
          full: f
          partial: p
          none: n
`;
    const specs = parseManifestYaml(yaml, ctx({ projectDir: "/tmp/x" }));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.id).toBe("t1");
  });

  it("throws a clear error on empty manifest", () => {
    expect(() => parseManifestYaml("", ctx({ projectDir: "/tmp/x" }))).toThrow(
      /empty/i,
    );
  });

  it("throws a clear error when tasks list is missing", () => {
    expect(() =>
      parseManifestYaml("version: 1\nname: not-a-task-list\n", ctx({ projectDir: "/tmp/x" })),
    ).toThrow(/invalid root|no tasks/i);
  });

  it("throws when a tasks entry is not a mapping", () => {
    expect(() =>
      parseManifestYaml(
        "tasks:\n  - just-a-string\n  - another\n",
        ctx({ projectDir: "/tmp/x" }),
      ),
    ).toThrow(/must be a mapping/i);
  });
});

describe("ManifestYamlSource", () => {
  it("reads agenteval.yaml from workspaceDir and yields specs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenteval-manifest-"));
    await writeFile(join(dir, "agenteval.yaml"), SAMPLE_MANIFEST, "utf8");

    const source = new ManifestYamlSource();
    const tasks = await collect(
      source.list(ctx({ projectDir: dir, workspaceDir: dir })),
    );
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.id).sort()).toEqual([
      "hello-yaml",
      "research-task",
    ]);
  });

  it("honors params.path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenteval-manifest-path-"));
    await writeFile(join(dir, "custom.yaml"), SAMPLE_MANIFEST, "utf8");

    const source = new ManifestYamlSource({ path: "custom.yaml" });
    const tasks = await collect(
      source.list(ctx({ projectDir: dir, workspaceDir: dir })),
    );
    expect(tasks).toHaveLength(2);
  });

  it("throws clearly when the manifest file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenteval-manifest-missing-"));
    const source = new ManifestYamlSource();
    await expect(
      collect(source.list(ctx({ projectDir: dir, workspaceDir: dir }))),
    ).rejects.toThrow(/cannot read manifest/i);
  });

  it("syncTasks upserts parsed specs into the store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenteval-manifest-sync-"));
    await writeFile(join(dir, "agenteval.yaml"), SAMPLE_MANIFEST, "utf8");

    const store = createMemoryTaskStore();
    const result = await syncTasks(
      ctx({ projectDir: dir, workspaceDir: dir }),
      new ManifestYamlSource(),
      store,
    );
    expect(result.sourceKind).toBe("manifest-yaml");
    expect(result.upserted).toHaveLength(2);
    expect(result.invalid).toHaveLength(0);
    expect(store.get("proj-manifest", "hello-yaml")).not.toBeNull();
  });
});

describe("createTaskSource(manifest-yaml)", () => {
  it("returns a ManifestYamlSource", () => {
    const s = createTaskSource("manifest-yaml");
    expect(s.kind).toBe("manifest-yaml");
    expect(s).toBeInstanceOf(ManifestYamlSource);
  });
});

describe("TaskSpec shape", () => {
  it("agentCategory is one of the 6; rubric valid", () => {
    const specs = parseManifestYaml(
      SAMPLE_MANIFEST,
      ctx({ projectDir: "/tmp/x" }),
    );
    const cats = new Set([
      "coding",
      "research",
      "general",
      "browser",
      "data",
      "conversational",
    ]);
    for (const s of specs as TaskSpec[]) {
      expect(cats.has(s.agentCategory!)).toBe(true);
      expect(validateTaskSpec(s).ok).toBe(true);
    }
  });
});
