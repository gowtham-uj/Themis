import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db/sqlite/migrate.ts";
import {
  getResultVersion,
  listResultVersionsByRun,
  resultVersionCursor,
  upsertResultVersion,
} from "../src/db/sqlite/results.ts";

describe("WP-11 judge_result_versions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });
  afterEach(() => {
    if (db.open) db.close();
  });

  it("upserts and lists by run", () => {
    const v = upsertResultVersion(db, {
      runId: "run_1",
      trackId: "track",
      reportSha256: "ab".repeat(32),
      reportPath: "/tmp/judge/evalJudge.json",
      archiveViewPath: "/tmp/view",
      publicationState: "published",
      schemaVersion: 1,
    });
    expect(getResultVersion(db, v.id)?.runId).toBe("run_1");
    expect(listResultVersionsByRun(db, "run_1")).toHaveLength(1);
  });

  it("keyset cursor does not repeat the last item", () => {
    const a = upsertResultVersion(db, {
      id: "jrv_a",
      runId: "run_2",
      trackId: "track",
      reportSha256: "aa".repeat(32),
      reportPath: "/a",
      archiveViewPath: null,
      publicationState: "published",
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    upsertResultVersion(db, {
      id: "jrv_b",
      runId: "run_2",
      trackId: "track",
      reportSha256: "bb".repeat(32),
      reportPath: "/b",
      archiveViewPath: null,
      publicationState: "published",
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const page1 = listResultVersionsByRun(db, "run_2", { limit: 1 });
    expect(page1.map((x) => x.id)).toEqual(["jrv_a"]);
    const page2 = listResultVersionsByRun(db, "run_2", {
      limit: 10,
      cursor: resultVersionCursor(page1[0]!),
    });
    expect(page2.map((x) => x.id)).toEqual(["jrv_b"]);
    expect(a.id).toBe("jrv_a");
  });
});
