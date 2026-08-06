import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProjectCtx, TaskSpec } from "../src/domain.ts";
import {
  buildTaskSpec,
  createMemoryTaskStore,
  createTaskSource,
  RepoMdSource,
  rubricsEqual,
  splitFrontmatter,
  syncTasks,
  UIBuilderSource,
  validateTaskSpec,
} from "../src/tasks/index.ts";
import { parseYamlSubset } from "../src/tasks/parse-frontmatter.ts";
import { frontmatterToTaskSpec } from "../src/tasks/repo-md.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesEvals = join(here, "fixtures", "evals");

function ctx(partial: Partial<ProjectCtx> & Pick<ProjectCtx, "projectDir">): ProjectCtx {
  return {
    projectId: partial.projectId ?? "proj-1",
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

describe("splitFrontmatter", () => {
  it("parses YAML frontmatter + body", () => {
    const text = `---
name: demo
tags:
  - a
  - b
nested:
  x: 1
  y: true
---
Body line one
Body line two
`;
    const { frontmatter, body, warnings } = splitFrontmatter(text);
    expect(warnings).toEqual([]);
    expect(frontmatter.name).toBe("demo");
    expect(frontmatter.tags).toEqual(["a", "b"]);
    expect(frontmatter.nested).toEqual({ x: 1, y: true });
    expect(body.trim()).toBe("Body line one\nBody line two");
  });

  it("files without frontmatter → empty record + full body", () => {
    const text = "Just a prompt with no fence.\nSecond line.";
    const { frontmatter, body, warnings } = splitFrontmatter(text);
    expect(frontmatter).toEqual({});
    expect(body).toBe(text);
    expect(warnings).toEqual([]);
  });

  it("tolerates malformed YAML (warn, not throw)", () => {
    const text = `---
name: broken
this line has no colon and is garbage
: also bad
criteria:
  - id: A1
    axis: A
    label: ok
    weight: 1
    appliesTo: both
    anchors:
      full: f
      partial: p
      none: n
---
prompt body
`;
    const result = splitFrontmatter(text);
    expect(result.body.trim()).toBe("prompt body");
    // Should not throw; may have warnings about malformed lines.
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.frontmatter.name).toBe("broken");
    // Still recovered the criteria array where possible.
    expect(Array.isArray(result.frontmatter.criteria)).toBe(true);
  });

  it("parseYamlSubset never throws on garbage", () => {
    const { value, warnings } = parseYamlSubset(":::not yaml:::\n[[[");
    expect(value).toBeDefined();
    expect(Array.isArray(warnings)).toBe(true);
  });
});

describe("RepoMdSource", () => {
  it("parses hello.md fixture → TaskSpec with rubric, anchors, tags", async () => {
    // workspaceDir points at tests/ so glob evals/**/*.md finds fixtures/evals.
    // Our fixtures live at tests/fixtures/evals — use a temp workspace that
    // mirrors the expected layout, or point glob at fixtures/evals.
    const source = new RepoMdSource({ glob: "evals/**/*.md" });
    // fixtures root is tests/fixtures; put workspaceDir = tests/fixtures
    const tasks = await collect(
      source.list(
        ctx({
          projectDir: "/tmp/unused",
          workspaceDir: join(here, "fixtures"),
        }),
      ),
    );

    const hello = tasks.find((t) => t.id === "evals/hello.md" || t.name === "Hello world");
    expect(hello).toBeDefined();
    expect(hello!.name).toBe("Hello world");
    expect(hello!.prompt).toContain("Hello, world!");
    expect(hello!.workspace).toEqual({
      source: "git",
      repo: "example/hello",
      ref: "main",
    });
    expect(hello!.tags).toEqual(["smoke", "beginner"]);
    expect(hello!.profile).toBe("feature");
    expect(hello!.agentCategory).toBe("coding");
    expect(hello!.rubric.criteria.length).toBe(1);
    const c = hello!.rubric.criteria[0]!;
    expect(c.id).toBe("A1");
    expect(c.axis).toBe("A");
    expect(c.critical).toBe(true);
    expect(c.anchors.full).toMatch(/Hello, world!/);
    expect(c.anchors.partial).toBeTruthy();
    expect(c.anchors.none).toBeTruthy();
    expect(c.checkId).toBe("tests");
    expect(hello!.checks?.[0]?.id).toBe("tests");
    expect(hello!.id).toBe("evals/hello.md");

    const v = validateTaskSpec(hello!);
    expect(v.ok).toBe(true);
  });

  it("parses multi-criterion.md with multiple criteria", async () => {
    const source = new RepoMdSource({ glob: "evals/**/*.md" });
    const tasks = await collect(
      source.list(
        ctx({
          projectDir: "/tmp/unused",
          workspaceDir: join(here, "fixtures"),
        }),
      ),
    );
    const multi = tasks.find((t) => t.name === "Multi-criterion refactor");
    expect(multi).toBeDefined();
    expect(multi!.rubric.criteria.length).toBe(3);
    expect(multi!.rubric.criteria.map((c) => c.id)).toEqual(["A1", "G1", "D1"]);
    expect(multi!.rubric.version).toBe(2);
    // Body used as prompt (no frontmatter.prompt).
    expect(multi!.prompt).toMatch(/Refactor the authentication module/);
    expect(multi!.workspace).toEqual({ source: "empty" });
    expect(multi!.tags).toEqual(["refactor", "quality"]);
    const v = validateTaskSpec(multi!);
    expect(v.ok).toBe(true);
  });

  it("file without frontmatter → body becomes prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenteval-repo-md-"));
    const evals = join(dir, "evals");
    await mkdir(evals, { recursive: true });
    await writeFile(
      join(evals, "plain.md"),
      "Please implement a binary search helper.\nKeep it O(log n).\n",
      "utf8",
    );

    const source = new RepoMdSource();
    const tasks = await collect(
      source.list(ctx({ projectDir: dir, workspaceDir: dir })),
    );
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.prompt).toContain("binary search");
    expect(tasks[0]!.name).toBe("plain");
    // No criteria → invalid for validate, but still yielded.
    const v = source.validate!(tasks[0]!);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /criterion/i.test(e))).toBe(true);
  });

  it("frontmatterToTaskSpec uses body when prompt omitted", () => {
    const spec = frontmatterToTaskSpec(
      {
        name: "From body",
        workspace: { source: "empty" },
        rubric: {
          profile: "general",
          version: 1,
          criteria: [
            {
              id: "A1",
              axis: "A",
              label: "Goal",
              weight: 1,
              appliesTo: "both",
              anchors: { full: "f", partial: "p", none: "n" },
            },
          ],
        },
      },
      "  Body becomes the prompt.  \n",
      "evals/x.md",
      ctx({ projectDir: "/tmp" }),
    );
    expect(spec.prompt).toBe("Body becomes the prompt.");
    expect(spec.id).toBe("evals/x.md");
  });
});

describe("validateTaskSpec", () => {
  const goodCriterion = {
    id: "A1",
    axis: "A" as const,
    label: "Goal",
    weight: 1,
    appliesTo: "both" as const,
    anchors: { full: "done", partial: "half", none: "miss" },
  };

  it("rejects empty prompt", () => {
    const v = validateTaskSpec({
      name: "x",
      prompt: "   ",
      workspace: { source: "empty" },
      rubric: { criteria: [goodCriterion], profile: "general", version: 1 },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /prompt/i.test(e))).toBe(true);
  });

  it("rejects rubric with no criteria", () => {
    const v = validateTaskSpec({
      name: "x",
      prompt: "do the thing",
      workspace: { source: "empty" },
      rubric: { criteria: [], profile: "general", version: 1 },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /criterion/i.test(e))).toBe(true);
  });

  it("rejects missing anchors", () => {
    const v = validateTaskSpec({
      name: "x",
      prompt: "do the thing",
      workspace: { source: "empty" },
      rubric: {
        criteria: [
          {
            ...goodCriterion,
            anchors: { full: "", partial: "p", none: "n" },
          },
        ],
        profile: "general",
        version: 1,
      },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /anchors\.full/i.test(e))).toBe(true);
  });
});

describe("UIBuilderSource / buildTaskSpec", () => {
  it("buildTaskSpec happy path", () => {
    const spec = buildTaskSpec({
      name: "UI task",
      prompt: "Build a REST endpoint",
      workspace: { source: "git", repo: "acme/api" },
      tags: ["api"],
      profile: "feature",
      rubric: {
        profile: "feature",
        criteria: [
          {
            id: "A1",
            axis: "A",
            label: "Goal completion",
            weight: 1,
            critical: true,
            appliesTo: "both",
            anchors: {
              full: "Endpoint works end-to-end",
              partial: "Partial implementation",
              none: "Missing",
            },
          },
        ],
      },
    });
    expect(spec.name).toBe("UI task");
    expect(spec.prompt).toBe("Build a REST endpoint");
    expect(spec.rubric.criteria).toHaveLength(1);
    expect(spec.profile).toBe("feature");
  });

  it("buildTaskSpec rejects empty prompt", () => {
    expect(() =>
      buildTaskSpec({
        name: "bad",
        prompt: "",
        rubric: {
          criteria: [
            {
              id: "A1",
              axis: "A",
              label: "G",
              weight: 1,
              appliesTo: "both",
              anchors: { full: "f", partial: "p", none: "n" },
            },
          ],
        },
      }),
    ).toThrow(/prompt/i);
  });

  it("buildTaskSpec rejects rubric with no criteria", () => {
    expect(() =>
      buildTaskSpec({
        name: "bad",
        prompt: "something",
        rubric: { criteria: [] },
      }),
    ).toThrow(/criterion/i);
  });

  it("list() reads task.json under projectDir/tasks/<tid>/", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "agenteval-ui-builder-"));
    const tid = "t-abc";
    const taskDir = join(projectDir, "tasks", tid);
    await mkdir(taskDir, { recursive: true });

    const stored = {
      id: tid,
      name: "Authored in UI",
      prompt: "Do the UI thing",
      workspace: { source: "empty" },
      rubric: {
        profile: "general",
        version: 1,
        criteria: [
          {
            id: "A1",
            axis: "A",
            label: "Goal",
            weight: 1,
            appliesTo: "both",
            anchors: { full: "f", partial: "p", none: "n" },
          },
        ],
      },
      tags: ["ui"],
    };
    await writeFile(join(taskDir, "task.json"), JSON.stringify(stored, null, 2), "utf8");

    const source = new UIBuilderSource();
    const tasks = await collect(source.list(ctx({ projectDir })));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.name).toBe("Authored in UI");
    expect(tasks[0]!.id).toBe(tid);
    expect(source.validate!(tasks[0]!).ok).toBe(true);
  });

  it("list() yields nothing when tasks/ is missing", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "agenteval-ui-empty-"));
    const source = new UIBuilderSource();
    const tasks = await collect(source.list(ctx({ projectDir })));
    expect(tasks).toEqual([]);
  });
});

describe("syncTasks", () => {
  it("upserts by external_id and bumps rubric_version on rubric change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenteval-sync-"));
    const evals = join(dir, "evals");
    await mkdir(evals, { recursive: true });

    const criterion = {
      id: "A1",
      axis: "A",
      label: "Goal",
      weight: 1,
      appliesTo: "both",
      anchors: { full: "f", partial: "p", none: "n" },
    };

    const md1 = `---
name: Sync me
prompt: first prompt
workspace:
  source: empty
rubric:
  profile: general
  version: 1
  criteria:
    - id: A1
      axis: A
      label: Goal
      weight: 1
      appliesTo: both
      anchors:
        full: full v1
        partial: partial
        none: none
---
`;
    await writeFile(join(evals, "sync.md"), md1, "utf8");

    const store = createMemoryTaskStore();
    const source = new RepoMdSource();
    const projectCtx = ctx({ projectDir: dir, workspaceDir: dir });

    const r1 = await syncTasks(projectCtx, source, store);
    expect(r1.upserted).toHaveLength(1);
    expect(r1.upserted[0]!.rubricVersionBumped).toBe(false);
    expect(r1.invalid).toHaveLength(0);

    const got1 = store.get("proj-1", "evals/sync.md");
    expect(got1).not.toBeNull();
    expect(got1!.rubric.version).toBe(1);

    // Edit rubric anchors → re-sync should bump.
    const md2 = md1.replace("full v1", "full v2 — stricter");
    await writeFile(join(evals, "sync.md"), md2, "utf8");

    const r2 = await syncTasks(projectCtx, source, store);
    expect(r2.upserted).toHaveLength(1);
    expect(r2.upserted[0]!.rubricVersionBumped).toBe(true);
    expect(r2.upserted[0]!.taskId).toBe(r1.upserted[0]!.taskId);

    const got2 = store.get("proj-1", "evals/sync.md");
    expect(got2!.rubric.version).toBe(2);
    expect(got2!.rubric.criteria[0]!.anchors.full).toMatch(/stricter/);

    // Same rubric again → no bump.
    const r3 = await syncTasks(projectCtx, source, store);
    expect(r3.upserted[0]!.rubricVersionBumped).toBe(false);
    expect(store.get("proj-1", "evals/sync.md")!.rubric.version).toBe(2);

    void criterion;
  });

  it("skips invalid specs by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenteval-sync-bad-"));
    const evals = join(dir, "evals");
    await mkdir(evals, { recursive: true });
    await writeFile(join(evals, "bad.md"), "no frontmatter, no rubric\n", "utf8");

    const store = createMemoryTaskStore();
    const r = await syncTasks(
      ctx({ projectDir: dir, workspaceDir: dir }),
      new RepoMdSource(),
      store,
    );
    expect(r.upserted).toHaveLength(0);
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0]!.validationErrors.length).toBeGreaterThan(0);
  });
});

describe("createTaskSource / helpers", () => {
  it("creates built-in sources by kind", () => {
    expect(createTaskSource("ui-builder").kind).toBe("ui-builder");
    expect(createTaskSource("repo-md").kind).toBe("repo-md");
  });

  it("rubricsEqual is stable to key order", () => {
    const a = {
      criteria: [
        {
          id: "A1",
          axis: "A" as const,
          label: "G",
          weight: 1,
          appliesTo: "both" as const,
          anchors: { full: "f", partial: "p", none: "n" },
        },
      ],
      profile: "general" as const,
      version: 1,
    };
    const b = {
      version: 1,
      profile: "general" as const,
      criteria: [
        {
          weight: 1,
          id: "A1",
          appliesTo: "both" as const,
          axis: "A" as const,
          label: "G",
          anchors: { none: "n", full: "f", partial: "p" },
        },
      ],
    };
    expect(rubricsEqual(a, b)).toBe(true);
  });
});

// Ensure fixtures path is loadable (sanity).
describe("fixtures", () => {
  it("hello.md and multi-criterion.md exist", async () => {
    const { readFile } = await import("node:fs/promises");
    const hello = await readFile(join(fixturesEvals, "hello.md"), "utf8");
    const multi = await readFile(join(fixturesEvals, "multi-criterion.md"), "utf8");
    expect(hello.startsWith("---")).toBe(true);
    expect(multi).toMatch(/criteria:/);
  });
});
