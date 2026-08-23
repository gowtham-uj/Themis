import { describe, expect, it } from "vitest";

import { PetitionLog } from "../src/judge/tools/petition.ts";
import { ScratchpadAccessError, ScratchpadStore } from "../src/judge/tools/scratchpad.ts";

describe("scratchpad", () => {
  it("denies peer reads while in progress, allows after complete", () => {
    const store = new ScratchpadStore();
    store.open("kratos");
    store.append("kratos", "chunk-1");
    expect(() => store.read("kratos", "logos")).toThrow(ScratchpadAccessError);
    store.complete("kratos");
    expect(store.read("kratos", "logos")).toHaveLength(1);
  });
});

describe("petition log", () => {
  it("is idempotent on idempotency keys and decides once", () => {
    const log = new PetitionLog();
    const a = log.petition({
      caseId: "c",
      fromAgentId: "kratos",
      kind: "evidence",
      target: "file:x",
      suspicion: "need bytes",
      idempotencyKey: "k1",
    });
    const b = log.petition({
      caseId: "c",
      fromAgentId: "kratos",
      kind: "evidence",
      target: "file:x",
      suspicion: "need bytes",
      idempotencyKey: "k1",
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.event.id).toBe(a.event.id);
    const decided = log.decide(a.event.id, "granted", "in catalog");
    expect(decided.decision).toBe("granted");
    expect(log.decide(a.event.id, "denied", "nope").decision).toBe("granted");
  });
});
