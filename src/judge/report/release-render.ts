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

import type { EvalReport, EvalOutcome, Theme } from "../eval-report.js";
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
        `<li class="plan-step"${s.subsystem ? ` data-subsystem="${escapeHtml(s.subsystem)}"` : ""}>`,
        `<div class="plan-head">`,
        s.subsystem
          ? `<span class="subsystem-chip">${escapeHtml(s.subsystem)}</span>`
          : "",
        // No change instruction means the judge gave none. Say that, rather
        // than restating the defect in the imperative and calling it advice.
        s.change
          ? `<strong>${escapeHtml(s.change)}</strong>`
          : `<strong>${escapeHtml(s.defect)}</strong> <span class="section-empty">(no fix direction recorded)</span>`,
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
        `<tr><td>${s.subsystem ? `<span class="subsystem-chip">${escapeHtml(s.subsystem)}</span>` : `<span class="section-empty">not routed</span>`}</td><td>${s.defectCount}</td><td>${s.evalsAffected}</td><td>${escapeHtml(s.topDefect ?? "—")}</td></tr>`,
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

// ---------------------------------------------------------------------------
// The eval report — analysis, not evidence
// ---------------------------------------------------------------------------

/** Styles for the theme-oriented report. */
const EVAL_STYLES = /* css */ `
.theme { border:1px solid var(--border,#2a3140); border-left-width:4px; border-radius:8px; padding:.9rem 1.1rem; margin:.8rem 0; }
.theme[data-severity="blocker"], .theme[data-severity="major"] { border-left-color:var(--sev-major,#d97706); }
.theme-head { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; margin-bottom:.4rem; }
.theme-title { font-size:1.05rem; font-weight:700; }
.technique { border-left:3px solid var(--ok,#16a34a); padding:.5rem .8rem; margin:.6rem 0; }
.technique h4 { margin:0 0 .25rem; font-size:.8rem; text-transform:uppercase; letter-spacing:.03em; opacity:.75; }
.example { font-size:.88rem; opacity:.9; margin:.3rem 0 .3rem .8rem; padding-left:.6rem; border-left:2px solid var(--border,#2a3140); }
.outcome-row td { vertical-align:top; }
.next-call { border:1px solid var(--ok,#16a34a); border-radius:8px; padding:.8rem 1rem; }
.next-call pre { margin:.4rem 0 0; overflow:auto; }
`;

/** One theme: the pattern, why it happened, and the technique that fixes it. */
function renderTheme(t: Theme): string {
  const examples = t.examples.length
    ? t.examples
        .map(
          (e) =>
            `<div class="example"><strong>${escapeHtml(e.evalName)}</strong>${e.seq !== null ? ` (seq ${e.seq})` : ""}: ${escapeHtml(e.whatHappened)}${e.insteadShouldHave ? ` — <em>instead:</em> ${escapeHtml(e.insteadShouldHave)}` : ""}</div>`,
        )
        .join("")
    : "";

  return [
    `<div class="theme" data-severity="${escapeHtml(t.severity)}" data-theme="${escapeHtml(t.id)}"${t.subsystem ? ` data-subsystem="${escapeHtml(t.subsystem)}"` : ""}>`,
    `<div class="theme-head">`,
    `<span class="theme-title">${escapeHtml(t.title)}</span>`,
    // No chip when the judge did not attribute one — an "unattributed" label
    // would read as a routing decision it never made.
    t.subsystem ? `<span class="subsystem-chip">${escapeHtml(t.subsystem)}</span>` : "",
    `<span class="badge">${escapeHtml(t.severity)}</span>`,
    t.chronic
      ? `<span class="chronic-badge">chronic — survived ${t.evaluationsSurvived} evaluations</span>`
      : "",
    `</div>`,
    `<p>${escapeHtml(t.whatWentWrong)}</p>`,
    t.why ? `<p class="section-lede">${escapeHtml(t.why)}</p>` : "",
    examples,
    // Say plainly when the judge supplied no remedy. Inventing one from the
    // category name would look like advice and contain none.
    t.technique
      ? [
          `<div class="technique">`,
          `<h4>Technique</h4>`,
          `<p>${escapeHtml(t.technique)}</p>`,
          `</div>`,
        ].join("")
      : `<p class="section-empty">The judge recorded no fix direction for this theme.</p>`,
    `<p class="recur-tasks">Affects ${t.affectedEvals.length} eval(s): ${t.affectedEvals.map((e) => escapeHtml(e.name)).join(", ")}`,
    t.impact.estimatedScoreGain > 0
      ? ` · worth about +${t.impact.estimatedScoreGain.toFixed(3)} mean score`
      : "",
    `</p>`,
    `<p class="recur-tasks"><strong>Verify:</strong> re-run <code>${t.verification.reRunTaskIds.map((x) => escapeHtml(x)).join(", ")}</code>`,
    t.verification.mustKeepPassingTaskIds.length > 0
      ? ` · must keep passing: <code>${t.verification.mustKeepPassingTaskIds.map((x) => escapeHtml(x)).join(", ")}</code>`
      : "",
    `</p>`,
    `</div>`,
  ].join("\n");
}

/** Per-eval outcomes — a line each, with links to the evidence. */
function renderOutcomes(evals: readonly EvalOutcome[]): string {
  const rows = evals
    .map((e) => {
      const outcome =
        e.score === null ? "unjudged" : e.score >= 0.7 ? "pass" : "fail";
      const links = [
        e.evidence.reportUrl
          ? `<a href="${escapeHtml(e.evidence.reportUrl)}">report</a>`
          : "",
        e.evidence.traceUrl
          ? `<a href="${escapeHtml(e.evidence.traceUrl)}">trace (${e.evidence.traceEventCount})</a>`
          : "",
        e.evidence.diffUrl
          ? `<a href="${escapeHtml(e.evidence.diffUrl)}">diff</a>`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const headline = e.environmentError
        ? `<strong>Environment failed:</strong> ${escapeHtml(e.environmentError)}`
        : escapeHtml(e.headline);
      return [
        `<tr class="outcome-row" data-outcome="${outcome}">`,
        `<td>${escapeHtml(e.name)}</td>`,
        `<td class="score-cell">${e.score === null ? "—" : e.score.toFixed(2)}</td>`,
        `<td>${headline}</td>`,
        `<td>${links}</td>`,
        `</tr>`,
      ].join("");
    })
    .join("");

  return [
    `<section class="section" id="outcomes" aria-labelledby="out-heading">`,
    `<h2 class="section-title" id="out-heading">Per-eval outcomes</h2>`,
    `<p class="section-lede">One line each. Full traces and diffs are linked rather than inlined — the analysis above is what they were read to produce.</p>`,
    `<table class="task-table">`,
    `<thead><tr><th>Eval</th><th>Score</th><th>What happened</th><th>Evidence</th></tr></thead>`,
    `<tbody>${rows}</tbody></table>`,
    `</section>`,
  ].join("\n");
}

/**
 * Render the evaluation report.
 *
 * Themes first — they are what the consuming agent acts on. The JSON form is
 * embedded verbatim so the two cannot disagree.
 */
export function renderEvalReport(r: EvalReport): string {
  const kpi = (value: string, label: string): string =>
    `<div class="kpi"><div class="kpi-value">${escapeHtml(value)}</div><div class="kpi-label">${escapeHtml(label)}</div></div>`;

  const header = [
    `<header class="verdict-header">`,
    `<h1>Evaluation${r.commit ? ` · ${escapeHtml(r.commit.slice(0, 12))}` : ""}</h1>`,
    `<p class="verdict-summary">${escapeHtml(r.summary.text)}</p>`,
    `<p class="section-lede">agent <strong>${escapeHtml(r.agentId)}</strong> · model ${escapeHtml(r.model)} · ${escapeHtml(r.generatedAt)}</p>`,
    `<div class="release-kpis">`,
    kpi(r.summary.score.toFixed(2), "mean score"),
    kpi(`${r.summary.evalsPassed}/${r.summary.evalsTotal}`, "evals passed"),
    kpi(String(r.themes.length), "themes"),
    `</div>`,
    `</header>`,
  ].join("\n");

  const themes = [
    `<section class="section" id="themes" aria-labelledby="themes-heading">`,
    `<h2 class="section-title" id="themes-heading">What to improve</h2>`,
    `<p class="section-lede">Patterns across evals, each with the technique that addresses it and how to prove it worked.</p>`,
    r.themes.length > 0
      ? r.themes.map(renderTheme).join("\n")
      : `<p class="section-empty">No recurring problems found.</p>`,
    `</section>`,
  ].join("\n");

  const strengths =
    r.strengths.length > 0
      ? [
          `<section class="section" id="strengths" aria-labelledby="str-heading">`,
          `<h2 class="section-title" id="str-heading">Keep doing</h2>`,
          `<p class="section-lede">Behaviours a refactor should not lose.</p>`,
          `<ul class="bullet-list">`,
          ...r.strengths.map(
            (s) =>
              `<li><strong>${escapeHtml(s.title)}</strong> — ${escapeHtml(s.detail)} <span class="recur-tasks">(${s.evalNames.length} eval(s))</span></li>`,
          ),
          `</ul>`,
          `</section>`,
        ].join("\n")
      : "";

  const reliability =
    r.reliability.length > 0
      ? [
          `<section class="section" id="reliability" aria-labelledby="rel-heading">`,
          `<h2 class="section-title" id="rel-heading">Reliability</h2>`,
          `<p class="section-lede">A flaky eval needs determinism work; one that fails every time needs capability work.</p>`,
          `<table class="task-table"><thead><tr><th>Eval</th><th>Kind</th><th>Passed</th><th>Range</th></tr></thead><tbody>`,
          ...r.reliability.map(
            (x) =>
              `<tr><td>${escapeHtml(x.evalName)}</td><td>${x.kind === "flaky" ? `<span class="flaky-badge">flaky</span>` : `<span class="fail-badge">consistent failure</span>`}</td><td class="score-cell">${x.passes}/${x.attempts}</td><td class="score-cell">${x.scoreRange ? `${x.scoreRange[0].toFixed(2)}–${x.scoreRange[1].toFixed(2)}` : "—"}</td></tr>`,
          ),
          `</tbody></table></section>`,
        ].join("\n")
      : "";

  const regressions =
    r.regressions.length > 0
      ? [
          `<section class="section" id="regressions" aria-labelledby="reg-heading">`,
          `<h2 class="section-title" id="reg-heading">Regressions</h2>`,
          ...r.regressions.map(
            (x) =>
              `<div class="recur-card"><div><strong>${escapeHtml(x.evalName)}</strong> — ${x.before.toFixed(2)} → ${x.after.toFixed(2)}</div><p>${escapeHtml(x.explanation)}</p></div>`,
          ),
          `</section>`,
        ].join("\n")
      : "";

  const next = [
    `<section class="section" id="next" aria-labelledby="next-heading">`,
    `<h2 class="section-title" id="next-heading">Next</h2>`,
    `<div class="next-call">`,
    `<p>${escapeHtml(r.nextEvaluation.description)}</p>`,
    `<pre><code>${escapeHtml(`${r.nextEvaluation.request.method} ${r.nextEvaluation.request.path}\n${JSON.stringify(r.nextEvaluation.request.body, null, 2)}`)}</code></pre>`,
    `</div>`,
    `</section>`,
  ].join("\n");

  const body = [
    `<main class="report" id="top">`,
    header,
    themes,
    strengths,
    reliability,
    regressions,
    renderOutcomes(r.evals),
    next,
    `</main>`,
  ].join("\n");

  const embedded = JSON.stringify(r).replace(/</g, "\\u003c");

  return [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>Evaluation ${escapeHtml(r.commit?.slice(0, 12) ?? r.evaluationId)}</title>`,
    `<style>${REPORT_STYLES}${RELEASE_STYLES}${EVAL_STYLES}</style>`,
    `</head>`,
    `<body>`,
    body,
    `<script type="application/json" id="eval-report-data">${embedded}</script>`,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}
