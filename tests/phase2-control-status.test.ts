/** Public Phase-2 status must not reveal deployment-local host paths. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getPhase2PiStatus } from "../src/judge/phase2/control.ts";

describe("Phase-2 PI status", () => {
  it("returns a relative work directory label", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "themis-p2-status-"));
    const status = await getPhase2PiStatus(dataDir, "p2c_one");

    expect(status.workDir).toBe("platform/phase2/p2c_one");
    expect(status.workDir.startsWith("/")).toBe(false);
    expect(JSON.stringify(status)).not.toContain(dataDir);
  });
});
