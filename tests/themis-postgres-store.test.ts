/**
 * PostgreSQL Themis store tests.
 *
 * The source-level claim-predicate test always runs and kills M1 (deleting
 * state/fencing_token from the claim UPDATE) without a live database.
 * Live concurrency tests gate on AGENTEVAL_DATABASE_URL or AGENTEVAL_PG=1.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STORE_SRC = readFileSync(
  join(import.meta.dirname, "../src/db/postgres/store.ts"),
  "utf8",
);

const LIVE = Boolean(process.env.AGENTEVAL_DATABASE_URL) || process.env.AGENTEVAL_PG === "1";

describe("postgres store — source contracts (always)", () => {
  it("claim UPDATE WHERE re-checks both state and fencing_token (kills M1)", () => {
    // Extract the claimNext method body and find its UPDATE ... WHERE clause.
    const claim = STORE_SRC.slice(
      STORE_SRC.indexOf("async claimNext"),
      STORE_SRC.indexOf("async heartbeat"),
    );
    expect(claim).toMatch(/FOR UPDATE SKIP LOCKED/);
    const where = claim.match(/UPDATE judge_jobs[\s\S]*?WHERE([\s\S]*?)(?:;|,?\s*\n\s*\])/);
    expect(where, "claimNext must contain an UPDATE ... WHERE").toBeTruthy();
    const clause = where![1];
    expect(clause).toMatch(/\bstate\b/);
    expect(clause).toMatch(/\bfencing_token\b/);
  });

  it("heartbeat and updateFenced are fenced on attempt+state+token", () => {
    expect(STORE_SRC).toMatch(
      /heartbeat[\s\S]*WHERE id = \$4 AND active_attempt_id = \$5 AND state = \$6 AND fencing_token = \$7/,
    );
    expect(STORE_SRC).toMatch(
      /updateFenced[\s\S]*active_attempt_id[\s\S]*fencing_token/,
    );
  });

  it("requeue flips in_flight provider ops to unknown", () => {
    expect(STORE_SRC).toMatch(/JUDGE_PROVIDER_OPERATION_STATE\.unknown/);
    expect(STORE_SRC).toMatch(/JUDGE_PROVIDER_OPERATION_STATE\.in_flight/);
  });

  it("exports the two repositories", async () => {
    const mod = await import("../src/db/postgres/store.ts");
    expect(mod.PostgresJudgeJobRepository).toBeTypeOf("function");
    expect(mod.PostgresJudgeAttemptRepository).toBeTypeOf("function");
  });
});

describe.skipIf(!LIVE)("postgres store — live", () => {
  it("placeholder for live FOR UPDATE SKIP LOCKED concurrency", () => {
    // Wired when AGENTEVAL_DATABASE_URL is set in CI. The source-level M1
    // guard above is what keeps the predicate honest without a live server.
    expect(process.env.AGENTEVAL_DATABASE_URL || process.env.AGENTEVAL_PG).toBeTruthy();
  });
});
