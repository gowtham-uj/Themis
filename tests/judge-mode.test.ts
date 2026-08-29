/**
 * Judge run mode — platform findings surface only in dev mode.
 * `evalJudge.yaml` is the agent-improvement deliverable; harness/infra findings
 * must not leak into it in prod (default).
 */
import { describe, expect, it } from "vitest";

import { judgeMode, isDevJudgeMode } from "../src/judge/config/mode.ts";

describe("judgeMode", () => {
  it("defaults to prod when THEMIS_MODE is unset or anything but 'dev'", () => {
    expect(judgeMode({})).toBe("prod");
    expect(judgeMode({ THEMIS_MODE: "prod" })).toBe("prod");
    expect(judgeMode({ THEMIS_MODE: "production" })).toBe("prod");
    expect(judgeMode({ THEMIS_MODE: "" })).toBe("prod");
  });

  it("opts into dev mode only for the literal 'dev' value (case-insensitive)", () => {
    expect(judgeMode({ THEMIS_MODE: "dev" })).toBe("dev");
    expect(judgeMode({ THEMIS_MODE: "DEV" })).toBe("dev");
    expect(isDevJudgeMode({ THEMIS_MODE: "dev" })).toBe(true);
    expect(isDevJudgeMode({})).toBe(false);
  });
});
