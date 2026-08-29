import Database from "better-sqlite3";
import { OutboxRelay } from "../src/judge/worker/outbox-relay.js";
const db = new Database(process.argv[2] ?? "data/themis.sqlite");
const relay = new OutboxRelay(db);
const r = await relay.tick({ now: new Date().toISOString(), workerId: "e2e", leaseMs: 60_000, limit: 100 });
console.log(JSON.stringify(r));
db.close();
