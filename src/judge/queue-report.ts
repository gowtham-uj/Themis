/** Render one complete queue-analysis revision as a standalone HTML report. */

import type {
  EvalJudgementNarrative,
  ImprovementOwnerClass,
  QueueImprovementStep,
  QueueWideAnalysis,
} from "./queue-schema.js";
import type { Ref, Verdict } from "./verdict.js";

export type { QueueWideAnalysis } from "./queue-schema.js";

export interface QueueReportEval {
  runId: string;
  taskName: string;
  verdict: Verdict;
  narrative: EvalJudgementNarrative;
}

/** Produce a portable narrative-first report from validated queue-analysis v2 data. */
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
  const defects = [...input.queue.rankedDefects]
    .sort((a, b) => a.rank - b.rank)
    .map(
      (defect) => `<article class="defect severity-${escapeAttr(defect.severity)}">
        <div class="rank">#${defect.rank}</div><div><h3>${escapeHtml(defect.title)}</h3>
        <p>${escapeHtml(defect.description)}</p><div class="meta">${escapeHtml(defect.category)} · ${escapeHtml(defect.severity)} · runs ${defect.runIds.map(escapeHtml).join(", ")}</div>
        ${refs(defect.evidence)}${list(defect.verification, "Verification")}</div></article>`,
    )
    .join("");
  const subsystemAttribution = input.queue.subsystemAttribution
    .map((entry) => `<article class="step"><h3>${escapeHtml(entry.subsystem)}</h3><p>${escapeHtml(entry.explanation)}</p><div class="meta">runs ${entry.runIds.map(escapeHtml).join(", ")}</div>${refs(entry.evidence)}</article>`)
    .join("");
  const evals = input.evals.map(renderEval).join("");
  const backlogs = (["agent", "platform", "judge", "eval"] as ImprovementOwnerClass[])
    .map((owner) => renderBacklog(owner, input.queue.improvementPlan))
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.queueName)} · agenteval queue report</title>
<style>
:root{color-scheme:dark;--bg:#07100d;--panel:#101c17;--panel2:#15251e;--text:#effaf4;--muted:#9eb7aa;--line:#294136;--green:#62e6a7;--amber:#ffc766;--red:#ff7c83;--blue:#78b9ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#17372a 0,transparent 34%),var(--bg);color:var(--text);font:15px/1.55 Inter,ui-sans-serif,system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:56px 28px 90px}.hero,.card,.eval,.backlog{border:1px solid var(--line);background:var(--panel);border-radius:18px;padding:24px}.hero{background:linear-gradient(135deg,#14271fdd,#0c1713dd);padding:34px;border-radius:22px;box-shadow:0 24px 80px #0007}.eyebrow{text-transform:uppercase;letter-spacing:.14em;color:var(--green);font-size:11px;font-weight:800}h1{font-size:clamp(34px,6vw,70px);line-height:.98;margin:12px 0 18px;max-width:900px}h2{font-size:27px;margin:4px 0}h3{margin:0 0 8px}.hero p,.summary,.judgement{font-size:17px;color:#c9ded3;max-width:900px}.facts{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}.facts span,.pill,.ref{border:1px solid var(--line);background:#0b1712;padding:6px 10px;border-radius:999px;color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:20px 0}.defect{display:grid;grid-template-columns:48px 1fr;gap:14px;border:1px solid var(--line);background:var(--panel2);padding:18px;border-radius:14px;margin:10px 0}.rank,.priority{font-size:20px;color:var(--amber);font-weight:900}.meta{color:var(--muted);font-size:12px}.eval{margin:18px 0}.eval-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.score{min-width:112px;text-align:center;border:1px solid var(--line);border-radius:14px;padding:12px;background:#0b1712}.score strong{display:block;font-size:32px;color:var(--green)}.score span{color:var(--muted);text-transform:uppercase;font-size:11px;letter-spacing:.12em}.section{border-top:1px solid var(--line);padding-top:18px;margin-top:22px}.timeline,.claims,.plan{list-style:none;padding:0}.timeline li,.claims li,.plan li{padding:12px 0;border-bottom:1px solid var(--line)}.concern{border-left:3px solid var(--amber);padding-left:12px!important}.refs{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.ref{color:var(--blue);padding:3px 8px}.handoff{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.handoff>div{background:#0b1712;border:1px solid var(--line);padding:14px;border-radius:12px}.backlogs{display:grid;grid-template-columns:1fr 1fr;gap:18px}.backlog{margin-top:18px}.step{background:#0b1712;border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}.step-head{display:flex;gap:12px;align-items:flex-start}.target{color:var(--green);font-family:ui-monospace,monospace;font-size:12px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:11px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}footer{color:var(--muted);margin-top:35px;font-size:12px}@media(max-width:800px){.grid,.backlogs,.handoff{grid-template-columns:1fr}.eval-head{display:block}.score{margin-top:12px;width:112px}main{padding:28px 16px}}
</style></head><body><main>
<section class="hero"><div class="eyebrow">agenteval · queue analysis v${input.queue.schemaVersion}</div><h1>${escapeHtml(input.queueName)}</h1><p>${escapeHtml(input.queue.summary)}</p><div class="facts"><span>${escapeHtml(input.projectName)}</span><span>batch ${escapeHtml(input.batchId)}</span><span>${escapeHtml(input.provider)} / ${escapeHtml(input.model)}</span><span>${input.evals.length} evals</span></div></section>
<div class="grid"><section class="card"><div class="eyebrow">Cross-eval themes</div>${claims(input.queue.themes)}</section><section class="card"><div class="eyebrow">Reliability</div><p>${escapeHtml(input.queue.reliability.assessment)}</p>${refs(input.queue.reliability.evidence)}</section></div>
<section class="card"><div class="eyebrow">Ranked observed defects</div>${defects || "<p>No queue-wide defects.</p>"}</section>
<div class="grid"><section class="card"><div class="eyebrow">Subsystem attribution</div>${subsystemAttribution || "<p>No subsystem attribution.</p>"}</section><section class="card"><div class="eyebrow">Regressions</div>${claims(input.queue.regressions)}</section></div>
<section><div class="eyebrow" style="margin-top:32px">Per-eval verdicts and narratives</div>${evals}</section>
<section><div class="eyebrow" style="margin-top:32px">Owner backlogs</div><div class="backlogs">${backlogs}</div></section>
<footer>Analysis ${escapeHtml(input.analysisId)} · generated ${escapeHtml(input.createdAt)} · immutable evidence revisions retained by agenteval</footer>
</main></body></html>`;
}

function renderEval(entry: QueueReportEval): string {
  const overall = entry.verdict.overall;
  const narrative = entry.narrative;
  const scores = entry.verdict.criteria
    .map((score) => `<tr><td>${escapeHtml(score.criterion)}</td><td>${score.score.toFixed(2)}</td><td>${escapeHtml(score.feedback)}</td></tr>`)
    .join("");
  const findings = entry.verdict.findings
    .map((finding) => `<li class="concern"><strong>${escapeHtml(finding.claim)}</strong> <span class="pill">${escapeHtml(finding.severity)}</span>${refs(finding.refs)}</li>`)
    .join("");
  const execution = narrative.executionAnalysis
    .map((stage) => `<li><strong>${escapeHtml(stage.stage)}</strong><p>${escapeHtml(stage.judgement)}</p>${refs(stage.refs)}</li>`)
    .join("");
  const concerns = narrative.concerns
    .map((concern) => `<li class="concern"><strong>${escapeHtml(concern.text)}</strong> <span class="pill">${escapeHtml(concern.severity)} · ${escapeHtml(concern.ownerClass)}</span><p>${escapeHtml(concern.implication)}</p>${refs(concern.refs)}</li>`)
    .join("");
  const boundaries = narrative.evidenceBoundaries
    .map((boundary) => `<li><span class="pill">${escapeHtml(boundary.status)}</span> ${escapeHtml(boundary.text)}${refs(boundary.refs)}</li>`)
    .join("");
  return `<article class="eval">
    <div class="eval-head"><div><div class="eyebrow">${escapeHtml(entry.runId)}</div><h2>${escapeHtml(entry.taskName)}</h2></div><div class="score"><strong>${overall.score.toFixed(2)}</strong><span>${escapeHtml(overall.verdict)}</span></div></div>
    <section class="section"><div class="eyebrow">Narrative</div><h3>${escapeHtml(narrative.headline)}</h3><p class="judgement">${escapeHtml(narrative.judgement)}</p></section>
    <section class="section"><div class="eyebrow">Execution timeline</div><ol class="timeline">${execution}</ol></section>
    <section class="section"><div class="eyebrow">Strengths</div>${claims(narrative.strengths)}</section>
    <section class="section"><div class="eyebrow">Concerns</div><ul class="claims">${concerns || "<li>No evidence-linked concerns.</li>"}</ul><h3>Evidence boundaries</h3><ul class="claims">${boundaries}</ul></section>
    <section class="section"><div class="eyebrow">Criteria</div><table><thead><tr><th>Criterion</th><th>Score</th><th>Rationale</th></tr></thead><tbody>${scores}</tbody></table></section>
    <section class="section"><div class="eyebrow">Located findings</div><ul class="claims">${findings || "<li>No findings.</li>"}</ul></section>
    <section class="section"><div class="eyebrow">Handoff</div>${handoff(narrative)}</section>
  </article>`;
}

function renderBacklog(owner: ImprovementOwnerClass, steps: QueueImprovementStep[]): string {
  const owned = [...steps].filter((step) => step.class === owner).sort((a, b) => a.rank - b.rank);
  return `<section class="backlog"><div class="eyebrow">${escapeHtml(owner)} backlog</div>${owned.length === 0 ? "<p>No observed work assigned.</p>" : owned.map(renderStep).join("")}</section>`;
}

function renderStep(step: QueueImprovementStep): string {
  return `<article class="step"><div class="step-head"><div class="priority">#${step.rank}</div><div><h3>${escapeHtml(step.problem)}</h3><div class="meta">P${step.priority} · ${escapeHtml(step.status)} · confidence ${step.confidence.toFixed(2)} · defects ${step.defectIds.map(escapeHtml).join(", ")}</div></div></div>
    <p>${escapeHtml(step.change)}</p><p class="target">${escapeHtml(targetText(step))}</p>${refs(step.evidence)}
    ${list(step.acceptanceCriteria, "Acceptance criteria")}${list(step.tests.map((test) => `${test.kind}: ${test.name} — ${test.expected}${test.command ? ` (${test.command})` : ""}`), "Tests")}
    ${list(step.verifyTaskIds, "Verify tasks")}${list(step.regressionTaskIds, "Regression tasks")}${list(step.dependencies, "Dependencies")}${list(step.nonGoals, "Non-goals")}
    ${step.blockingReason ? `<p><strong>Blocked:</strong> ${escapeHtml(step.blockingReason)}</p>` : ""}</article>`;
}

function targetText(step: QueueImprovementStep): string {
  return step.target.kind === "external"
    ? `external:${step.target.system} — ${step.target.blocker}`
    : `${step.target.kind}:${step.target.paths.join(", ")}`;
}

function handoff(narrative: EvalJudgementNarrative): string {
  return `<div class="handoff">${(["preserve", "change", "investigate"] as const).map((key) =>
    `<div><h3>${escapeHtml(key)}</h3>${claims(narrative.handoff[key], true)}</div>`).join("")}</div>`;
}

function claims(items: Array<{ text: string; refs: Ref[]; ownerClass?: ImprovementOwnerClass }>, showOwner = false): string {
  if (items.length === 0) return "<p>None.</p>";
  return `<ul class="claims">${items.map((item) => `<li>${showOwner && item.ownerClass ? `<span class="pill">${escapeHtml(item.ownerClass)}</span> ` : ""}${escapeHtml(item.text)}${refs(item.refs)}</li>`).join("")}</ul>`;
}

function refs(items: Ref[]): string {
  if (items.length === 0) return "";
  return `<div class="refs">${items.map((item) => `<span class="ref">${escapeHtml(refText(item))}</span>`).join("")}</div>`;
}

function refText(ref: Ref): string {
  if (ref.kind === "trace") return `trace:${ref.runId}#${ref.seqs[0]}-${ref.seqs[1]}`;
  if (ref.kind === "tool") return `tool:${ref.toolCallId}`;
  if (ref.kind === "diff") return `diff:${ref.file}#${ref.hunk}`;
  return `artifact:${ref.path}`;
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
