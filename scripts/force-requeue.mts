import Database from "better-sqlite3";
import { migrate } from "../src/db/sqlite/migrate.js";
import { SqliteJudgeJobRepository } from "../src/db/sqlite/store.js";
const db = new Database(new URL("../data/themis.sqlite", import.meta.url).pathname);
migrate(db);
const jobs = new SqliteJudgeJobRepository(db);
const now = new Date(Date.now()+2*60*60*1000).toISOString();
console.log("requeued", await jobs.requeueExpiredLeases({now,maxLeaseAgeMs:0,limit:100}), "at", now);
db.close();
