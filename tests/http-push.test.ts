import { afterEach, describe, expect, it } from "vitest";
import type { ProjectCtx, TaskSpec } from "../src/domain.ts";
import {
  createMemoryTaskStore,
  createTaskSource,
  HttpPushSource,
  pushHttpTask,
  resetHttpPushStore,
  syncTasks,
  validateTaskSpec,
} from "../src/tasks/index.ts";

function ctx(projectId = "proj-push"): ProjectCtx {
  return {
    projectId,
    projectDir: `/tmp/${projectId}`,
    defaultAgentCategory: "coding",
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

function validSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: overrides.id ?? "push-1",
    name: overrides.name ?? "Pushed task",
    prompt: overrides.prompt ?? "Do the thing",
    workspace: overrides.workspace ?? { source: "empty" },
    agentCategory: overrides.agentCategory ?? "conversational",
    tags: overrides.tags ?? ["push"],
    profile: overrides.profile ?? "conversational",
    rubric: overrides.rubric ?? {
      profile: "conversational",
      version: 1,
      criteria: [
        {
          id: "A1",
          axis: "A",
          label: "Helpful",
          weight: 1,
          appliesTo: "both",
          anchors: {
            full: "fully helpful",
            partial: "somewhat helpful",
            none: "unhelpful",
          },
        },
      ],
    },
    ...overrides,
  };
}

afterEach(() => {
  resetHttpPushStore();
});

describe("HttpPushSource", () => {
  it("push a task → it persists + is listable", async () => {
    const source = new HttpPushSource();
    const pushed = source.push("proj-push", validSpec({ id: "p1" }));
    expect(pushed.id).toBe("p1");
    expect(validateTaskSpec(pushed).ok).toBe(true);

    const listed = await collect(source.list(ctx("proj-push")));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe("p1");
    expect(listed[0]!.name).toBe("Pushed task");
    expect(listed[0]!.agentCategory).toBe("conversational");

    expect(source.get("proj-push", "p1")?.prompt).toBe("Do the thing");
  });

  it("re-push same id updates", async () => {
    const source = new HttpPushSource();
    source.push("proj-push", validSpec({ id: "p1", prompt: "v1" }));
    source.push(
      "proj-push",
      validSpec({ id: "p1", prompt: "v2", name: "Updated" }),
    );

    const listed = await collect(source.list(ctx("proj-push")));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.prompt).toBe("v2");
    expect(listed[0]!.name).toBe("Updated");
  });

  it("tasks are mutable via push (replace fields)", () => {
    const source = new HttpPushSource();
    source.push(
      "proj-push",
      validSpec({ id: "m1", tags: ["a"], agentCategory: "general" }),
    );
    const updated = source.push(
      "proj-push",
      validSpec({
        id: "m1",
        tags: ["a", "b"],
        agentCategory: "browser",
        prompt: "new prompt",
      }),
    );
    expect(updated.tags).toEqual(["a", "b"]);
    expect(updated.agentCategory).toBe("browser");
    expect(updated.prompt).toBe("new prompt");
  });

  it("list is empty for unknown project; no auto-drop of other projects", async () => {
    const source = new HttpPushSource();
    source.push("proj-a", validSpec({ id: "a1" }));
    source.push("proj-b", validSpec({ id: "b1" }));

    expect(await collect(source.list(ctx("proj-a")))).toHaveLength(1);
    expect(await collect(source.list(ctx("proj-b")))).toHaveLength(1);
    expect(await collect(source.list(ctx("proj-c")))).toHaveLength(0);
  });

  it("syncTasks re-yields pushed tasks into a store", async () => {
    const source = new HttpPushSource();
    source.push("proj-push", validSpec({ id: "s1" }));
    source.push("proj-push", validSpec({ id: "s2", name: "Second" }));

    const store = createMemoryTaskStore();
    const result = await syncTasks(ctx("proj-push"), source, store);
    expect(result.sourceKind).toBe("http-push");
    expect(result.upserted).toHaveLength(2);
    expect(store.get("proj-push", "s1")).not.toBeNull();
    expect(store.get("proj-push", "s2")?.name).toBe("Second");
  });
});

describe("pushHttpTask + shared store", () => {
  it("pushHttpTask uses the shared process store", async () => {
    const pushed = pushHttpTask("proj-shared", validSpec({ id: "shared-1" }));
    expect(pushed.id).toBe("shared-1");

    // A freshly constructed source with the default shared store sees it.
    const source = new HttpPushSource();
    const listed = await collect(source.list(ctx("proj-shared")));
    expect(listed.map((t) => t.id)).toContain("shared-1");
  });
});

describe("createTaskSource(http-push)", () => {
  it("returns an HttpPushSource", () => {
    const s = createTaskSource("http-push");
    expect(s.kind).toBe("http-push");
    expect(s).toBeInstanceOf(HttpPushSource);
  });

  it("createTaskSource returns the right source per kind", () => {
    expect(createTaskSource("ui-builder").kind).toBe("ui-builder");
    expect(createTaskSource("repo-md").kind).toBe("repo-md");
    expect(createTaskSource("manifest-yaml").kind).toBe("manifest-yaml");
    expect(createTaskSource("ci-artifact").kind).toBe("ci-artifact");
    expect(createTaskSource("http-push").kind).toBe("http-push");
  });
});
