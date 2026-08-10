/** Render one complete queue-analysis revision as a standalone HTML report. */

import type { Verdict } from "./verdict.js";

export interface QueueWideAnalysis {
  summary: string;
  themes: string[];
  reliability: {
    assessment: string;
    evidence: string[];
  };
  rankedDefects: Array<{
    rank: number;
    title: string;
    severity: string;
    runIds: string[];
    description: string;
    verification?: string[];
  }>;
  subsystemAttribution: Array<{
    subsystem: string;
    runIds: string[];
    evidence: string;
  }>;
  regressions: string[];
  improvementPlan: Array<{
    priority: number;
    action: string;
    rationale: string;
    verification: string[];
  }>;
}

export interface QueueReportEval {
  runId: string;
  taskName: string;
  verdict: Verdict;
}

/** Produce a portable report with queue-wide analysis and every eval verdict. */
export function renderQueueReport(input: {
  projectName: string;
  queueName: string;
  batchId: string;
  analysisId: string;
  model: string;
  provider: string;
  createdAt: string;
  queue: QueueWideAnalysis;
  evals: QueueReportEval[];
}): string {
  const defects = input.queue.rankedDefects
    .map(
      (defect) => `<article class="defect severity-${escapeAttr(defect.severity.toLowerCase())}">
        <div class="rank">#${defect.rank}</div>
        <div><h3>${escapeHtml(defect.title)}</h3><p>${escapeHtml(defect.description)}</p>
        <div class="meta">${escapeHtml(defect.severity)} · runs ${defect.runIds.map(escapeHtml).join(", ")}</div>
        ${list(defect.verification ?? [], "Verification")}</div>
      </article>`,
    )
    .join("");
  const evals = input.evals
    .map((entry) => {
      const overall = entry.verdict.overall;
      const findings = (entry.verdict.findings ?? [])
        .map(
          (finding) => `<li><strong>${escapeHtml(finding.claim)}</strong><span class="pill">${escapeHtml(finding.severity)}</span><p>${escapeHtml(finding.category)}</p></li>`,
        )
        .join("");
      const scores = entry.verdict.criteria
        .map(
          (score) => `<tr><td>${escapeHtml(score.criterion)}</td><td>${score.score.toFixed(2)}</td><td>${escapeHtml(score.feedback)}</td></tr>`,
        )
        .join("");
      return `<section class="eval">
        <div class="eval-head"><div><div class="eyebrow">${escapeHtml(entry.runId)}</div><h2>${escapeHtml(entry.taskName)}</h2></div>
        <div class="score"><strong>${overall.score.toFixed(2)}</strong><span>${escapeHtml(overall.verdict)}</span></div></div>
        <p class="summary">${escapeHtml(overall.summary)}</p>
        <table><thead><tr><th>Criterion</th><th>Score</th><th>Rationale</th></tr></thead><tbody>${scores}</tbody></table>
        <h3>Findings</h3><ul class="findings">${findings || "<li>No findings.</li>"}</ul>
      </section>`;
    })
    .join("");
  const plan = input.queue.improvementPlan
    .sort((a, b) => a.priority - b.priority)
    .map(
      (item) => `<li><div class="priority">P${item.priority}</div><div><strong>${escapeHtml(item.action)}</strong><p>${escapeHtml(item.rationale)}</p>${list(item.verification, "Verify")}</div></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.queueName)} · agenteval queue report</title>
<style>
:root{color-scheme:dark;--bg:#07100d;--panel:#101c17;--panel2:#15251e;--text:#effaf4;--muted:#9eb7aa;--line:#294136;--green:#62e6a7;--amber:#ffc766;--red:#ff7c83}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#17372a 0,transparent 34%),var(--bg);color:var(--text);font:15px/1.55 Inter,ui-sans-serif,system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:56px 28px 90px}.hero{border:1px solid var(--line);background:linear-gradient(135deg,#14271fdd,#0c1713dd);padding:34px;border-radius:22px;box-shadow:0 24px 80px #0007}.eyebrow{text-transform:uppercase;letter-spacing:.14em;color:var(--green);font-size:11px;font-weight:800}h1{font-size:clamp(34px,6vw,70px);line-height:.98;margin:12px 0 18px;max-width:900px}h2{font-size:27px;margin:4px 0}h3{margin:0 0 8px}.hero p,.summary{font-size:17px;color:#c9ded3;max-width:900px}.facts{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}.facts span,.pill{border:1px solid var(--line);background:#0b1712;padding:6px 10px;border-radius:999px;color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:20px 0}.card,.eval{border:1px solid var(--line);background:var(--panel);border-radius:18px;padding:24px}.card ul{margin:10px 0 0;padding-left:20px}.defect{display:grid;grid-template-columns:48px 1fr;gap:14px;border:1px solid var(--line);background:var(--panel2);padding:18px;border-radius:14px;margin:10px 0}.rank{font-size:20px;color:var(--amber);font-weight:900}.meta{color:var(--muted);font-size:12px}.eval{margin:18px 0}.eval-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.score{min-width:112px;text-align:center;border:1px solid var(--line);border-radius:14px;padding:12px;background:#0b1712}.score strong{display:block;font-size:32px;color:var(--green)}.score span{color:var(--muted);text-transform:uppercase;font-size:11px;letter-spacing:.12em}table{width:100%;border-collapse:collapse;margin:16px 0 24px}th,td{text-align:left;padding:11px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}.findings{list-style:none;padding:0}.findings li{border-left:3px solid var(--amber);padding:10px 14px;margin:8px 0;background:#0b1712}.findings .pill{margin-left:8px}.plan{list-style:none;padding:0}.plan li{display:grid;grid-template-columns:48px 1fr;gap:14px;padding:14px 0;border-bottom:1px solid var(--line)}.priority{color:var(--green);font-weight:900}footer{color:var(--muted);margin-top:35px;font-size:12px}@media(max-width:760px){.grid{grid-template-columns:1fr}.eval-head{display:block}.score{margin-top:12px;width:112px}main{padding:28px 16px}}
</style></head><body><main>
<section class="hero"><div class="eyebrow">agenteval · queue analysis revision</div><h1>${escapeHtml(input.queueName)}</h1><p>${escapeHtml(input.queue.summary)}</p><div class="facts"><span>${escapeHtml(input.projectName)}</span><span>batch ${escapeHtml(input.batchId)}</span><span>${escapeHtml(input.provider)} / ${escapeHtml(input.model)}</span><span>${input.evals.length} evals</span></div></section>
<div class="grid"><section class="card"><div class="eyebrow">Cross-eval themes</div>${list(input.queue.themes)}</section><section class="card"><div class="eyebrow">Reliability</div><p>${escapeHtml(input.queue.reliability.assessment)}</p>${list(input.queue.reliability.evidence)}</section></div>
<section class="card"><div class="eyebrow">Ranked defects</div>${defects || "<p>No queue-wide defects.</p>"}</section>
<section><div class="eyebrow" style="margin-top:32px">Per-eval verdicts</div>${evals}</section>
<section class="card"><div class="eyebrow">Improvement plan</div><ol class="plan">${plan}</ol></section>
<footer>Analysis ${escapeHtml(input.analysisId)} · generated ${escapeHtml(input.createdAt)} · immutable evidence revisions retained by agenteval</footer>
</main></body></html>`;
}

function list(items: string[], label?: string): string {
  if (items.length === 0) return "";
  return `${label ? `<strong>${escapeHtml(label)}</strong>` : ""}<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value: unknown): string {
  return String(value ?? "").replace(/[^a-z0-9_-]/gi, "-");
}
