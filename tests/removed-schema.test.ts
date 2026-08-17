/** Schema migration removes legacy judge and reusable-rubric tables. */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";

const REMOVED_TABLES = [
  "finding_occurrences",
  "findings",
  "improvement_steps",
  "scores",
  "judgements",
  "queue_analyses",
  "project_rubrics",
  // Outbound webhooks (P8c) removed from the API-only backend.
  "outbound_subscriptions",
  "webhook_deliveries",
];

describe("removed persistence surfaces", () => {
  it("drops legacy tables while retaining the API-only schema", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE judgements (id TEXT PRIMARY KEY)");
      db.exec("CREATE TABLE project_rubrics (id TEXT PRIMARY KEY)");
      db.exec("CREATE TABLE outbound_subscriptions (id TEXT PRIMARY KEY)");
      db.exec("CREATE TABLE webhook_deliveries (id TEXT PRIMARY KEY)");
      migrate(db);
      const names = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      for (const table of REMOVED_TABLES) expect(names.has(table), table).toBe(false);
      expect(names.has("eval_archives")).toBe(true);
      expect(names.has("eval_queues")).toBe(true);
      expect(Number(db.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
