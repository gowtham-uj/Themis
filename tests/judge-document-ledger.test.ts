import { describe, expect, it } from "vitest";

import {
  DocumentConflictError,
  MemoryDocumentLedger,
} from "../src/judge/documents/ledger.ts";

describe("WP-7 document ledger", () => {
  it("same id + same hash is a no-op", () => {
    const ledger = new MemoryDocumentLedger();
    const a = ledger.stage({
      id: "doc_1",
      caseId: "case",
      node: "minos",
      round: 1,
      agentId: "minos",
      sequence: 1,
      body: "hello",
    });
    const b = ledger.stage({
      id: "doc_1",
      caseId: "case",
      node: "minos",
      round: 1,
      agentId: "minos",
      sequence: 1,
      body: "hello",
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.doc.contentSha256).toBe(a.doc.contentSha256);
  });

  it("same id + different hash conflicts", () => {
    const ledger = new MemoryDocumentLedger();
    ledger.stage({
      id: "doc_1",
      caseId: "case",
      node: "minos",
      round: 1,
      agentId: "minos",
      sequence: 1,
      body: "hello",
    });
    expect(() =>
      ledger.stage({
        id: "doc_1",
        caseId: "case",
        node: "minos",
        round: 1,
        agentId: "minos",
        sequence: 1,
        body: "HELLO",
      }),
    ).toThrow(DocumentConflictError);
  });

  it("commit flips staging to committed", () => {
    const ledger = new MemoryDocumentLedger();
    const { doc } = ledger.stage({
      id: "doc_2",
      caseId: "case",
      node: "kratos",
      round: 1,
      agentId: "k",
      sequence: 1,
      body: "fact",
    });
    ledger.commit([doc.id]);
    expect(ledger.get(doc.id)?.state).toBe("committed");
  });
});
