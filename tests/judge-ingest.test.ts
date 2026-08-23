/**
 * Judge-queue ingestion store tests — the two locked flows:
 *   linked auto-judge ON  → streaming (each seal → outbox → job)
 *   linked auto-judge OFF → buffered, then one batch flush
 *   standalone             → submit archive run ids directly
 * Also: archive.sealed outbox → OutboxRelay → durable judge job (end-to-end
 * on the same SQLite, exercising the real relay against real rows).
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db/sqlite/migrate.ts";
import { claimOutboxEvent } from "../src/db/sqlite/outbox.ts";
import {
  countPending,
  flushPending,
  getLinkedJudgeQueue,
  linkJudgeQueue,
  onArchiveSealed,
  submitStandaloneArchives,
} from "../src/judge/ingest/store.ts";
import { OutboxRelay } from "../src/judge/worker/outbox-relay.ts";

const NOW = "2026-08-23T01:00:00.000Z";

function sealed(runId: string, evalQueueId: string) {
  return {
    runId,
    projectId: "proj",
    evalQueueId,
    baseManifestSha256: "ab".repeat(32),
  };
}

describe("judge queue ingestion", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });
  afterEach(() => {
    if (db.open) db.close();
  });

  it("auto-judge ON streams each sealed archive immediately", async () => {
    const q = linkJudgeQueue(db, {
      name: "linked",
      projectId: "proj",
      linkedEvalQueueId: "evalq_1",
      autoJudge: true,
    });
    const r1 = onArchiveSealed(db, sealed("run_1", "evalq_1"), NOW);
    expect(r1.action).toBe("streamed");
    expect(r1.judgeQueueId).toBe(q.id);

    // The streamed archive becomes an outbox event, then a durable judge job.
    const relay = new OutboxRelay(db);
    const tick = await relay.tick({ now: NOW, workerId: "w", leaseMs: 60_000 });
    expect(tick.delivered).toBe(1);
    expect(tick.errors).toEqual([]);
  });

  it("auto-judge OFF buffers, then one flush streams all", () => {
    const q = linkJudgeQueue(db, {
      name: "buffered",
      projectId: "proj",
      linkedEvalQueueId: "evalq_2",
      autoJudge: false,
    });
    expect(onArchiveSealed(db, sealed("run_a", "evalq_2"), NOW).action).toBe("buffered");
    expect(onArchiveSealed(db, sealed("run_b", "evalq_2"), NOW).action).toBe("buffered");
    expect(countPending(db, q.id)).toBe(2);

    // No outbox events yet (nothing streamed).
    expect(claimOutboxEvent(db, { now: NOW, leaseMs: 60_000, workerId: "w" })).toBeNull();

    const flushed = flushPending(db, q.id, NOW);
    expect(flushed).toHaveLength(2);
    expect(countPending(db, q.id)).toBe(0);
    // Both are now outbox events.
    expect(claimOutboxEvent(db, { now: NOW, leaseMs: 60_000, workerId: "w" })).not.toBeNull();
    expect(claimOutboxEvent(db, { now: NOW, leaseMs: 60_000, workerId: "w" })).not.toBeNull();
  });

  it("no linked judge queue → no-op", () => {
    expect(onArchiveSealed(db, sealed("run_x", "evalq_none"), NOW).action).toBe("no_linked_queue");
  });

  it("standalone submit enqueues archive run ids directly", () => {
    const q = linkJudgeQueue(db, {
      name: "standalone",
      projectId: "proj",
      linkedEvalQueueId: "evalq_3",
      autoJudge: false,
    });
    const results = submitStandaloneArchives(db, q.id, [
      { runId: "run_s1", projectId: "proj", evalQueueId: null, baseManifestSha256: "cd".repeat(32) },
      { runId: "run_s2", projectId: "proj", evalQueueId: null, baseManifestSha256: "cd".repeat(32) },
    ]);
    expect(results).toHaveLength(2);
    expect(getLinkedJudgeQueue(db, "evalq_3")?.id).toBe(q.id);
  });
});
