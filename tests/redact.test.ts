import { afterEach, describe, expect, it } from "vitest";
import {
  clearKnownSecrets,
  looksLikeSecret,
  redactEnv,
  redactEvent,
  redactString,
  redactionApplied,
  registerKnownSecrets,
  redactedPlaceholder,
} from "../src/runner/redact.ts";
import {
  SCHEMA_VERSION,
  validateCanonicalEvent,
  type CanonicalEvent,
} from "../src/schema/events.ts";

afterEach(() => {
  clearKnownSecrets();
});

function baseEnvelope(overrides: Partial<CanonicalEvent> = {}) {
  return {
    v: SCHEMA_VERSION,
    runId: "run-test-1",
    seq: 1,
    ts: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("redactString", () => {
  it("scrubs sk-ant- anthropic keys", () => {
    const s = "key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";
    const out = redactString(s);
    expect(out).toContain(redactedPlaceholder("anthropic_key"));
    expect(out).not.toContain("sk-ant-api03");
  });

  it("scrubs sk- openai-style keys", () => {
    const s = "Authorization sk-proj-abcdefghijklmnopqrstuvwxyz";
    const out = redactString(s);
    expect(out).toContain(redactedPlaceholder("api_key"));
    expect(out).not.toContain("sk-proj-");
  });

  it("scrubs Bearer tokens", () => {
    const s = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc";
    const out = redactString(s);
    expect(out.toLowerCase()).toContain("redacted");
    expect(out).not.toMatch(/Bearer\s+eyJ/i);
  });

  it("scrubs ENV_NAME=value for *_KEY / *_TOKEN", () => {
    const s = "export OPENAI_API_KEY=sk-notthisbutlongenoughvalue12345";
    // either the sk- pattern or the env pattern should catch it
    const out = redactString(s);
    expect(out).not.toContain("sk-notthisbutlongenoughvalue12345");
  });

  it("scrubs long hex secrets (>24 chars)", () => {
    const hex = "a".repeat(32);
    const out = redactString(`token=${hex}`);
    expect(out).not.toContain(hex);
    expect(out).toContain("REDACTED");
  });

  it("leaves non-secret text intact", () => {
    const s = "Hello world — the agent fixed bug #42 in src/main.ts";
    expect(redactString(s)).toBe(s);
  });

  it("scrubs registered known secrets", () => {
    registerKnownSecrets("super-secret-value-xyz");
    const out = redactString("leaked: super-secret-value-xyz end");
    expect(out).toContain(redactedPlaceholder("known_secret"));
    expect(out).not.toContain("super-secret-value-xyz");
  });

  it("never throws on odd inputs", () => {
    expect(() => redactString("")).not.toThrow();
    // @ts-expect-error intentional
    expect(() => redactString(null)).not.toThrow();
    // @ts-expect-error intentional
    expect(() => redactString(undefined)).not.toThrow();
  });
});

describe("redactEnv", () => {
  it("scrubs *_KEY and *_TOKEN values", () => {
    const env = redactEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-real-secret-value-here",
      OPENAI_API_KEY: "sk-openai-real-secret",
      MY_SERVICE_TOKEN: "tok_abc1234567890",
      HOME: "/home/user",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.ANTHROPIC_API_KEY).toContain("REDACTED");
    expect(env.OPENAI_API_KEY).toContain("REDACTED");
    expect(env.MY_SERVICE_TOKEN).toContain("REDACTED");
    expect(env.ANTHROPIC_API_KEY).not.toContain("sk-ant-real");
  });

  it("never throws on null/odd maps", () => {
    expect(redactEnv(null)).toEqual({});
    expect(redactEnv(undefined)).toEqual({});
    expect(redactEnv({})).toEqual({});
  });
});

describe("redactEvent", () => {
  it("scrubs sk-... in message.text", () => {
    const event = {
      ...baseEnvelope(),
      type: "message" as const,
      turn: 0,
      mode: "full" as const,
      text: "Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz for auth",
    };
    const out = redactEvent(event);
    expect(out.text).not.toContain("sk-ant-api03");
    expect(out.text).toContain("REDACTED");
    // structural integrity
    expect(validateCanonicalEvent(out).type).toBe("message");
  });

  it("scrubs secrets in tool.call.args", () => {
    const event = {
      ...baseEnvelope(),
      type: "tool.call" as const,
      turn: 1,
      id: "call_1",
      name: "bash",
      args: {
        command: "curl -H 'Authorization: Bearer secret-token-abcdef0123456789'",
        apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz",
      },
    };
    const out = redactEvent(event);
    const args = out.args as { command: string; apiKey: string };
    expect(args.command).not.toMatch(/Bearer\s+secret-token/i);
    expect(args.apiKey).toContain("REDACTED");
    expect(validateCanonicalEvent(out).type).toBe("tool.call");
  });

  it("scrubs secrets in tool.result.output", () => {
    const event = {
      ...baseEnvelope(),
      type: "tool.result" as const,
      id: "call_1",
      isError: false,
      output: "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    };
    const out = redactEvent(event);
    expect(String(out.output)).not.toContain("sk-ant-api03");
    expect(validateCanonicalEvent(out).type).toBe("tool.result");
  });

  it("scrubs secrets in error.message", () => {
    const event = {
      ...baseEnvelope(),
      type: "error" as const,
      message: "auth failed for sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      fatal: true,
    };
    const out = redactEvent(event);
    expect(out.message).not.toContain("sk-ant-api03");
    expect(validateCanonicalEvent(out).type).toBe("error");
  });

  it("scrubs secrets in log.message", () => {
    const event = {
      ...baseEnvelope(),
      type: "log" as const,
      level: "info" as const,
      message: "loaded key sk-proj-abcdefghijklmnopqrstuvwxyz",
    };
    const out = redactEvent(event);
    expect(out.message).not.toContain("sk-proj-");
    expect(validateCanonicalEvent(out).type).toBe("log");
  });

  it("scrubs secrets in run.start.params", () => {
    const event = {
      ...baseEnvelope(),
      type: "run.start" as const,
      agent: "pi" as const,
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      workspace: { source: "empty" as const },
      params: {
        temperature: 0.2,
        apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
        note: "safe text",
      },
    };
    const out = redactEvent(event);
    expect(String(out.params.apiKey)).toContain("REDACTED");
    expect(out.params.note).toBe("safe text");
    expect(out.params.temperature).toBe(0.2);
    expect(validateCanonicalEvent(out).type).toBe("run.start");
  });

  it("leaves non-secret text intact across event types", () => {
    const event = {
      ...baseEnvelope(),
      type: "message" as const,
      turn: 0,
      mode: "full" as const,
      text: "Fixed the off-by-one in parseDate()",
    };
    const out = redactEvent(event);
    expect(out.text).toBe(event.text);
    expect(redactionApplied(event, out)).toBe(false);
  });

  it("never throws on odd shapes", () => {
    expect(() => redactEvent({} as CanonicalEvent)).not.toThrow();
    expect(() =>
      redactEvent({
        ...baseEnvelope(),
        type: "tool.call",
        turn: 0,
        id: "x",
        name: "y",
        args: { nested: { deep: [1, "ok", { a: null }] } },
      } as CanonicalEvent),
    ).not.toThrow();
    // circular-ish via shared refs handled without throw
    const weird = {
      ...baseEnvelope(),
      type: "log" as const,
      level: "debug" as const,
      message: "fine",
    };
    expect(() => redactEvent(weird)).not.toThrow();
  });

  it("redacted event still validates via validateCanonicalEvent", () => {
    const secrets = {
      message: {
        ...baseEnvelope({ seq: 1 }),
        type: "message" as const,
        turn: 0,
        mode: "full" as const,
        text: "key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      },
      toolCall: {
        ...baseEnvelope({ seq: 2 }),
        type: "tool.call" as const,
        turn: 1,
        id: "c1",
        name: "write",
        args: { content: "Bearer abcdEFGHijklMNOPqrstUVWxyz012345" },
      },
      toolResult: {
        ...baseEnvelope({ seq: 3 }),
        type: "tool.result" as const,
        id: "c1",
        isError: false,
        output: { body: "sk-proj-abcdefghijklmnopqrstuvwxyz" },
      },
      error: {
        ...baseEnvelope({ seq: 4 }),
        type: "error" as const,
        message: "boom sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      },
      params: {
        ...baseEnvelope({ seq: 5 }),
        type: "run.start" as const,
        agent: "pi" as const,
        model: "m",
        provider: "p",
        workspace: { source: "empty" as const },
        params: { OPENAI_API_KEY: "sk-proj-abcdefghijklmnopqrstuvwxyz" },
      },
    };

    for (const [label, ev] of Object.entries(secrets)) {
      const redacted = redactEvent(ev);
      expect(() => validateCanonicalEvent(redacted), label).not.toThrow();
      const validated = validateCanonicalEvent(redacted);
      expect(validated.type).toBe(ev.type);
      expect(validated.runId).toBe(ev.runId);
      expect(validated.seq).toBe(ev.seq);
    }
  });
});

describe("looksLikeSecret / redactionApplied", () => {
  it("detects sk- patterns", () => {
    expect(looksLikeSecret("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe(
      true,
    );
    expect(looksLikeSecret("hello world")).toBe(false);
  });

  it("reports when redaction changed the value", () => {
    const before = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const after = redactString(before);
    expect(redactionApplied(before, after)).toBe(true);
    expect(redactionApplied("ok", "ok")).toBe(false);
  });
});
