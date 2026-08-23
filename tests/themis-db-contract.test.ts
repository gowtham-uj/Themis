/**
 * WP-1 contract tests: `src/db/contracts.ts` (async Themis persistence contracts).
 *
 * Written FIRST, before any backend implementation exists, and frozen. This file
 * pins the CONTRACT SHAPE so an implementation cannot drift from it:
 *
 *  1. Every state enum has EXACTLY the members the design names
 *     (`/work/.reaper/claude/plans/fluffy-knitting-pinwheel.md` §3 and
 *     "Production architecture").
 *  2. The cursor wire codec round-trips, is stable, is opaque, and fails closed
 *     on malformed/tampered/wrong-version input.
 *  3. No contract method returns a non-Promise, and the manifest surface is
 *     exactly the designed operation set.
 *
 * Enforcement model for the Promise property: the authoritative gate is the
 * compile-time self-check block in `src/db/contracts.ts`
 * (`_AllRepositoriesReturnPromises`, `_NoOffsetAnywhere`, the `*_Surface` ties),
 * which `npx tsc -p tsconfig.json --noEmit` enforces — it fails on a sync method,
 * on an `offset` key, or on manifest/interface drift (verified). The runtime
 * assertions below pin the same surface through `THEMIS_CONTRACT` so the drift is
 * observable in the test runner too. No offset pagination type exists in this
 * contract by construction.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CURSOR_VERSION,
  CursorDecodeError,
  IDEMPOTENCY_KEY_STATE,
  JUDGE_ATTEMPT_STATE,
  JUDGE_ERROR_CLASSIFICATION,
  JUDGE_GENERATION_TRIGGER_KIND,
  JUDGE_JOB_STATE,
  JUDGE_JOB_TRIGGER_KIND,
  JUDGE_NODE,
  JUDGE_PAUSE_KIND,
  JUDGE_PROVIDER_OPERATION_KIND,
  JUDGE_PROVIDER_OPERATION_STATE,
  JUDGE_PUBLICATION_STATE,
  JUDGE_QUEUE_GENERATION_STATE,
  JUDGE_QUEUE_STATUS,
  JUDGE_ROLE,
  MAX_JUDGE_ROUNDS,
  THEMIS_CONTRACT,
  opaqueCursorCodec,
} from "../src/db/contracts.ts";
import type { KeysetCursor, KeysetPage, KeysetPageRequest } from "../src/db/contracts.ts";

// ---------------------------------------------------------------------------
// State enums — exact members as named by the design
// ---------------------------------------------------------------------------

/** [enum name, the runtime enum object, the design-named member list in order]. */
const STATE_ENUMS: ReadonlyArray<[string, Readonly<Record<string, string>>, readonly string[]]> = [
  // design §3 `judge_jobs`: "States: queued, leased, running, waiting_retry,
  // paused, sealing, completed, publication_conflict, input_invalid, failed,
  // dead_letter, cancelled."
  [
    "JUDGE_JOB_STATE",
    JUDGE_JOB_STATE,
    [
      "queued",
      "leased",
      "running",
      "waiting_retry",
      "paused",
      "sealing",
      "completed",
      "publication_conflict",
      "input_invalid",
      "failed",
      "dead_letter",
      "cancelled",
    ],
  ],
  // design §3 `judge_provider_operations`: "not_started, in_flight, succeeded,
  // failed, unknown."
  [
    "JUDGE_PROVIDER_OPERATION_STATE",
    JUDGE_PROVIDER_OPERATION_STATE,
    ["not_started", "in_flight", "succeeded", "failed", "unknown"],
  ],
  // design "Publication states are explicit: preparing, uploaded, verified,
  // committed, published, and invalid" merged with the §3 result-version state
  // "superseded" into one publication/supersession state column (§8).
  [
    "JUDGE_PUBLICATION_STATE",
    JUDGE_PUBLICATION_STATE,
    ["preparing", "uploaded", "verified", "committed", "published", "superseded", "invalid"],
  ],
  // design §3 `judge_queue_generations`: "accepting/closed state".
  ["JUDGE_QUEUE_GENERATION_STATE", JUDGE_QUEUE_GENERATION_STATE, ["accepting", "closed"]],
  // design §3 transition: "Queue running -> paused ...; paused -> running ...".
  // The design names no queue-level closed status; closure is expressed by the
  // generation state.
  ["JUDGE_QUEUE_STATUS", JUDGE_QUEUE_STATUS, ["running", "paused"]],
  // design §3 Claims: "pause_kind distinguishes manual, provider_quota,
  // provider_rate_limit, budget, and operator_safety".
  [
    "JUDGE_PAUSE_KIND",
    JUDGE_PAUSE_KIND,
    ["manual", "provider_quota", "provider_rate_limit", "budget", "operator_safety"],
  ],
  // `judge_attempts.state` — not literally enumerated in the design; derived from
  // the attempt lifecycle it names (running, terminal success/failure, and
  // worker-loss `lost`). Documented in the contract.
  ["JUDGE_ATTEMPT_STATE", JUDGE_ATTEMPT_STATE, ["running", "succeeded", "failed", "lost"]],
  // design "Error classification maps quota, transient, input, schema, and
  // permanent failures correctly" plus `worker_loss` (claims) and `rate_limit`
  // (retry classes, distinct from quota).
  [
    "JUDGE_ERROR_CLASSIFICATION",
    JUDGE_ERROR_CLASSIFICATION,
    ["rate_limit", "quota", "transient", "input", "schema", "permanent", "worker_loss"],
  ],
  // design §3 `judge_queue_generations`: linked archive events vs standalone bulk
  // submission.
  ["JUDGE_GENERATION_TRIGGER_KIND", JUDGE_GENERATION_TRIGGER_KIND, ["linked_archive", "standalone_bulk"]],
  // design §3 `judge_jobs`: linked auto-judge keys on the archive-sealed outbox
  // event; standalone bulk on the submitted item; rejudging is an explicit new
  // trigger.
  [
    "JUDGE_JOB_TRIGGER_KIND",
    JUDGE_JOB_TRIGGER_KIND,
    ["archive_sealed", "standalone_item", "rejudge"],
  ],
  // design §3 `judge_provider_operations`: "one durable row per model call or
  // web fetch".
  ["JUDGE_PROVIDER_OPERATION_KIND", JUDGE_PROVIDER_OPERATION_KIND, ["model", "web_fetch"]],
  // `idempotency_keys.state` — derived from the lifecycle the design describes
  // (in_progress until a response is stored; replays then return it).
  ["IDEMPOTENCY_KEY_STATE", IDEMPOTENCY_KEY_STATE, ["in_progress", "completed"]],
];

describe("state enums", () => {
  it.each(STATE_ENUMS)(
    "%s has exactly the members the design names, in design order",
    (_name, enumObj, expected) => {
      expect(Object.keys(enumObj), "members must match exactly (no extras, none missing)").toEqual([
        ...expected,
      ]);
    },
  );

  it("every state enum value is its own key (identity mapping, no aliases)", () => {
    for (const [, enumObj] of STATE_ENUMS) {
      for (const [key, value] of Object.entries(enumObj)) {
        expect(value).toBe(key);
      }
    }
  });

  it("state enums are frozen constant objects", () => {
    for (const [, enumObj] of STATE_ENUMS) {
      expect(Object.isFrozen(enumObj)).toBe(true);
    }
  });
});

describe("design-named role and node enumerations", () => {
  it("JUDGE_ROLE names exactly the five judge agent roles", () => {
    expect(Object.keys(JUDGE_ROLE)).toEqual(["orchestrator", "kratos", "logos", "minos", "clerk"]);
  });

  it("JUDGE_NODE names exactly Nodes 0 through 4", () => {
    expect(Object.keys(JUDGE_NODE)).toEqual(["node0", "node1", "node2", "node3", "node4"]);
  });

  it("the hard round ceiling is 10", () => {
    expect(MAX_JUDGE_ROUNDS).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Cursor codec — round-trip, stability, opacity, fail-closed
// ---------------------------------------------------------------------------

describe("opaqueCursorCodec", () => {
  const sampleCursors: readonly KeysetCursor[] = [
    { orderValues: ["run-1"], direction: "asc", version: CURSOR_VERSION },
    { orderValues: ["run-1", "2026-08-22T12:00:00.000Z", 42], direction: "desc", version: CURSOR_VERSION },
    { orderValues: [true, null, "a:b/c"], direction: "asc", version: CURSOR_VERSION },
    { orderValues: [0, false, "", "x"], direction: "desc", version: CURSOR_VERSION },
  ];

  it("round-trips: decode(encode(c)) deep-equals c", () => {
    for (const cursor of sampleCursors) {
      expect(opaqueCursorCodec.decode(opaqueCursorCodec.encode(cursor))).toEqual(cursor);
    }
  });

  it("is stable: re-encoding a decoded cursor is byte-identical", () => {
    for (const cursor of sampleCursors) {
      const encoded = opaqueCursorCodec.encode(cursor);
      expect(opaqueCursorCodec.encode(opaqueCursorCodec.decode(encoded))).toBe(encoded);
    }
  });

  it("produces an opaque base64url string that hides the order values", () => {
    const encoded = opaqueCursorCodec.encode({ orderValues: ["run-1"], direction: "asc", version: CURSOR_VERSION });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("run-1");
  });

  it("fails closed on malformed, tampered, and wrong-version cursors", () => {
    const bad = [
      "",                                                                          // empty
      "!!!",                                                                       // not base64url
      "not base64url",                                                             // not base64url
      Buffer.from("not json", "utf8").toString("base64url"),                       // valid base64, not JSON
      Buffer.from("{}", "utf8").toString("base64url"),                             // missing fields
      Buffer.from(JSON.stringify({ version: CURSOR_VERSION, direction: "asc", orderValues: [] }), "utf8").toString("base64url"), // empty orderValues
      Buffer.from(JSON.stringify({ version: CURSOR_VERSION, direction: "sideways", orderValues: [1] }), "utf8").toString("base64url"), // bad direction
      Buffer.from(JSON.stringify({ version: CURSOR_VERSION, direction: "asc", orderValues: [1, "ok"], extra: true }), "utf8").toString("base64url"), // unknown top-level field must be rejected
      Buffer.from(JSON.stringify({ version: 999, direction: "asc", orderValues: [1] }), "utf8").toString("base64url"), // wrong version
      Buffer.from(JSON.stringify({ version: CURSOR_VERSION, direction: "asc", orderValues: [{ nested: true }] }), "utf8").toString("base64url"), // non-scalar value
    ];
    for (const cursor of bad) {
      expect(() => opaqueCursorCodec.decode(cursor), `should reject: ${cursor}`).toThrow(CursorDecodeError);
    }
  });

  it("refuses to encode a structurally invalid cursor", () => {
    const bad = [
      { orderValues: [], direction: "asc", version: CURSOR_VERSION },                                        // empty
      { orderValues: [1], direction: "sideways", version: CURSOR_VERSION },                                   // bad direction
      { orderValues: [Number.NaN], direction: "asc", version: CURSOR_VERSION },                               // non-finite number
      { orderValues: [1], direction: "asc", version: 999 },                                                  // wrong version
    ];
    for (const cursor of bad) {
      expect(() => opaqueCursorCodec.encode(cursor)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Contract surface — exactly the designed method set, all async
// ---------------------------------------------------------------------------

/** The designed method surface per table group (derived from design §3/§10
 *  operations). THEMIS_CONTRACT must match this exactly. */
const EXPECTED_SURFACE: Readonly<Record<string, readonly string[]>> = {
  judgeQueues: ["create", "get", "getByLinkedEvalQueue", "listByProjectCursor", "update"],
  judgeQueueGenerations: ["get", "getCurrentAccepting", "createNext", "close", "listByQueueCursor"],
  judgeConfigSnapshots: ["create", "get", "getByJob", "deleteEncryptedPromptBodies", "delete"],
  judgeJobs: [
    "upsertByTrigger",
    "get",
    "getByRunCursor",
    "listByQueueCursor",
    "listByProjectCursor",
    "claimNext",
    "heartbeat",
    "updateFenced",
    "requeueExpiredLeases",
  ],
  judgeAttempts: ["create", "get", "getByJob", "transition"],
  judgeProviderOperations: [
    "create",
    "get",
    "getByLogicalKey",
    "begin",
    "succeed",
    "fail",
    "markUnknown",
    "markInFlightUnknownByAttempt",
    "setAuthoritative",
    "listByAttemptCursor",
  ],
  judgeResultVersions: [
    "createStaging",
    "get",
    "listByRunCursor",
    "listByProjectCursor",
    "listByQueueCursor",
    "transitionPublication",
    "publish",
    "markInvalid",
    "markSuperseded",
    "listForExport",
  ],
  judgeCurrentPointers: ["get", "advance", "listByRun"],
  outboxEvents: ["enqueue", "claimNext", "markDelivered", "releaseLease", "requeueExpiredLeases", "listPendingCursor"],
  idempotencyKeys: ["createIfAbsent", "get", "getReplay", "complete", "deleteExpired"],
};

describe("contract surface", () => {
  it("exposes exactly the ten Themis table groups from design section 3", () => {
    expect(Object.keys(THEMIS_CONTRACT.repos).sort()).toEqual(Object.keys(EXPECTED_SURFACE).sort());
  });

  it.each(Object.keys(EXPECTED_SURFACE))(
    "repository %s is async and has exactly the designed method surface",
    (repo) => {
      const entry = THEMIS_CONTRACT.repos[repo];
      expect(entry.async, `${repo} must be declared async`).toBe(true);
      expect([...entry.methods].sort(), `${repo} method surface`).toEqual([...EXPECTED_SURFACE[repo]].sort());
      expect(new Set(entry.methods).size, `${repo} method names must be unique`).toBe(entry.methods.length);
    },
  );

  it("no contract method is an offset pagination method", () => {
    for (const entry of Object.values(THEMIS_CONTRACT.repos)) {
      for (const method of entry.methods) {
        expect(method.toLowerCase()).not.toContain("offset");
      }
    }
  });

  it("every repository method returns a Promise (compile-enforced, surfaced here)", () => {
    // The authoritative gate is the compile-time self-check in contracts.ts
    // (`_AllRepositoriesReturnPromises`), enforced by `npx tsc -p tsconfig.json`.
    // At runtime this asserts the manifest — which the compile-time `*_Surface`
    // ties bind to the repository interfaces — declares every repository async,
    // so a sync method cannot appear in the surface without failing either tsc or
    // this test.
    for (const [repo, entry] of Object.entries(THEMIS_CONTRACT.repos)) {
      expect(entry.async, `${repo} must be Promise-returning`).toBe(true);
      expect(entry.methods.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level shape spot-checks (house style; enforced when this file is
// type-checked, and documented for the frozen contract)
// ---------------------------------------------------------------------------

describe("type shapes", () => {
  it("KeysetPageRequest carries exactly cursor + limit (no offset)", () => {
    expectTypeOf<KeysetPageRequest>().toEqualTypeOf<{
      cursor: string | null;
      limit: number;
    }>();
  });

  it("opaqueCursorCodec conforms to the CursorCodec contract", () => {
    expectTypeOf(opaqueCursorCodec.encode).toBeFunction();
    expectTypeOf(opaqueCursorCodec.decode).toBeFunction();
    expectTypeOf(opaqueCursorCodec.encode).parameter(0).toEqualTypeOf<KeysetCursor>();
    expectTypeOf(opaqueCursorCodec.encode).returns.toEqualTypeOf<string>();
    expectTypeOf(opaqueCursorCodec.decode).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(opaqueCursorCodec.decode).returns.toEqualTypeOf<KeysetCursor>();
  });

  it("KeysetPage<T> carries exactly items, nextCursor, and hasMore (no offset)", () => {
    expectTypeOf<KeysetPage<number>>().toEqualTypeOf<{
      items: readonly number[];
      nextCursor: string | null;
      hasMore: boolean;
    }>();
  });
});
