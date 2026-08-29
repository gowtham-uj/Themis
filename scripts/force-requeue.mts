import Database from "better-sqlite3";
import { migrate } from "/work/agenteval/src/db/sqlite/migrate.js";
import { SqliteJudgeJobRepository } from "/work/agenteval/src/db/sqlite/store.js";
const db = new Database("/work/agenteval/data/themis.sqlite");
migrate(db);
const jobs = new SqliteJudgeJobRepository(db);
const now = new Date(Date.now()+2*60*60*1000).toISOString();
console.log("requeued", await jobs.requeueExpiredLeases({now,maxLeaseAgeMs:0,limit:100}), "at", now);
db.close();
