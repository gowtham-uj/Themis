import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db/sqlite/migrate.ts";
import { advanceCurrentPointer, getCurrentPointer } from "../src/db/sqlite/pointers.ts";

describe("WP-12 current pointer CAS", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });
  afterEach(() => {
    if (db.open) db.close();
  });

  it("inserts when expected is null and rejects second insert", () => {
    const a = advanceCurrentPointer(db, {
      runId: "run",
      trackId: "track",
      resultVersionId: "v1",
      archiveViewPath: "/v1",
      baseManifestSha256: "aa".repeat(32),
      expectedResultVersionId: null,
    });
    expect(a.advanced).toBe(true);
    const b = advanceCurrentPointer(db, {
      runId: "run",
      trackId: "track",
      resultVersionId: "v2",
      archiveViewPath: "/v2",
      baseManifestSha256: "aa".repeat(32),
      expectedResultVersionId: null,
    });
    expect(b.advanced).toBe(false);
    expect(getCurrentPointer(db, "run", "track")?.resultVersionId).toBe("v1");
  });

  it("CAS advances only with matching expected id + base hash", () => {
    advanceCurrentPointer(db, {
      runId: "run",
      trackId: "track",
      resultVersionId: "v1",
      archiveViewPath: "/v1",
      baseManifestSha256: "aa".repeat(32),
      expectedResultVersionId: null,
    });
    const bad = advanceCurrentPointer(db, {
      runId: "run",
      trackId: "track",
      resultVersionId: "v2",
      archiveViewPath: "/v2",
      baseManifestSha256: "aa".repeat(32),
      expectedResultVersionId: "wrong",
    });
    expect(bad.advanced).toBe(false);
    const ok = advanceCurrentPointer(db, {
      runId: "run",
      trackId: "track",
      resultVersionId: "v2",
      archiveViewPath: "/v2",
      baseManifestSha256: "aa".repeat(32),
      expectedResultVersionId: "v1",
    });
    expect(ok.advanced).toBe(true);
    expect(ok.pointer?.resultVersionId).toBe("v2");
  });
});
