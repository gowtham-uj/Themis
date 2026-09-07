import { mkdir, mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPiThrottle } from "../src/judge/pi/runtime.ts";

describe("PI child throttle detection", () => {
  it("detects 402 Insufficient Balance from child metadata even if parent exits 0", async () => {
    const w = await mkdtemp(join(tmpdir(), "ae-pi-throttle-"));
    const a = join(w, "sessions", "subagent-artifacts");
    await mkdir(a, { recursive: true });
    await writeFile(join(a, "kratos_0_meta.json"), JSON.stringify({
      exitCode: 1,
      error: '402: {"message":"Insufficient Balance"}',
      model: "themis-proxy/deepseek-v4-flash:medium",
    }));
    const hit = await detectPiThrottle(w, "parent agent_settled exit 0");
    expect(hit).toEqual({ kind: "quota", status: 402, message: "provider quota/balance exhausted during PI courtroom" });
  });

  it("detects 429 as rate_limit", async () => {
    const w = await mkdtemp(join(tmpdir(), "ae-pi-throttle-"));
    const hit = await detectPiThrottle(w, "OpenAI API error (429): Too Many Requests");
    expect(hit?.kind).toBe("rate_limit");
    expect(hit?.status).toBe(429);
  });

  it("does not misclassify ordinary auth errors as quota", async () => {
    const w = await mkdtemp(join(tmpdir(), "ae-pi-throttle-"));
    expect(await detectPiThrottle(w, "auth_unavailable: no auth available")).toBeNull();
  });

  it("ignores a quota failure left by an earlier attempt in the same work dir", async () => {
    // A resumed courtroom reuses its working directory, so artifacts from a
    // previous attempt are still on disk. Observed live: a case whose subagents
    // were completing normally was failed by a 402 recorded twelve hours
    // earlier, and the provider was healthy the whole time.
    const w = await mkdtemp(join(tmpdir(), "ae-pi-throttle-"));
    const a = join(w, "sessions", "subagent-artifacts");
    await mkdir(a, { recursive: true });
    const stale = join(a, "logos_0_meta.json");
    await writeFile(stale, JSON.stringify({ exitCode: 1, error: '402: {"message":"Insufficient Balance"}' }));
    const staleMs = Date.now() - 12 * 60 * 60 * 1000;
    await utimes(stale, staleMs / 1000, staleMs / 1000);

    const attemptStarted = Date.now() - 60_000;
    expect(await detectPiThrottle(w, "parent agent_settled exit 0", attemptStarted)).toBeNull();

    // The same file rewritten by the current attempt still throttles.
    await writeFile(stale, JSON.stringify({ exitCode: 1, error: '402: {"message":"Insufficient Balance"}' }));
    expect((await detectPiThrottle(w, "parent agent_settled exit 0", attemptStarted))?.kind).toBe("quota");
  });
});
