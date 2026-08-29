/** WP-15 hot-path indexes match the claim/reap/outbox queries. */
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/sqlite/migrate.ts";
import { readFileSync } from "node:fs";

describe("WP-15 hot-path indexes", () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(":memory:"); migrate(db); });
  afterAll(() => db.close());

  it("claim index matches queue + priority DESC + keyset order", () => {
    const cols = db.prepare(`PRAGMA index_xinfo('idx_judge_jobs_claim')`).all() as Array<Record<string, unknown>>;
    const keys = cols.filter((r) => Number(r.key) === 1).map((r) => ({ name: r.name, desc: r.desc }));
    expect(keys.slice(0, 5)).toEqual([
      { name: "judge_queue_id", desc: 0 },
      { name: "priority", desc: 1 },
      { name: "available_at", desc: 0 },
      { name: "created_at", desc: 0 },
      { name: "id", desc: 0 },
    ]);
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='idx_judge_jobs_claim'`).get() as { sql: string }).sql;
    expect(sql).toContain("WHERE state IN ('queued', 'waiting_retry')");
  });

  it("reap/outbox indexes are partial (no terminal/dead rows)", () => {
    const reap = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='idx_judge_jobs_reap'`).get() as { sql: string }).sql;
    const out = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='idx_outbox_pending'`).get() as { sql: string }).sql;
    expect(reap).toContain("WHERE state IN ('leased', 'running', 'sealing')");
    expect(out).toContain("WHERE delivered_at IS NULL");
  });

  it("PostgreSQL migration carries the same plan-shape indexes", () => {
    const src = readFileSync("src/db/postgres/migrate.ts", "utf8");
    expect(src).toContain("idx_judge_jobs_claim");
    expect(src).toContain("judge_queue_id, priority DESC, available_at, created_at, id");
    expect(src).toContain("idx_outbox_pending");
    expect(src).toContain("WHERE delivered_at IS NULL");
  });
});
