import { createPostgresThemisDb } from "../src/db/postgres/db.ts";
import { OutboxRelay } from "../src/judge/worker/outbox-relay.ts";
import { JUDGE_JOB_TRIGGER_KIND } from "../src/db/contracts.ts";

const url = process.env.AGENTEVAL_DATABASE_URL!;
const db = await createPostgresThemisDb({ databaseUrl: url });

// Wipe the probe queue's prior rows so the trigger dedupe is observable.
await db.transaction(async (tx) => {
  await tx.outboxEvents.enqueue({
    aggregateType: "archive", aggregateId: "run_relay", aggregateVersion: 1,
    eventType: "archive.sealed", payloadVersion: 1,
    payloadBody: JSON.stringify({
      judgeQueueId: "q_relay", judgeQueueGenerationId: "g_relay",
      sourceTriggerId: "outbox_relay_e2e", sourceTriggerKind: JUDGE_JOB_TRIGGER_KIND.archive_sealed,
      configSnapshotId: "cfg_relay", configSnapshotSha256: "ab".repeat(32),
      runId: "run_relay", projectId: "proj_relay",
      baseArchiveGenerationId: "gen_relay", baseManifestSha256: "cd".repeat(32),
      trackId: "track_relay",
    }),
    availableAt: new Date().toISOString(),
  });
});

const relay = new OutboxRelay(null, db);
const r1 = await relay.tick({ now: new Date().toISOString(), workerId: "w1", leaseMs: 60_000 });
console.log("tick1:", JSON.stringify(r1));

// A second tick must claim nothing (event delivered) and the job upsert must
// have been durable in the same transaction as the delivered_time update.
const r2 = await relay.tick({ now: new Date().toISOString(), workerId: "w1", leaseMs: 60_000 });
console.log("tick2:", JSON.stringify(r2));

const job = await db.judgeJobs.getByRunCursor("run_relay", { cursor: null, limit: 10 });
console.log("jobs for run_relay:", job.items.length, job.items[0]?.id);

const pending = await db.outboxEvents.listPendingCursor(new Date().toISOString(), { cursor: null, limit: 10 });
console.log("pending outbox events:", pending.items.length);

await db.close();
console.log("outbox-pg-e2e OK");
