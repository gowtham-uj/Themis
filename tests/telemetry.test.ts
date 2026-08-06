import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NetworkCutoff,
  type StaticNetworkPolicy,
} from "../src/runner/network-control.ts";
import { ExecNetRecorder } from "../src/runner/telemetry.ts";
import {
  validateCanonicalEvent,
  type CanonicalEvent,
  type ExecEvent,
  type NetEvent,
} from "../src/schema/events.ts";
import { readJsonl } from "../src/schema/jsonl.ts";

async function tempEventsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-telemetry-"));
  return join(dir, "events.jsonl");
}

async function readAllEvents(path: string): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const obj of readJsonl(path)) {
    out.push(validateCanonicalEvent(obj));
  }
  return out;
}

describe("ExecNetRecorder", () => {
  it("recordExec/recordNet emit valid canonical events into events.jsonl", async () => {
    const eventsPath = await tempEventsPath();
    const rec = new ExecNetRecorder({
      runId: "run-tel-1",
      eventsPath,
      now: () => "2026-08-06T12:00:00.000Z",
    });

    const execEv = await rec.recordExec({
      argv: ["npm", "test"],
      cwd: "/workspace",
      user: "agent",
      exitCode: 0,
      durationMs: 320,
      turn: 1,
    });
    const netEv = await rec.recordNet({
      host: "registry.npmjs.org",
      port: 443,
      proto: "http",
      direction: "outbound",
      method: "GET",
      url: "https://registry.npmjs.org/lodash",
      bytesSent: 120,
      bytesRecv: 4096,
      status: 200,
      durationMs: 90,
      turn: 1,
    });

    expect(execEv.type).toBe("exec");
    expect(netEv.type).toBe("net");
    expect(() => validateCanonicalEvent(execEv)).not.toThrow();
    expect(() => validateCanonicalEvent(netEv)).not.toThrow();

    const roundTrip = await readAllEvents(eventsPath);
    expect(roundTrip).toHaveLength(2);
    expect(roundTrip[0]).toEqual(execEv);
    expect(roundTrip[1]).toEqual(netEv);

    const exec = roundTrip[0] as ExecEvent;
    expect(exec.argv).toEqual(["npm", "test"]);
    expect(exec.cwd).toBe("/workspace");
    expect(exec.user).toBe("agent");
    expect(exec.exitCode).toBe(0);
    expect(exec.durationMs).toBe(320);
    expect(exec.seq).toBe(0);
    expect(exec.runId).toBe("run-tel-1");

    const net = roundTrip[1] as NetEvent;
    expect(net.host).toBe("registry.npmjs.org");
    expect(net.port).toBe(443);
    expect(net.proto).toBe("http");
    expect(net.direction).toBe("outbound");
    expect(net.status).toBe(200);
    expect(net.seq).toBe(1);
    expect(net.blocked).toBeUndefined();
  });

  it("accepts exec with exitCode:null (still-running) and with a numeric exitCode", async () => {
    const eventsPath = await tempEventsPath();
    const rec = new ExecNetRecorder({
      runId: "run-tel-exit",
      eventsPath,
      now: () => "2026-08-06T12:00:00.000Z",
    });

    const running = await rec.recordExec({
      argv: ["sleep", "100"],
      cwd: "/workspace",
      user: "agent",
      exitCode: null,
      durationMs: 0,
    });
    const finished = await rec.recordExec({
      argv: ["true"],
      cwd: "/workspace",
      user: "agent",
      exitCode: 0,
      durationMs: 5,
    });

    expect(running.exitCode).toBeNull();
    expect(finished.exitCode).toBe(0);
    expect(() => validateCanonicalEvent(running)).not.toThrow();
    expect(() => validateCanonicalEvent(finished)).not.toThrow();

    const roundTrip = await readAllEvents(eventsPath);
    expect((roundTrip[0] as ExecEvent).exitCode).toBeNull();
    expect((roundTrip[1] as ExecEvent).exitCode).toBe(0);
  });

  it("assigns monotonic seqs across mixed exec/net", async () => {
    const eventsPath = await tempEventsPath();
    const rec = new ExecNetRecorder({
      runId: "run-tel-seq",
      eventsPath,
      startSeq: 10,
      now: () => "2026-08-06T12:00:00.000Z",
    });

    await rec.recordExec({
      argv: ["ls"],
      cwd: "/workspace",
      user: "agent",
      exitCode: 0,
      durationMs: 1,
    });
    await rec.recordNet({
      host: "example.com",
      port: 80,
      proto: "tcp",
      direction: "outbound",
    });
    await rec.recordExec({
      argv: ["cat", "a"],
      cwd: "/workspace",
      user: "agent",
      exitCode: 1,
      durationMs: 2,
    });
    await rec.recordNet({
      host: "api.example.com",
      port: 443,
      proto: "http",
      direction: "outbound",
      method: "POST",
    });

    const events = await readAllEvents(eventsPath);
    expect(events.map((e) => e.seq)).toEqual([10, 11, 12, 13]);
    expect(events.map((e) => e.type)).toEqual(["exec", "net", "exec", "net"]);
    // Strictly increasing
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
    }
  });
});

describe("NetworkCutoff + ExecNetRecorder integration", () => {
  it("cutoff() then recordNet(outbound) → blocked:true, blockedReason:'live-cutoff'; restore() → normal", async () => {
    const eventsPath = await tempEventsPath();
    const cutoff = new NetworkCutoff();
    const rec = new ExecNetRecorder({
      runId: "run-tel-cut",
      eventsPath,
      networkCutoff: cutoff,
      now: () => "2026-08-06T12:00:00.000Z",
    });

    // Before cutoff: normal outbound
    const before = await rec.recordNet({
      host: "registry.npmjs.org",
      port: 443,
      proto: "http",
      direction: "outbound",
      method: "GET",
      bytesSent: 10,
      bytesRecv: 100,
      status: 200,
      durationMs: 50,
    });
    expect(before.blocked).toBeUndefined();
    expect(before.status).toBe(200);

    cutoff.cutoff();
    expect(cutoff.isBlocked()).toBe(true);
    expect(cutoff.cutoffAt()).toBeTruthy();
    expect(typeof cutoff.cutoffAt()).toBe("string");

    const blocked = await rec.recordNet({
      host: "evil.example",
      port: 443,
      proto: "http",
      direction: "outbound",
      method: "POST",
      url: "https://evil.example/exfil",
      // caller may still pass transfer stats — live cutoff must override
      bytesSent: 999,
      bytesRecv: 1,
      status: 200,
      durationMs: 5,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockedReason).toBe("live-cutoff");
    expect(blocked.host).toBe("evil.example");
    // Should not look like a completed transfer under live cutoff
    expect(blocked.bytesSent).toBeUndefined();
    expect(blocked.bytesRecv).toBeUndefined();
    expect(blocked.status).toBeUndefined();

    // Inbound is not subject to egress cutoff
    const inbound = await rec.recordNet({
      host: "0.0.0.0",
      port: 8080,
      proto: "tcp",
      direction: "inbound",
    });
    expect(inbound.blocked).toBeUndefined();

    cutoff.restore();
    expect(cutoff.isBlocked()).toBe(false);
    // Historical cutoff moment remains for the timeline
    expect(cutoff.cutoffAt()).toBeTruthy();

    const after = await rec.recordNet({
      host: "registry.npmjs.org",
      port: 443,
      proto: "http",
      direction: "outbound",
      method: "GET",
      bytesSent: 20,
      bytesRecv: 200,
      status: 200,
      durationMs: 40,
    });
    expect(after.blocked).toBeUndefined();
    expect(after.blockedReason).toBeUndefined();
    expect(after.status).toBe(200);
    expect(after.bytesSent).toBe(20);

    const all = await readAllEvents(eventsPath);
    expect(all).toHaveLength(4);
    const blockedRoundTrip = all[1] as NetEvent;
    expect(blockedRoundTrip.blocked).toBe(true);
    expect(blockedRoundTrip.blockedReason).toBe("live-cutoff");
    expect(() => validateCanonicalEvent(blockedRoundTrip)).not.toThrow();
  });
});

describe("NetworkCutoff.policyFor", () => {
  it("static 'allowlist' under live cutoff → effective 'offline'; under no cutoff → unchanged", () => {
    const cut = new NetworkCutoff();
    expect(cut.policyFor("allowlist")).toBe("allowlist");
    expect(cut.policyFor("allow")).toBe("allow");
    expect(cut.policyFor("offline")).toBe("offline");

    cut.cutoff();
    expect(cut.policyFor("allowlist")).toBe("offline");
    expect(cut.policyFor("allow")).toBe("offline");
    expect(cut.policyFor("offline")).toBe("offline");

    cut.restore();
    expect(cut.policyFor("allowlist")).toBe("allowlist");
    expect(cut.policyFor("allow")).toBe("allow");
  });

  it("implements NetworkCutoffController and reports cutoff timestamp", () => {
    const cut = new NetworkCutoff();
    expect(cut.cutoffAt()).toBeNull();
    expect(cut.getState().egressEnabled).toBe(true);

    const before = Date.now();
    cut.cutoff();
    const after = Date.now();
    const ts = cut.cutoffAt();
    expect(ts).not.toBeNull();
    const ms = Date.parse(ts!);
    expect(ms).toBeGreaterThanOrEqual(before - 5);
    expect(ms).toBeLessThanOrEqual(after + 5);

    // restore does not clear the timeline marker
    cut.restore();
    expect(cut.cutoffAt()).toBe(ts);
    expect(cut.getState().egressEnabled).toBe(true);

    // re-cutoff updates the timestamp
    cut.cutoff();
    expect(cut.cutoffAt()).not.toBeNull();
    expect(Date.parse(cut.cutoffAt()!)).toBeGreaterThanOrEqual(ms);
  });

  it("covers all static policies under cutoff", () => {
    const cut = new NetworkCutoff();
    const policies: StaticNetworkPolicy[] = ["allow", "allowlist", "offline"];
    cut.cutoff();
    for (const p of policies) {
      expect(cut.policyFor(p)).toBe("offline");
    }
  });
});
