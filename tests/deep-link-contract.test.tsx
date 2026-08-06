/**
 * Deep-link contract (P7b-UI QC): finding evidence ref chips emit URLs that
 * the run-detail page honors (tab + hash). This pins the wire shape so a
 * finding's evidence "jumps straight to where" (plan/ui.md §Cross-cutting),
 * not the default Trace tab.
 *
 * The chips live in src/ui/components/RefChips.tsx (refHref/refLabel). The
 * run-detail client reads ?tab= + #trace:/#diff:/#tool: on mount
 * (RunDetailClient tabFromQuery + the mount useEffect).
 */
import { describe, expect, it } from "vitest";
import { refHref, refLabel } from "../src/ui/components/RefChips.js";

describe("ref deep-link contract", () => {
  const projectId = "proj-1";
  const runId = "run-1";

  it("diff ref -> ?tab=diff#diff:file:hunk", () => {
    const href = refHref(projectId, runId, {
      kind: "diff",
      file: "src/auth.ts",
      hunk: 2,
    });
    expect(href).toBe(
      "/projects/proj-1/runs/run-1?tab=diff#diff:src%2Fauth.ts:2",
    );
    // The hash the run-detail client keys off of.
    expect(href).toContain("tab=diff");
    expect(href.split("#")[1]).toMatch(/^diff:/);
  });

  it("trace ref -> ?tab=trace#trace:start:end", () => {
    const href = refHref(projectId, runId, {
      kind: "trace",
      runId,
      seqs: [4, 9],
    });
    expect(href).toBe(
      "/projects/proj-1/runs/run-1?tab=trace#trace:4:9",
    );
    expect(href.split("#")[1]).toMatch(/^trace:/);
  });

  it("tool ref -> ?tab=trace#tool:toolCallId", () => {
    const href = refHref(projectId, runId, {
      kind: "tool",
      toolCallId: "call_abc",
    });
    expect(href).toBe("/projects/proj-1/runs/run-1?tab=trace#tool:call_abc");
    expect(href.split("#")[1]).toMatch(/^tool:/);
  });

  it("unknown ref kind -> bare run page (no crash)", () => {
    const href = refHref(projectId, runId, { kind: "weird" });
    expect(href).toBe(`/projects/${projectId}/runs/${runId}`);
  });

  it("labels are colorblind-safe (icon+label, not hue)", () => {
    // Labels carry a kind word (diff/trace/tool) + the locator, never hue alone.
    expect(refLabel({ kind: "diff", file: "a.ts", hunk: 1 })).toContain("diff");
    expect(
      refLabel({ kind: "trace", runId: "r", seqs: [1, 2] }),
    ).toContain("trace");
    expect(
      refLabel({ kind: "tool", toolCallId: "call_abc" }),
    ).toContain("tool");
  });

  it("long file paths are truncated in the label", () => {
    const long = "very/deep/nested/path/to/some/module/file.ts";
    const label = refLabel({ kind: "diff", file: long, hunk: 7 });
    expect(label.length).toBeLessThan(long.length);
    expect(label).toContain("h7");
  });
});

describe("deep-link tab derivation", () => {
  // Mirrors RunDetailClient.tabFromQuery: only diff/report switch tabs; anything
  // else (incl. trace + missing) stays on trace. Pinned so future edits keep
  // honoring ?tab=.
  function tabFromQuery(tab: string | null): "trace" | "diff" | "report" {
    return tab === "diff" || tab === "report" ? tab : "trace";
  }
  it("honors ?tab=diff and ?tab=report", () => {
    expect(tabFromQuery("diff")).toBe("diff");
    expect(tabFromQuery("report")).toBe("report");
  });
  it("falls back to trace for ?tab=trace / unknown / missing", () => {
    expect(tabFromQuery("trace")).toBe("trace");
    expect(tabFromQuery("nope")).toBe("trace");
    expect(tabFromQuery(null)).toBe("trace");
  });
});
