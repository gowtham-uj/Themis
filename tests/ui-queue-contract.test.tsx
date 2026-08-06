/**
 * Eval-queue UI pure-helper contract tests (P8c-UI).
 *
 * Pins formatQueueTarget / order labels / status chips / poll predicate so
 * future edits keep the wire contract. No full React rendering.
 */
import { describe, expect, it } from "vitest";
import {
  formatQueueOrderLabel,
  formatQueueTarget,
  isQueueEntryActive,
  queueStatusColor,
  queueStatusLabel,
  shouldPollQueue,
} from "../src/ui/app/projects/[id]/queue/QueueClient.js";
import type { QueueEntry } from "../src/ui/lib/api.js";

function entry(partial: Partial<QueueEntry> & { id: string }): QueueEntry {
  return {
    projectId: "proj-1",
    agentId: "pi",
    priority: 0,
    position: 0,
    status: "queued",
    ...partial,
  };
}

describe("formatQueueTarget", () => {
  it("prefers task id", () => {
    expect(
      formatQueueTarget(entry({ id: "e1", taskId: "task-42" })),
    ).toBe("task:task-42");
  });

  it("formats tags for a task-set", () => {
    expect(
      formatQueueTarget(
        entry({ id: "e2", taskTags: ["smoke", "regression"] }),
      ),
    ).toBe("tags:smoke,regression");
  });

  it("falls back to kind@ref or bare kind", () => {
    expect(
      formatQueueTarget(
        entry({ id: "e3", targetKind: "task_set", triggerRef: "v1.2.3" }),
      ),
    ).toBe("task_set@v1.2.3");
    expect(formatQueueTarget(entry({ id: "e4" }))).toBe("task_set");
  });
});

describe("queue order labels", () => {
  it("renders P{priority} · pos {position}", () => {
    expect(
      formatQueueOrderLabel({ priority: 10, position: 0.5 }),
    ).toBe("P10 · pos 0.5");
    expect(formatQueueOrderLabel({ priority: 0, position: 0 })).toBe(
      "P0 · pos 0",
    );
  });
});

describe("queue status chips", () => {
  it("labels match the known status set", () => {
    for (const s of ["queued", "promoted", "running", "removed", "failed"]) {
      expect(queueStatusLabel(s)).toBe(s);
    }
  });

  it("colors are border-accented (colorblind-safe, not hue alone)", () => {
    expect(queueStatusColor("queued")).toContain("border-");
    expect(queueStatusColor("running")).toContain("border-");
    expect(queueStatusColor("failed")).toContain("border-");
    expect(queueStatusColor("promoted")).toContain("border-");
  });
});

describe("active / poll predicate", () => {
  it("queued/promoted/running are active; removed/failed are terminal", () => {
    expect(isQueueEntryActive("queued")).toBe(true);
    expect(isQueueEntryActive("promoted")).toBe(true);
    expect(isQueueEntryActive("running")).toBe(true);
    expect(isQueueEntryActive("removed")).toBe(false);
    expect(isQueueEntryActive("failed")).toBe(false);
  });

  it("shouldPollQueue is true iff any entry is active", () => {
    expect(
      shouldPollQueue([entry({ id: "a", status: "removed" })]),
    ).toBe(false);
    expect(
      shouldPollQueue([
        entry({ id: "a", status: "removed" }),
        entry({ id: "b", status: "queued" }),
      ]),
    ).toBe(true);
    expect(shouldPollQueue([])).toBe(false);
  });
});
