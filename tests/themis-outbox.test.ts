/**
 * WP-5 outbox + judge queue sqlite slice.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db/sqlite/migrate.ts";
import {
  claimOutboxEvent,
  createJudgeQueue,
  enqueueOutboxEvent,
  getJudgeQueue,
  markOutboxDelivered,
} from "../src/db/sqlite/outbox.ts";

describe("WP-5 outbox + judge queues", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });
  afterEach(() => {
    if (db.open) db.close();
  });

  it("creates a judge queue", () => {
    const q = createJudgeQueue(db, { projectId: "proj", name: "auto" });
    expect(getJudgeQueue(db, q.id)?.name).toBe("auto");
  });

  it("enqueue is idempotent on aggregate identity", () => {
    const a = enqueueOutboxEvent(db, {
      aggregateType: "archive",
      aggregateId: "run_1",
      eventType: "archive.sealed",
      payload: { runId: "run_1" },
    });
    const b = enqueueOutboxEvent(db, {
      aggregateType: "archive",
      aggregateId: "run_1",
      eventType: "archive.sealed",
      payload: { runId: "run_1" },
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.event.id).toBe(a.event.id);
  });

  it("claims an undelivered event once, then marks delivered", () => {
    const now = "2026-08-22T00:00:00.000Z";
    enqueueOutboxEvent(db, {
      aggregateType: "archive",
      aggregateId: "run_2",
      eventType: "archive.sealed",
      payload: { runId: "run_2" },
      availableAt: now,
    });
    const c1 = claimOutboxEvent(db, { now, leaseMs: 60_000, workerId: "w1" });
    expect(c1?.aggregateId).toBe("run_2");
    expect(markOutboxDelivered(db, c1!.id, now)).toBe(true);
    expect(claimOutboxEvent(db, { now, leaseMs: 60_000, workerId: "w2" })).toBeNull();
  });
});
