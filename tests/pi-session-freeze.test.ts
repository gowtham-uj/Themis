import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  freezePiSession,
  PI_CHILD_RESUME_MANIFEST,
  pausePiWorkDir,
  PI_RESUME_POINTER,
} from "../src/judge/pi/runtime.ts";

describe("PI session freeze", () => {
  it("repairs a torn last line, snapshots, and writes a resume pointer to the same jsonl", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ae-freeze-"));
    const sessions = join(workDir, "sessions");
    await mkdir(sessions);
    const sessionPath = join(sessions, "2026-09-04T18-00-00_ae-case_x.jsonl");
    await writeFile(sessionPath, '{"type":"ok","n":1}\n{"type":"torn incomplete');

    const frozen = await freezePiSession(workDir);
    expect(frozen).toBe(sessionPath);

    const text = await readFile(sessionPath, "utf8");
    expect(text).toBe('{"type":"ok","n":1}\n');
    expect(JSON.parse(text.trim())).toEqual({ type: "ok", n: 1 });

    const snapshot = await readFile(sessionPath.replace(/\.jsonl$/, ".frozen.jsonl"), "utf8");
    expect(snapshot).toBe(text);

    const pointer = (await readFile(join(sessions, PI_RESUME_POINTER), "utf8")).trim();
    expect(pointer).toBe(sessionPath);
  });

  it("freezes an interrupted child and makes it resumable under the same parent session", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ae-child-freeze-"));
    const sessions = join(workDir, "sessions");
    const parent = join(sessions, "2026-09-04T18-00-00_ae-case_y.jsonl");
    const runId = "11111111-2222-3333-4444-555555555555";
    const runRoot = join(sessions, "2026-09-04T18-00-00_ae-case_y", runId);
    const child = join(runRoot, "run-0", "session.jsonl");
    const child2 = join(runRoot, "run-1", "session.jsonl");
    const artifacts = join(sessions, "subagent-artifacts");
    await mkdir(join(runRoot, "run-0"), { recursive: true });
    await mkdir(join(runRoot, "run-1"), { recursive: true });
    await mkdir(artifacts, { recursive: true });
    await writeFile(parent, '{"type":"message","message":{"role":"assistant"}}\n');
    await writeFile(child,
      '{"type":"message","message":{"role":"assistant","provider":"themis-proxy","model":"stage-model"}}\n' +
      '{"type":"torn"',
    );
    await writeFile(child2,
      '{"type":"message","message":{"role":"assistant","provider":"themis-proxy","model":"stage-model"}}\n',
    );
    await writeFile(join(artifacts, `${runId}_logos_0_input.md`), "continue forensics");
    await writeFile(join(artifacts, `${runId}_kratos_1_input.md`), "continue trajectory");

    await freezePiSession(workDir);

    expect(await readFile(child, "utf8")).toBe(
      '{"type":"message","message":{"role":"assistant","provider":"themis-proxy","model":"stage-model"}}\n',
    );
    expect(await readFile(child.replace(/\.jsonl$/, ".frozen.jsonl"), "utf8")).toBe(
      await readFile(child, "utf8"),
    );

    const manifest = JSON.parse(
      await readFile(join(sessions, PI_CHILD_RESUME_MANIFEST), "utf8"),
    ) as { children: Array<{ runId: string; agent: string; sessionFile: string }> };
    expect(manifest.children).toEqual([
      expect.objectContaining({ runId, index: 0, agent: "logos", sessionFile: child }),
      expect.objectContaining({ runId, index: 1, agent: "kratos", sessionFile: child2 }),
    ]);

    const history = JSON.parse(
      await readFile(join(workDir, "subagents", "async-subagent-results", "foreground-history.json"), "utf8"),
    ) as { runs: Array<{ runId: string; mode: string; sessionId: string; children: Array<{ status: string; model: string }> }> };
    expect(history.runs[0]?.runId).toBe(runId);
    expect(history.runs[0]?.mode).toBe("parallel");
    expect(history.runs[0]?.sessionId).toBe(parent);
    expect(history.runs[0]?.children).toHaveLength(2);
    expect(history.runs[0]?.children.every((child) =>
      child.status === "paused" && child.model === "themis-proxy/stage-model:medium",
    )).toBe(true);
  });

  it("merges into pi's own history per child, keeping settled siblings untouched", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ae-child-merge-"));
    const sessions = join(workDir, "sessions");
    const parent = join(sessions, "2026-09-04T18-00-00_ae-case_z.jsonl");
    const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const runRoot = join(sessions, "2026-09-04T18-00-00_ae-case_z", runId);
    const done = join(runRoot, "run-0", "session.jsonl");
    const live = join(runRoot, "run-1", "session.jsonl");
    const resultsDir = join(workDir, "subagents", "async-subagent-results");
    await mkdir(join(runRoot, "run-0"), { recursive: true });
    await mkdir(join(runRoot, "run-1"), { recursive: true });
    await mkdir(resultsDir, { recursive: true });
    await writeFile(parent, '{"type":"message","message":{"role":"assistant"}}\n');
    await writeFile(done, '{"type":"message","message":{"role":"assistant"}}\n');
    await writeFile(live, '{"type":"message","message":{"role":"assistant"}}\n');
    // pi already settled child 0 when it finished; child 1 was still running.
    await writeFile(join(resultsDir, "foreground-history.json"), JSON.stringify({
      version: 1,
      runs: [{
        runId, mode: "single", cwd: "/somewhere", sessionId: parent, updatedAt: 1,
        children: [{ agent: "logos", index: 0, status: "completed", sessionFile: done, finalOutput: "done" }],
      }],
    }));

    await freezePiSession(workDir);

    const history = JSON.parse(
      await readFile(join(resultsDir, "foreground-history.json"), "utf8"),
    ) as { runs: Array<{ runId: string; mode: string; cwd: string; children: Array<{ index: number; status: string; finalOutput?: string }> }> };
    expect(history.runs).toHaveLength(1);
    const run = history.runs[0]!;
    expect(run.mode).toBe("parallel");
    expect(run.cwd).toBe("/somewhere");
    expect(run.children.map((c) => [c.index, c.status])).toEqual([[0, "completed"], [1, "paused"]]);
    expect(run.children[0]?.finalOutput).toBe("done");

    const manifest = JSON.parse(
      await readFile(join(sessions, PI_CHILD_RESUME_MANIFEST), "utf8"),
    ) as { children: Array<{ index: number }> };
    expect(manifest.children.map((c) => c.index)).toEqual([1]);
  });
});

describe("pausePiWorkDir", () => {
  it("reports killed:false for a stale pid file but still freezes the session", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ae-stale-pid-"));
    const sessions = join(workDir, "sessions");
    await mkdir(sessions);
    const sessionPath = join(sessions, "2026-09-06T22-00-00_ae-phase2_c.jsonl");
    await writeFile(sessionPath, '{"type":"ok","n":1}\n');
    // A pid that has certainly exited. `pi.pid` outlives its process, so pause
    // used to answer killed:true here, which callers read as "the live run was
    // stopped" and use to skip the alternate work dir.
    const dead = await findDeadPid();
    await writeFile(join(workDir, "pi.pid"), `${dead}\n`);

    const out = await pausePiWorkDir(workDir);
    expect(out).toEqual({ killed: false, pid: dead });
    // A crashed run never froze itself, so the crash must still become resumable.
    expect((await readFile(sessionPath.replace(/\.jsonl$/, ".frozen.jsonl"), "utf8"))).toBe(
      '{"type":"ok","n":1}\n',
    );
  });

  it("reports killed:false and no pid when there is no pid file", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ae-no-pid-"));
    expect(await pausePiWorkDir(workDir)).toEqual({ killed: false, pid: null });
  });
});

/** A pid that is not running, so `process.kill(pid, 0)` throws ESRCH. */
async function findDeadPid(): Promise<number> {
  for (let pid = 4_000_000; pid > 3_900_000; pid--) {
    try { process.kill(pid, 0); } catch { return pid; }
  }
  throw new Error("no dead pid found");
}
