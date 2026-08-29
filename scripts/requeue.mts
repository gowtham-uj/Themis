import Database from "better-sqlite3";
import { migrate } from "../src/db/sqlite/migrate.js";
import { SqliteJudgeJobRepository } from "../src/db/sqlite/store.js";
const db = new Database("data/themis.sqlite");
migrate(db);
const jobs = new SqliteJudgeJobRepository(db);
const n = await jobs.requeueExpiredLeases({ now: new Date().toISOString(), maxLeaseAgeMs: 0, limit: 100 });
console.log("requeued", n);
db.close();
