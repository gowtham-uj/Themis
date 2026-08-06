/**
 * Behavioral / structural tests for the pure verdict HTML report renderer.
 * Assert structure, ordering, escaping, self-containment — not pixel layout.
 * Spec: plan/judge.md §"Report-generation skill", Phase 5a.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SEVERITY_ORDER,
  validateVerdict,
  type Finding,
  type Verdict,
} from "../src/judge/verdict.ts";
import {
  renderVerdictReport,
  refHref,
  refLabel,
  type ReportContext,
} from "../src/judge/report/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplePath = join(__dirname, "fixtures", "verdict-sample.json");
const sampleVerdict = JSON.parse(readFileSync(samplePath, "utf8")) as Verdict;

const sampleCtx: ReportContext = {
  runId: "run-sample-001",
  taskId: "task-auth",
  taskPrompt: "Fix the auth empty-token path",
  agentCategory: "coding",
  agent: "pi",
  model: "test-model",
  judgeModel: "judge-model",
  systemPromptVersion: "v2",
  judgedAt: "2026-08-06T12:00:00.000Z",
  hasSourceArtifacts: true,
  runMetadata: {
    status: "completed",
    durationMs: 12_450,
    tokens: { input: 4200, output: 1800, total: 6000 },
  },
};

function cloneVerdict(v: Verdict): Verdict {
  return JSON.parse(JSON.stringify(v)) as Verdict;
}

describe("report renderer (P5a)", () => {
  it("fixture passes validateVerdict before rendering (defense in depth)", () => {
    expect(() =>
      validateVerdict(sampleVerdict, { hasSourceArtifacts: true }),
    ).not.toThrow();
  });

  it("returns a complete non-empty HTML document", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    expect(html.length).toBeGreaterThan(500);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  it("is deterministic for the same inputs", () => {
    const a = renderVerdictReport(sampleVerdict, sampleCtx);
    const b = renderVerdictReport(sampleVerdict, sampleCtx);
    expect(a).toBe(b);
  });

  it("contains major section anchor ids", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    for (const id of [
      "findings",
      "improvements",
      "criteria",
      "diagnostics",
      "positive-findings",
      "observations",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("findings spine comes before improvements and criteria", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    const iFindings = html.indexOf('id="findings"');
    const iImprovements = html.indexOf('id="improvements"');
    const iCriteria = html.indexOf('id="criteria"');
    expect(iFindings).toBeGreaterThan(-1);
    expect(iImprovements).toBeGreaterThan(-1);
    expect(iCriteria).toBeGreaterThan(-1);
    expect(iFindings).toBeLessThan(iImprovements);
    expect(iFindings).toBeLessThan(iCriteria);
    // Improvements before criteria (plan/roadmap Phase 5 order).
    expect(iImprovements).toBeLessThan(iCriteria);
  });

  it("orders findings by SEVERITY_ORDER via data-severity attrs", () => {
    // Build a verdict with mixed severities to prove ordering.
    const v = cloneVerdict(sampleVerdict);
    v.findings = [
      {
        id: "nit-1",
        category: "doc_missing",
        severity: "nit",
        confidence: 0.5,
        claim: "nit claim",
        refs: [{ kind: "tool", toolCallId: "t1" }],
      },
      {
        id: "blocker-1",
        category: "security_concern",
        severity: "blocker",
        confidence: 0.9,
        claim: "blocker claim",
        refs: [{ kind: "trace", runId: "r", seqs: [1, 2] }],
      },
      {
        id: "minor-1",
        category: "efficiency",
        severity: "minor",
        confidence: 0.7,
        claim: "minor claim",
        refs: [{ kind: "tool", toolCallId: "t2" }],
      },
      {
        id: "major-1",
        category: "verification_skipped",
        severity: "major",
        confidence: 0.8,
        claim: "major claim",
        refs: [{ kind: "trace", runId: "r", seqs: [3, 4] }],
      },
    ];
    // Drop criterion findingIds that no longer exist.
    v.criteria = v.criteria.map((c) => ({ ...c, findingIds: [] }));
    v.improvements = {
      summary: "test",
      withoutSource: [
        {
          area: "verification",
          priority: "high",
          change: "x",
          why: "y",
          refs: [{ kind: "trace", runId: "r", seqs: [1, 2] }],
          linkedFindings: ["blocker-1"],
        },
      ],
    };
    validateVerdict(v, { hasSourceArtifacts: false });

    const html = renderVerdictReport(v, { hasSourceArtifacts: false });
    // Only within the findings section (not positive).
    const findingsSection = html.slice(
      html.indexOf('id="findings"'),
      html.indexOf('id="improvements"'),
    );
    const re = /data-severity="(blocker|major|minor|nit)"/g;
    const order: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(findingsSection)) !== null) {
      order.push(m[1]!);
    }
    expect(order).toEqual(["blocker", "major", "minor", "nit"]);
    // Matches SEVERITY_ORDER constant.
    expect(order).toEqual([...SEVERITY_ORDER]);
  });

  it("renders every finding claim and ref chips with correct href prefixes", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    for (const f of sampleVerdict.findings) {
      expect(html).toContain(f.claim);
      for (const r of f.refs) {
        const href = refHref(r);
        expect(html).toContain(`href="${href}"`);
        if (r.kind === "diff") expect(href.startsWith("#diff:")).toBe(true);
        if (r.kind === "trace") expect(href.startsWith("#trace:")).toBe(true);
        if (r.kind === "tool") expect(href.startsWith("#tool:")).toBe(true);
      }
    }
    // Positive findings claims too.
    for (const f of sampleVerdict.positiveFindings) {
      expect(html).toContain(f.claim);
    }
  });

  it("refLabel / refHref helpers produce the documented shapes", () => {
    expect(refHref({ kind: "diff", file: "src/auth.ts", hunk: 2 })).toBe(
      "#diff:src/auth.ts:2",
    );
    expect(refLabel({ kind: "diff", file: "src/auth.ts", hunk: 2 })).toBe(
      "src/auth.ts hunk 2",
    );
    expect(
      refLabel({ kind: "diff", file: "src/auth.ts", hunk: 2, lines: [14, 28] }),
    ).toBe("src/auth.ts hunk 2 L14–28");
    expect(
      refHref({ kind: "trace", runId: "run-sample-001", seqs: [40, 48] }),
    ).toBe("#trace:run-sample-001:40:48");
    expect(
      refLabel({ kind: "trace", runId: "run-sample-001", seqs: [40, 48] }),
    ).toBe("trace seq 40–48");
    expect(refHref({ kind: "tool", toolCallId: "call_read_auth_1" })).toBe(
      "#tool:call_read_auth_1",
    );
    expect(refLabel({ kind: "tool", toolCallId: "call_read_auth_1" })).toBe(
      "tool call call_read_auth_1",
    );
  });

  it("withSource lens gated: absent when no withSource; present with sample", () => {
    // WITH withSource (sample fixture)
    const withHtml = renderVerdictReport(sampleVerdict, sampleCtx);
    expect(withHtml).toContain('id="improvements-with-source"');
    expect(withHtml).toContain('data-lens="withSource"');
    // Sample withSource has a diff ref → chip with #diff:
    expect(withHtml).toContain("#diff:src/auth.ts:2");
    expect(withHtml).not.toContain(
      "no source-level recommendations (run has no source artifacts)",
    );

    // WITHOUT withSource
    const noSrc = cloneVerdict(sampleVerdict);
    delete noSrc.improvements.withSource;
    // Strip diff refs from findings so validateVerdict({hasSourceArtifacts:false}) can pass
    // when we want a true no-source case. But validateVerdict allows findings with diff refs
    // regardless of hasSourceArtifacts — only withSource is gated. Keep findings as-is;
    // only omit withSource.
    validateVerdict(noSrc, { hasSourceArtifacts: false });
    const noHtml = renderVerdictReport(noSrc, { hasSourceArtifacts: false });
    expect(noHtml).not.toContain('id="improvements-with-source"');
    expect(noHtml).toContain(
      "no source-level recommendations (run has no source artifacts)",
    );
    // Does not crash on the no-source case.
    expect(noHtml.startsWith("<!doctype html>")).toBe(true);
  });

  it("escapes HTML in user content (no executable payload)", () => {
    const v = cloneVerdict(sampleVerdict);
    const evil: Finding = {
      id: "evil:xss",
      category: "overclaim",
      severity: "minor",
      confidence: 0.5,
      claim: "<script>x</script>",
      refs: [{ kind: "tool", toolCallId: "t-evil" }],
    };
    v.findings = [evil];
    v.criteria = v.criteria.map((c) => ({ ...c, findingIds: [] }));
    v.improvements = {
      summary: "xss test",
      withoutSource: [
        {
          area: "honesty",
          priority: "low",
          change: "be careful",
          why: "payload",
          refs: [{ kind: "tool", toolCallId: "t-evil" }],
          linkedFindings: ["evil:xss"],
        },
      ],
    };
    validateVerdict(v, { hasSourceArtifacts: false });
    const html = renderVerdictReport(v);
    // Literal unescaped payload must NOT appear.
    expect(html).not.toContain("<script>x</script>");
    // Escaped form must appear.
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("is self-contained: inline style, no external src/link", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    expect(html).toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/src=["']https?:/i);
    expect(html).not.toMatch(/<link\s+[^>]*rel=["']stylesheet["']/i);
    expect(html).not.toMatch(/<script\s+[^>]*src=/i);
  });

  it("tooling markers: comment, viewport, print media", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    expect(html).toContain("<!-- @agenteval-report -->");
    expect(html).toMatch(/<meta\s+name="viewport"/);
    expect(html).toContain("@media print");
  });

  it("renders diagnostics as value/refs/note tiles (not bare booleans)", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    expect(html).toContain('data-diagnostic="hallucinated_success"');
    expect(html).toContain('data-value="true"');
    expect(html).toContain('data-value="false"');
    // Note text present.
    expect(html).toContain("No test/build/repro command appears");
  });

  it("renders criterion feedback before score and links findingIds", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    const a1Start = html.indexOf('data-criterion="A1"');
    expect(a1Start).toBeGreaterThan(-1);
    const a1Chunk = html.slice(a1Start, a1Start + 2500);
    const feedbackIdx = a1Chunk.indexOf("empty-token branch still returns 200");
    const scoreBarIdx = a1Chunk.indexOf("score-bar");
    expect(feedbackIdx).toBeGreaterThan(-1);
    expect(scoreBarIdx).toBeGreaterThan(-1);
    expect(feedbackIdx).toBeLessThan(scoreBarIdx);
    // findingIds link
    expect(html).toContain("incomplete_requirements:src/auth.ts#empty-token");
  });

  it("renders fix direction + repro code block when present", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    expect(html).toContain("Reject empty/missing tokens with 401");
    expect(html).toContain("expected: 401");
    expect(html).toContain("curl -s -o /dev/null");
  });

  it("renders metadata strip fields and token strip", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    expect(html).toContain("run-sample-001");
    expect(html).toContain("judge-model");
    expect(html).toContain("v2");
    expect(html).toContain("2026-08-06T12:00:00.000Z");
    expect(html).toContain("coding");
    // tokens
    expect(html).toMatch(/in 4,?200/);
    expect(html).toMatch(/total 6,?000/);
  });

  it("renders comparison when present", () => {
    const v = cloneVerdict(sampleVerdict);
    v.comparison = {
      vsRunId: "run-prior-000",
      direction: "regressed",
      why: "verification_skipped reappeared",
    };
    validateVerdict(v, { hasSourceArtifacts: true });
    const html = renderVerdictReport(v, sampleCtx);
    expect(html).toContain('id="comparison"');
    expect(html).toContain("run-prior-000");
    expect(html).toContain("Regressed");
    expect(html).toContain("verification_skipped reappeared");
  });

  it("renders attribution", () => {
    const html = renderVerdictReport(sampleVerdict, sampleCtx);
    expect(html).toContain('id="attribution"');
    expect(html).toContain("agent");
    expect(html).toContain("All gaps are within agent control");
  });

  it("works with empty optional ctx", () => {
    const html = renderVerdictReport(sampleVerdict);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('id="findings"');
  });
});

describe("report quality regressions (found by end-to-end run)", () => {
  it("renders observations exactly once", () => {
    // The renderer used to emit `observations` twice — once as "Notable
    // trajectory moments" and again as "Observations" — so every report shipped
    // a verbatim duplicate of the same list.
    const v = cloneVerdict(sampleVerdict);
    v.observations = ["a distinctive observation string"];
    const html = renderVerdictReport(v, sampleCtx);
    const occurrences = html.split("a distinctive observation string").length - 1;
    expect(occurrences).toBe(1);
    expect(html).not.toContain("Notable trajectory moments");
  });

  it("distinguishes a negative diagnostic from an unlocated positive one", () => {
    const v = cloneVerdict(sampleVerdict);
    v.diagnostics = {
      // false + no refs is correct: there is nothing to point at.
      looping: { value: false, refs: [], note: "no repetition" },
      // true + no refs is an unlocated claim — the thing the report exists to
      // prevent — so it must be called out rather than shown as a bare "No refs".
      test_gaming: { value: true, refs: [], note: "asserted" },
    };
    const html = renderVerdictReport(v, sampleCtx);
    expect(html).toContain("not observed");
    expect(html).toContain("asserted without evidence");
  });

  it("does not throw on a fix whose optional repro is absent", () => {
    const v = cloneVerdict(sampleVerdict);
    v.findings[0]!.fix = { direction: "do the thing" };
    expect(() => renderVerdictReport(v, sampleCtx)).not.toThrow();
    expect(renderVerdictReport(v, sampleCtx)).toContain("do the thing");
  });
});
