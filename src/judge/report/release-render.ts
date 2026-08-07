/**
 * Release report renderer — one self-contained HTML page for a whole eval set.
 *
 * Answers the question a release reviewer actually has: "should this version
 * ship?" That is not a list of per-run reports side by side; it is the
 * cross-task view — what recurred, what regressed, what is unscored — with a
 * link into each run's own report for the detail.
 *
 * Pure: no I/O, deterministic for a given verdict. Reuses the per-run report's
 * stylesheet so both pages read as one product.
 */

import type {
  RecurringDefect,
  ReleaseComparison,
  ReleaseVerdict,
  TaskOutcome,
} from "../release-verdict.js";
import { escapeHtml, severityIcon } from "./render-helpers.js";
import { REPORT_STYLES } from "./styles.js";

/** Extra styles for the release-only sections. */
const RELEASE_STYLES = /* css */ `
.task-table { width:100%; border-collapse:collapse; margin-top:.75rem; font-size:.9rem; }
.task-table th, .task-table td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--border,#2a3140); }
.task-table th { font-weight:600; opacity:.75; font-size:.8rem; text-transform:uppercase; letter-spacing:.03em; }
.task-table tr[data-outcome="fail"] td:first-child { border-left:3px solid var(--sev-major,#d97706); }
.task-table tr[data-outcome="unjudged"] { opacity:.65; }
.score-cell { font-variant-numeric:tabular-nums; font-weight:600; }
.delta-up { color:var(--ok,#16a34a); }
.delta-down { color:var(--sev-critical,#dc2626); }
.recur-card { border:1px solid var(--border,#2a3140); border-radius:8px; padding:.75rem 1rem; margin:.6rem 0; }
.recur-tasks { font-size:.8rem; opacity:.8; margin-top:.35rem; }
.release-kpis { display:flex; flex-wrap:wrap; gap:1.25rem; margin:.75rem 0 0; }
.kpi { min-width:7rem; }
.kpi-value { font-size:1.6rem; font-weight:700; font-variant-numeric:tabular-nums; }
.kpi-label { font-size:.75rem; opacity:.7; text-transform:uppercase; letter-spacing:.03em; }
.plan-list { padding-left:1.2rem; }
.plan-step { margin:.9rem 0; }
.plan-head { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; }
.subsystem-chip { display:inline-block; padding:.1rem .5rem; border-radius:999px; border:1px solid var(--border,#2a3140); font-size:.75rem; text-transform:uppercase; letter-spacing:.03em; }
.chronic-badge { color:var(--sev-critical,#dc2626); font-size:.75rem; font-weight:600; }
.flaky-badge { color:var(--sev-major,#d97706); font-weight:600; }
.fail-badge { color:var(--sev-critical,#dc2626); font-weight:600; }
.verify-block { margin-top:.4rem; font-size:.85rem; opacity:.9; }
`;

/** Format a 0..1 score as a 2dp string, or an em dash when unscored. */
function fmtScore(score: number | null): string {
  return score === null ? "—" : score.toFixed(2);
}

/** Signed delta with direction class. */
function fmtDelta(delta: number | null): string {
  if (delta === null) return "";
  const cls = delta >= 0 ? "delta-up" : "delta-down";
  const sign = delta >= 0 ? "+" : "";
  return `<span class="${cls}">${sign}${delta.toFixed(2)}</span>`;
}

function renderKpis(v: ReleaseVerdict): string {
  const kpi = (value: string, label: string): string =>
    `<div class="kpi"><div class="kpi-value">${escapeHtml(value)}</div><div class="kpi-label">${escapeHtml(label)}</div></div>`;
  return [
    `<div class="release-kpis">`,
    kpi(v.overall.score.toFixed(2), "mean score"),
    kpi(`${v.overall.tasksPassed}/${v.overall.tasksJudged}`, "tasks passed"),
    kpi(String(v.recurringDefects.length), "recurring defects"),
    v.overall.runsUnjudged > 0 ? kpi(String(v.overall.runsUnjudged), "unjudged runs") : "",
    v.comparison?.delta != null
      ? `<div class="kpi"><div class="kpi-value">${fmtDelta(v.comparison.delta)}</div><div class="kpi-label">vs previous</div></div>`
      : "",
    `</div>`,
  ].join("");
}

function renderHeader(v: ReleaseVerdict): string {
  const ref = v.releaseRef ? ` · ${escapeHtml(v.releaseRef)}` : "";
  return [
    `<header class="verdict-header">`,
    `<h1>Release evaluation${ref}</h1>`,
    `<p class="verdict-summary">${escapeHtml(v.overall.summary)}</p>`,
    `<p class="section-lede">agent <strong>${escapeHtml(v.agentId)}</strong> · model ${escapeHtml(v.model)} · provider ${escapeHtml(v.provider)}</p>`,
    renderKpis(v),
    `</header>`,
  ].join("\n");
}

/** Per-run report deep-link, when the run was judged. */
function reportHref(t: TaskOutcome): string {
  return t.judgementId
    ? `/api/judgements/${encodeURIComponent(t.judgementId)}/report`
    : "";
}

function renderTaskTable(tasks: readonly TaskOutcome[]): string {
  const rows = tasks
    .map((t) => {
      const outcome =
        t.score === null ? "unjudged" : t.score >= 0.7 ? "pass" : "fail";
      const href = reportHref(t);
      const nameCell = href
        ? `<a href="${escapeHtml(href)}">${escapeHtml(t.taskName)}</a>`
        : escapeHtml(t.taskName);
      const sev = t.worstSeverity
        ? `${severityIcon(t.worstSeverity)} ${escapeHtml(t.worstSeverity)}`
        : "—";
      return [
        `<tr data-outcome="${outcome}" data-task="${escapeHtml(t.taskId)}">`,
        `<td>${nameCell}</td>`,
        `<td class="score-cell">${fmtScore(t.score)}</td>`,
        `<td>${escapeHtml(t.verdict ?? "—")}</td>`,
        `<td>${escapeHtml(t.runStatus)}</td>`,
        `<td>${t.findingCount}</td>`,
        `<td>${sev}</td>`,
        `</tr>`,
      ].join("");
    })
    .join("\n");

  return [
    `<section class="section" id="tasks" aria-labelledby="tasks-heading">`,
    `<h2 class="section-title" id="tasks-heading">Tasks</h2>`,
    `<p class="section-lede">Every eval task in this release. Task names link to that run's own report.</p>`,
    `<table class="task-table">`,
    `<thead><tr><th>Task</th><th>Score</th><th>Verdict</th><th>Run</th><th>Findings</th><th>Worst</th></tr></thead>`,
    `<tbody>${rows}</tbody>`,
    `</table>`,
    `</section>`,
  ].join("\n");
}

function renderRecurring(defects: readonly RecurringDefect[]): string {
  const body =
    defects.length === 0
      ? `<p class="section-empty">No defect appeared in more than one task.</p>`
      : defects
          .map((d) =>
            [
              `<div class="recur-card" data-fingerprint="${escapeHtml(d.fingerprint)}">`,
              `<div><span aria-hidden="true">${severityIcon(d.severity)}</span> <strong>${escapeHtml(d.severity)}</strong> · ${escapeHtml(d.category)}</div>`,
              `<p>${escapeHtml(d.claim)}</p>`,
              `<p class="recur-tasks">Seen in ${d.taskIds.length} tasks (${d.occurrences} occurrences): ${d.taskIds.map((t) => escapeHtml(t)).join(", ")}</p>`,
              `</div>`,
            ].join(""),
          )
          .join("\n");

  return [
    `<section class="section" id="recurring" aria-labelledby="recurring-heading">`,
    `<h2 class="section-title" id="recurring-heading">Recurring defects</h2>`,
    `<p class="section-lede">Defects that crossed task boundaries — a capability gap rather than a one-off slip. This is the signal a per-run report cannot show.</p>`,
    body,
    `</section>`,
  ].join("\n");
}

function renderComparison(c: ReleaseComparison | null): string {
  if (!c) {
    return [
      `<section class="section" id="comparison" aria-labelledby="comparison-heading">`,
      `<h2 class="section-title" id="comparison-heading">Versus previous release</h2>`,
      `<p class="section-empty">No previous release to compare against.</p>`,
      `</section>`,
    ].join("\n");
  }

  const list = (
    title: string,
    items: ReleaseComparison["regressions"],
  ): string =>
    items.length === 0
      ? ""
      : [
          `<h3>${escapeHtml(title)}</h3>`,
          `<ul class="bullet-list">`,
          ...items.map(
            (r) =>
              `<li><code>${escapeHtml(r.taskId)}</code>: ${r.before.toFixed(2)} → ${r.after.toFixed(2)} ${fmtDelta(r.after - r.before)}</li>`,
          ),
          `</ul>`,
        ].join("");

  const head = c.previousRef
    ? `<p class="section-lede">Compared against <code>${escapeHtml(c.previousRef)}</code>${c.delta !== null ? ` · overall ${fmtDelta(c.delta)}` : ""}.</p>`
    : `<p class="section-lede">Compared against the previous release${c.delta !== null ? ` · overall ${fmtDelta(c.delta)}` : ""}.</p>`;

  const bodyParts = [
    list("Regressions", c.regressions),
    list("Improvements", c.improvements),
  ].filter(Boolean);

  return [
    `<section class="section" id="comparison" aria-labelledby="comparison-heading">`,
    `<h2 class="section-title" id="comparison-heading">Versus previous release</h2>`,
    head,
    bodyParts.length > 0
      ? bodyParts.join("\n")
      : `<p class="section-empty">No task moved materially in either direction.</p>`,
    `</section>`,
  ].join("\n");
}

function renderRecommendations(v: ReleaseVerdict): string {
  const body =
    v.recommendations.length === 0
      ? `<p class="section-empty">No release-level recommendations.</p>`
      : [
          `<ul class="bullet-list">`,
          ...v.recommendations.map(
            (r) =>
              `<li><strong>${escapeHtml(r.priority)}</strong> — ${escapeHtml(r.change)}<br><span class="section-lede">${escapeHtml(r.why)}</span><br><span class="recur-tasks">grounded in: ${r.taskIds.map((t) => escapeHtml(t)).join(", ")}</span></li>`,
          ),
          `</ul>`,
        ].join("");
  return [
    `<section class="section" id="recommendations" aria-labelledby="recs-heading">`,
    `<h2 class="section-title" id="recs-heading">Recommendations</h2>`,
    body,
    `</section>`,
  ].join("\n");
}

function renderObservations(observations: readonly string[]): string {
  const body =
    observations.length === 0
      ? `<p class="section-empty">No observations.</p>`
      : [
          `<ul class="bullet-list">`,
          ...observations.map((o) => `<li>${escapeHtml(o)}</li>`),
          `</ul>`,
        ].join("");
  return [
    `<section class="section" id="observations" aria-labelledby="obs-heading">`,
    `<h2 class="section-title" id="obs-heading">Observations</h2>`,
    body,
    `</section>`,
  ].join("\n");
}

function renderMetadata(v: ReleaseVerdict): string {
  const row = (k: string, val: string): string =>
    `<div class="meta-item"><span class="meta-key">${escapeHtml(k)}</span> <span class="meta-val">${escapeHtml(val)}</span></div>`;
  return [
    `<section class="section" id="metadata" aria-labelledby="meta-heading">`,
    `<h2 class="section-title" id="meta-heading">Metadata</h2>`,
    `<div class="meta-strip">`,
    row("batch", v.batchId),
    row("project", v.projectId),
    row("agent", v.agentId),
    row("release", v.releaseRef ?? "(untagged)"),
    row("generated", v.generatedAt),
    row("schema", String(v.schemaVersion)),
    `</div>`,
    `</section>`,
  ].join("\n");
}

/**
 * The ordered plan: what to change, in what order, and how to prove it worked.
 *
 * Rendered first and in full because it is the only section a consuming agent
 * strictly needs — everything below it exists to justify these steps.
 */
function renderImprovementPlan(v: ReleaseVerdict): string {
  if (v.improvementPlan.length === 0) {
    return [
      `<section class="section" id="plan" aria-labelledby="plan-heading">`,
      `<h2 class="section-title" id="plan-heading">What to change</h2>`,
      `<p class="section-empty">No actionable defects found.</p>`,
      `</section>`,
    ].join("\n");
  }

  const steps = v.improvementPlan
    .map((s) => {
      const chronic = s.chronic
        ? `<span class="chronic-badge">chronic — previous fixes did not work</span>`
        : "";
      return [
        `<li class="plan-step" data-subsystem="${escapeHtml(s.subsystem)}">`,
        `<div class="plan-head">`,
        `<span class="subsystem-chip">${escapeHtml(s.subsystem)}</span>`,
        `<strong>${escapeHtml(s.change)}</strong>`,
        chronic,
        `</div>`,
        `<p class="section-lede">${escapeHtml(s.rationale)}</p>`,
        `<div class="verify-block">`,
        `<div><strong>Verify:</strong> re-run ${s.verifyTaskIds.length} eval(s) — <code>${s.verifyTaskIds.map((t) => escapeHtml(t)).join(", ")}</code></div>`,
        s.regressionTaskIds.length > 0
          ? `<div><strong>Must not regress:</strong> ${s.regressionTaskIds.length} currently-passing eval(s)</div>`
          : "",
        `</div>`,
        `</li>`,
      ].join("");
    })
    .join("\n");

  return [
    `<section class="section" id="plan" aria-labelledby="plan-heading">`,
    `<h2 class="section-title" id="plan-heading">What to change</h2>`,
    `<p class="section-lede">Ordered by what fixing each one buys. Apply a step, re-run its verify set, and the finding should be gone.</p>`,
    `<ol class="plan-list">${steps}</ol>`,
    `</section>`,
  ].join("\n");
}

/** Where the work is concentrated. */
function renderSubsystemLoad(v: ReleaseVerdict): string {
  if (v.subsystemLoad.length === 0) return "";
  const rows = v.subsystemLoad
    .map(
      (s) =>
        `<tr><td><span class="subsystem-chip">${escapeHtml(s.subsystem)}</span></td><td>${s.defectCount}</td><td>${s.evalsAffected}</td><td>${escapeHtml(s.topDefect ?? "—")}</td></tr>`,
    )
    .join("");
  return [
    `<section class="section" id="subsystems" aria-labelledby="sub-heading">`,
    `<h2 class="section-title" id="sub-heading">Where the work is</h2>`,
    `<p class="section-lede">Defect load by subsystem. Five prompt issues and one model-capability issue is a very different afternoon from the reverse.</p>`,
    `<table class="task-table">`,
    `<thead><tr><th>Subsystem</th><th>Defects</th><th>Evals affected</th><th>Highest impact</th></tr></thead>`,
    `<tbody>${rows}</tbody></table>`,
    `</section>`,
  ].join("\n");
}

/** Reliability — the flaky/consistent-failure distinction. */
function renderReliability(v: ReleaseVerdict): string {
  const interesting = v.reliability.filter(
    (r) => r.verdict === "flaky" || r.verdict === "reliable_fail",
  );
  if (interesting.length === 0) return "";
  const rows = interesting
    .map((r) => {
      const label =
        r.verdict === "flaky"
          ? `<span class="flaky-badge">flaky</span>`
          : `<span class="fail-badge">consistent failure</span>`;
      const range = r.scoreRange
        ? `${r.scoreRange[0].toFixed(2)}–${r.scoreRange[1].toFixed(2)}`
        : "—";
      return `<tr><td>${escapeHtml(r.evalName)}</td><td>${label}</td><td class="score-cell">${r.passes}/${r.attempts}</td><td class="score-cell">${range}</td></tr>`;
    })
    .join("");
  return [
    `<section class="section" id="reliability" aria-labelledby="rel-heading">`,
    `<h2 class="section-title" id="rel-heading">Reliability</h2>`,
    `<p class="section-lede">A flaky eval is a reliability problem; one that fails every time is a capability problem. They need different fixes, so they are separated here.</p>`,
    `<table class="task-table">`,
    `<thead><tr><th>Eval</th><th>Kind</th><th>Passed</th><th>Score range</th></tr></thead>`,
    `<tbody>${rows}</tbody></table>`,
    `</section>`,
  ].join("\n");
}

/** Regressions explained by where the trajectories diverged. */
function renderExplainedRegressions(v: ReleaseVerdict): string {
  if (v.explainedRegressions.length === 0) return "";
  const cards = v.explainedRegressions
    .map((r) =>
      [
        `<div class="recur-card">`,
        `<div><strong>${escapeHtml(r.evalName)}</strong> — ${r.baselineScore.toFixed(2)} → ${r.candidateScore.toFixed(2)}</div>`,
        `<p>${escapeHtml(r.divergence.summary)}</p>`,
        r.divergence.divergedAtCandidateSeq !== null
          ? `<p class="recur-tasks">Diverged at seq ${r.divergence.divergedAtCandidateSeq} (after ${r.divergence.commonPrefixLength} matching step(s))</p>`
          : "",
        r.divergence.toolsOnlyInBaseline.length > 0
          ? `<p class="recur-tasks">Tools the passing run used and this one did not: ${r.divergence.toolsOnlyInBaseline.map((t) => escapeHtml(t)).join(", ")}</p>`
          : "",
        `</div>`,
      ].join(""),
    )
    .join("\n");
  return [
    `<section class="section" id="regressions" aria-labelledby="reg-heading">`,
    `<h2 class="section-title" id="reg-heading">Why these regressed</h2>`,
    `<p class="section-lede">The same eval, compared against its previous run: where the two trajectories parted company. That point is usually the whole explanation.</p>`,
    cards,
    `</section>`,
  ].join("\n");
}

/**
 * Render a validated {@link ReleaseVerdict} to a self-contained HTML document.
 */
export function renderReleaseReport(v: ReleaseVerdict): string {
  const title = v.releaseRef
    ? `Release ${v.releaseRef} — ${v.agentId}`
    : `Release evaluation — ${v.agentId}`;

  const body = [
    `<main class="report" id="top">`,
    renderHeader(v),
    // The plan comes FIRST. An agent consuming this report wants "what do I do"
    // before "what is wrong" — the findings are the justification, not the ask.
    renderImprovementPlan(v),
    renderSubsystemLoad(v),
    renderReliability(v),
    renderTaskTable(v.tasks),
    renderExplainedRegressions(v),
    renderRecurring(v.recurringDefects),
    renderComparison(v.comparison),
    renderRecommendations(v),
    renderObservations(v.observations),
    renderMetadata(v),
    `</main>`,
  ].join("\n");

  return [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${REPORT_STYLES}${RELEASE_STYLES}</style>`,
    `</head>`,
    `<body>`,
    body,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}
