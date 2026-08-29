import Database from "better-sqlite3";
import { migrate } from "../src/db/sqlite/migrate.js";
import { JudgeClaimWorker } from "../src/judge/worker/claim-worker.js";

const db = new Database("data/themis.sqlite");
migrate(db);
const worker = new JudgeClaimWorker({
  themisDbPath: "data/themis.sqlite",
  archivesRoot: "data/archives",
});
const result = await worker.tick({
  judgeQueueId: process.argv[2],
  claim: { now: new Date().toISOString(), leaseMs: 300_000, workerId: "e2e-worker" },
});
console.log(JSON.stringify(result));
worker.close();
