import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db/sqlite/migrate.ts";
import { enqueueOutboxEvent } from "../src/db/sqlite/outbox.ts";
import { SqliteJudgeJobRepository } from "../src/db/sqlite/store.ts";
import { OutboxRelay } from "../src/judge/worker/outbox-relay.ts";

const NOW = "2026-08-22T20:00:00.000Z";

function sealedPayload(runId: string) {
  return {
    judgeQueueId: "jq_1",
    judgeQueueGenerationId: "jqg_1",
    sourceTriggerId: `trig_${runId}`,
    configSnapshotId: "cfg_1",
    configSnapshotSha256: "ab".repeat(32),
    runId,
    projectId: "proj_1",
    baseArchiveGenerationId: "gen_1",
    baseManifestSha256: "cd".repeat(32),
    trackId: "track_1",
    availableAt: NOW,
  };
}

describe("OutboxRelay", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });
  afterEach(() => {
    if (db.open) db.close();
  });

  it("delivers archive.sealed into an idempotent judge job", async () => {
    enqueueOutboxEvent(db, {
      aggregateType: "archive",
      aggregateId: "run_a",
      eventType: "archive.sealed",
      payload: sealedPayload("run_a"),
      availableAt: NOW,
    });
    const relay = new OutboxRelay(db);
    const t1 = await relay.tick({ now: NOW, workerId: "w1", leaseMs: 60_000 });
    expect(t1.claimed).toBe(1);
    expect(t1.delivered).toBe(1);
    expect(t1.errors).toEqual([]);

    const jobs = new SqliteJudgeJobRepository(db);
    // claim to prove job exists and is claimable
    const claim = await jobs.claimNext("jq_1", {
      now: NOW,
      leaseMs: 60_000,
      workerId: "worker",
    });
    expect(claim?.job.runId).toBe("run_a");

    // re-enqueue same trigger identity via new outbox row with same logical key fields
    enqueueOutboxEvent(db, {
      aggregateType: "archive",
      aggregateId: "run_a",
      eventType: "archive.sealed",
      payload: sealedPayload("run_a"),
      availableAt: NOW,
    });
    // same outbox unique key → created false; nothing new to claim
    const t2 = await relay.tick({ now: NOW, workerId: "w1", leaseMs: 60_000 });
    expect(t2.claimed).toBe(0);
  });
});
