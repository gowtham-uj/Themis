import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { collectArchiveFacts } from "../src/judge/quality/archive-facts.ts";

/** Build a throwaway archive dir with the given relative files. */
async function archive(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ae-facts-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  return dir;
}

describe("archive fact collection", () => {
  it("attributes a whole session stream to the run id its header declares", async () => {
    // Observed live: only the header and a few records repeat `runId`. The rest
    // carry `seq` alone, so keying on the per-record field alone left every ref
    // to those moments unresolvable.
    const dir = await archive({
      "session/session.jsonl": [
        '{"kind":"header","version":4,"id":"exec-1788546396997","metadata":{"runId":"exec-1788546396997"}}',
        '{"kind":"record","seq":1,"runId":"exec-1788546396997","type":"operation_started"}',
        '{"kind":"entry","seq":35,"type":"message"}',
        '{"kind":"entry","seq":44,"type":"message"}',
        "",
      ].join("\n"),
    });

    const { tierB } = await collectArchiveFacts({ archiveDir: dir });
    const seqs = tierB.traceSeqs?.get("exec-1788546396997");
    expect(seqs).toBeDefined();
    expect([...seqs!].sort((a, b) => a - b)).toEqual([1, 35, 44]);
  });

  it("indexes json pointers in a verifier result written to a .log path", async () => {
    // The verifier prints its structured result on stdout, so the archive holds
    // it as `verifier-stdout.log`. Selecting on `.json` alone made every
    // `artifact:verifier_res/verifier-stdout.log#/...` ref unresolvable.
    const dir = await archive({
      "verifier_res/verifier-stdout.log": JSON.stringify({
        checks: [{ name: "public_tests", passed: true }],
        passed: true,
        reward: 1,
      }),
      "raw_std/raw-stdout.log": "not json at all\n",
    });

    const { tierB } = await collectArchiveFacts({ archiveDir: dir });
    const pointers = tierB.artifactPointers?.get("verifier_res/verifier-stdout.log");
    expect(pointers?.has("/passed")).toBe(true);
    expect(pointers?.has("/checks/0/name")).toBe(true);
    // A .log that is not JSON stays out of the index rather than erroring.
    expect(tierB.artifactPointers?.has("raw_std/raw-stdout.log")).toBe(false);
  });
});
