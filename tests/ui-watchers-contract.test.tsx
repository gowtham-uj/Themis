/**
 * Watchers + outbound-webhooks UI pure-helper contract tests (P8c-UI).
 *
 * Deep-link style: import pure helpers (hook URL builder, secret-once meta,
 * delivery status chip text) and assert their wire shapes — not full React
 * rendering. Mirrors tests/deep-link-contract.test.tsx.
 */
import { describe, expect, it } from "vitest";
import {
  formatWatcherAction,
  watcherEnabledLabel,
  watcherHookUrl,
} from "../src/ui/app/projects/[id]/watchers/WatchersClient.js";
import {
  deliveryStatusChipText,
  deliveryStatusColor,
  OUTBOUND_EVENT_TYPES,
  truncateResponseBody,
} from "../src/ui/app/projects/[id]/webhooks/WebhooksClient.js";
import { secretOnceRevealMeta } from "../src/ui/components/SecretOnceReveal.js";

describe("watcher hook URL contract", () => {
  it("builds POST /api/projects/:id/watcher/hooks/:ruleId", () => {
    const url = watcherHookUrl("proj-1", "rule-abc");
    expect(url).toBe("/api/projects/proj-1/watcher/hooks/rule-abc");
    // Exact path segments the HMAC ingress route registers.
    expect(url).toMatch(
      /^\/api\/projects\/[^/]+\/watcher\/hooks\/[^/]+$/,
    );
  });

  it("percent-encodes project + rule ids", () => {
    const url = watcherHookUrl("proj/with space", "rule:1");
    expect(url).toBe(
      "/api/projects/proj%2Fwith%20space/watcher/hooks/rule%3A1",
    );
    // Still under the watcher/hooks prefix (not watchers/:id/run).
    expect(url).toContain("/watcher/hooks/");
    expect(url).not.toContain("/watchers/");
  });
});

describe("secret-once reveal helper", () => {
  it("returns {shownOnce:true} semantics for a non-empty secret", () => {
    const meta = secretOnceRevealMeta("s3cr3t-value");
    expect(meta.shownOnce).toBe(true);
    expect(meta.hasSecret).toBe(true);
    expect(meta.secretLength).toBeGreaterThan(0);
  });

  it("hasSecret=false for empty/null but still shownOnce:true", () => {
    // shownOnce is a constant property of the reveal panel contract —
    // the panel itself may choose not to render when hasSecret is false.
    expect(secretOnceRevealMeta(null).shownOnce).toBe(true);
    expect(secretOnceRevealMeta(null).hasSecret).toBe(false);
    expect(secretOnceRevealMeta("").hasSecret).toBe(false);
    expect(secretOnceRevealMeta(undefined).hasSecret).toBe(false);
  });
});

describe("watcher action / enabled labels", () => {
  it("summarizes enqueue all/subset + tags + repeats", () => {
    expect(formatWatcherAction({ enqueue: "all" })).toContain("all");
    expect(
      formatWatcherAction({
        enqueue: "subset",
        taskTags: ["smoke", "reg"],
        repeats: 3,
        autoJudge: true,
      }),
    ).toMatch(/subset/);
    expect(
      formatWatcherAction({
        enqueue: "subset",
        taskTags: ["smoke"],
      }),
    ).toContain("smoke");
  });

  it("enabled label is colorblind-safe text (not hue alone)", () => {
    expect(watcherEnabledLabel(true)).toBe("enabled");
    expect(watcherEnabledLabel(false)).toBe("disabled");
  });
});

describe("delivery status chip text", () => {
  it("maps success/failed (and synonyms) to chip labels", () => {
    expect(deliveryStatusChipText("success")).toBe("success");
    expect(deliveryStatusChipText("failed")).toBe("failed");
    expect(deliveryStatusChipText("ok")).toBe("success");
    expect(deliveryStatusChipText("error")).toBe("failed");
    expect(deliveryStatusChipText(null)).toBe("failed");
  });

  it("status color classes include a border (not hue alone)", () => {
    expect(deliveryStatusColor("success")).toContain("border-");
    expect(deliveryStatusColor("failed")).toContain("border-");
  });

  it("truncates response bodies for the deliveries table", () => {
    const long = "x".repeat(200);
    const t = truncateResponseBody(long, 50);
    expect(t.length).toBeLessThanOrEqual(51); // 50 + ellipsis
    expect(t.endsWith("…")).toBe(true);
    expect(truncateResponseBody(null)).toBe("—");
    expect(truncateResponseBody("short")).toBe("short");
  });
});

describe("outbound event type multi-select options", () => {
  it("exposes the three primary event types from the UI form", () => {
    expect(OUTBOUND_EVENT_TYPES).toContain("run.completed");
    expect(OUTBOUND_EVENT_TYPES).toContain("verdict.completed");
    expect(OUTBOUND_EVENT_TYPES).toContain("release.compared");
    expect(OUTBOUND_EVENT_TYPES).toHaveLength(3);
  });
});
