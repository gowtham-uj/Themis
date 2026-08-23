import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EvidenceAccessError,
  buildEvidenceCatalog,
  readEvidence,
  resolveCatalogPath,
} from "../src/judge/tools/evidence.ts";

describe("mediated evidence tool", () => {
  it("reads a bounded range by catalog id", async () => {
    const root = await mkdtemp(join(tmpdir(), "ae-ev-"));
    await mkdir(join(root, "retained"), { recursive: true });
    await writeFile(join(root, "retained", "a.txt"), "abcdefghij");
    const catalog = buildEvidenceCatalog([{ path: "retained/a.txt", bytes: 10 }]);
    const id = [...catalog.keys()][0]!;
    const got = await readEvidence(root, catalog, { catalogId: id, offset: 2, length: 4 });
    expect(got.content).toBe("cdef");
  });

  it("denies path escape", () => {
    expect(() => resolveCatalogPath("/tmp/arch", "../etc/passwd")).toThrow(EvidenceAccessError);
  });

  it("rejects unknown catalog ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "ae-ev-"));
    await expect(
      readEvidence(root, new Map(), { catalogId: "nope" }),
    ).rejects.toBeInstanceOf(EvidenceAccessError);
  });
});
