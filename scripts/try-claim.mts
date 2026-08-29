import Database from "better-sqlite3";
const { SqliteJudgeJobRepository } = await import("/work/agenteval/src/db/sqlite/store.js");
const db = new Database("/work/agenteval/data/themis.sqlite");
const jobs = new SqliteJudgeJobRepository(db);
const c = await jobs.claimNext(process.argv[2], { now: new Date().toISOString(), leaseMs: 60000, workerId: "probe" });
console.log(c ? `CLAIMED ${c.job.runId.slice(0,8)}` : "NOTHING CLAIMABLE (paused)");
db.close();
