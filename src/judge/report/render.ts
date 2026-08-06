/**
 * Pure HTML report renderer for a validated Verdict.
 * Returns a complete self-contained <!doctype html> document (inline CSS/JS, no network).
 * Spec: plan/judge.md §"Report-generation skill", plan/roadmap.md Phase 5.
 */

import type {
  CriterionVerdict,
  Diagnostic,
  Finding,
  Improvement,
  MetaFinding,
  Ref,
  Verdict,
} from "../verdict.js";
import { SEVERITY_ORDER } from "../verdict.js";
import {
  comparisonLabel,
  escapeHtml,
  fmtDuration,
  fmtPercent,
  fmtScore,
  fmtTokens,
  priorityLabel,
  refHref,
  refLabel,
  severityIcon,
  severityLabel,
  severityRank,
  slugId,
  verdictLevelLabel,
} from "./render-helpers.js";
import { REPORT_STYLES } from "./styles.js";

/** Optional context for the metadata strip and gauge chrome. */
export interface ReportContext {
  runId?: string;
  taskId?: string;
  taskPrompt?: string;
  agentCategory?: string;
  agent?: string;
  model?: string;
  judgeModel?: string;
  systemPromptVersion?: string;
  judgedAt?: string;
  hasSourceArtifacts?: boolean;
  /** status, durationMs, tokens — rendered into the metadata strip. */
  runMetadata?: Record<string, unknown>;
}

/**
 * Render a validated Verdict into a self-contained, accessible report.html string.
 * Pure: no I/O, no DOM, deterministic for a given (verdict, ctx).
 */
export function renderVerdictReport(verdict: Verdict, ctx: ReportContext = {}): string {
  const sortedFindings = sortBySeverity(verdict.findings);
  const sortedPositive = sortBySeverity(verdict.positiveFindings);

  const body = [
    renderSkipLink(),
    renderTopbar(),
    `<main class="report" id="top">`,
    renderVerdictHeader(verdict),
    renderToc(),
    renderFindingsSpine(sortedFindings),
    renderImprovements(verdict, ctx),
    renderCriteria(verdict.criteria),
    renderDiagnostics(verdict.diagnostics),
    renderNotableMoments(verdict.observations),
    renderPositiveFindings(sortedPositive),
    renderObservations(verdict.observations),
    renderMetaFindings(verdict.metaFindings),
    renderAttribution(verdict),
    renderComparison(verdict),
    renderMetadataStrip(verdict, ctx),
    `</main>`,
    renderScript(),
  ].join("\n");

  return [
    "<!doctype html>",
    "<!-- @agenteval-report -->",
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(pageTitle(verdict, ctx))}</title>`,
    `<meta name="color-scheme" content="light dark">`,
    `<style>\n${REPORT_STYLES}\n</style>`,
    `</head>`,
    `<body>`,
    body,
    `</body>`,
    `</html>`,
  ].join("\n");
}

// ── Sorting ──────────────────────────────────────────────────────────

function sortBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const dr = severityRank(a.severity) - severityRank(b.severity);
    if (dr !== 0) return dr;
    // Stable secondary key so order is deterministic.
    return a.id.localeCompare(b.id);
  });
}

// ── Header / chrome ──────────────────────────────────────────────────

function pageTitle(verdict: Verdict, ctx: ReportContext): string {
  const level = verdictLevelLabel(verdict.overall.verdict);
  const score = fmtScore(verdict.overall.score);
  const run = ctx.runId ? ` · ${ctx.runId}` : "";
  return `Verdict ${level} (${score})${run}`;
}

function renderSkipLink(): string {
  return `<a class="skip-link" href="#findings">Skip to findings</a>`;
}

function renderTopbar(): string {
  return [
    `<div class="topbar">`,
    `<div class="brand">agenteval · judgement report</div>`,
    `<button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle color theme">Theme</button>`,
    `</div>`,
  ].join("");
}

function renderVerdictHeader(verdict: Verdict): string {
  const { score, verdict: level, summary } = verdict.overall;
  const pct = Math.round(Math.min(1, Math.max(0, score)) * 100);
  const label = verdictLevelLabel(level);
  return [
    `<header class="verdict-header" id="verdict" aria-labelledby="verdict-heading">`,
    renderDonutGauge(score, level),
    `<div>`,
    `<div class="level-badge" data-level="${escapeHtml(level)}">`,
    `<span aria-hidden="true">${levelIcon(level)}</span>`,
    `<span>${escapeHtml(label)}</span>`,
    `</div>`,
    `<h1 id="verdict-heading" class="sr-only">Verdict: ${escapeHtml(label)} — score ${fmtScore(score)}</h1>`,
    `<p class="verdict-summary">${escapeHtml(summary)}</p>`,
    renderScoreCaption(score, pct),
    `</div>`,
    `</header>`,
  ].join("\n");
}

function levelIcon(level: string): string {
  if (level === "pass") return "✓";
  if (level === "fail") return "✕";
  return "◐";
}

function renderScoreCaption(score: number, pct: number): string {
  return `<p class="token-strip" style="margin-top:var(--sp-3)"><span>Overall score ${fmtScore(score)} · ${pct}%</span></p>`;
}

/**
 * SVG donut gauge for the overall score. Aria-labeled; color paired with verdict level.
 * Uses stroke-dasharray; no animation when prefers-reduced-motion (CSS handles it).
 */
function renderDonutGauge(score: number, level: string): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0));
  const r = 52;
  const c = 2 * Math.PI * r;
  const dash = clamped * c;
  const gap = c - dash;
  const stroke =
    level === "pass"
      ? "var(--status-good)"
      : level === "fail"
        ? "var(--status-critical)"
        : "var(--status-warning)";
  const label = `Overall score ${fmtScore(clamped)} out of 1, verdict ${verdictLevelLabel(level as "pass" | "partial" | "fail")}`;
  return [
    `<div class="gauge" role="img" aria-label="${escapeHtml(label)}">`,
    `<svg viewBox="0 0 128 128" aria-hidden="true" focusable="false">`,
    `<circle cx="64" cy="64" r="${r}" fill="none" stroke="var(--gauge-track)" stroke-width="12"/>`,
    `<circle cx="64" cy="64" r="${r}" fill="none" stroke="${stroke}" stroke-width="12"`,
    `  stroke-linecap="round"`,
    `  stroke-dasharray="${dash.toFixed(3)} ${gap.toFixed(3)}"`,
    `  transform="rotate(-90 64 64)"/>`,
    `</svg>`,
    `<div class="gauge-center">`,
    `<span class="gauge-score">${fmtScore(clamped)}</span>`,
    `<span class="gauge-label">score</span>`,
    `</div>`,
    `</div>`,
  ].join("\n");
}

function renderToc(): string {
  const items: Array<[string, string]> = [
    ["#findings", "Findings"],
    ["#improvements", "Improvements"],
    ["#criteria", "Criteria"],
    ["#diagnostics", "Diagnostics"],
    ["#notable-moments", "Notable moments"],
    ["#positive-findings", "Keep"],
    ["#observations", "Observations"],
    ["#attribution", "Attribution"],
    ["#metadata", "Metadata"],
  ];
  return [
    `<nav aria-label="Report sections">`,
    `<ul class="toc">`,
    ...items.map(
      ([href, label]) =>
        `<li><a href="${href}">${escapeHtml(label)}</a></li>`,
    ),
    `</ul>`,
    `</nav>`,
  ].join("");
}

// ── Findings spine ───────────────────────────────────────────────────

function renderFindingsSpine(findings: Finding[]): string {
  const cards =
    findings.length === 0
      ? `<p class="section-empty">No findings — nothing to fix was located.</p>`
      : `<div class="card-list">${findings.map((f) => renderFindingCard(f, false)).join("\n")}</div>`;
  return [
    `<section class="section" id="findings" aria-labelledby="findings-heading">`,
    `<h2 class="section-title" id="findings-heading">Findings — what to fix</h2>`,
    `<p class="section-lede">Severity-ordered actionable defects. Each finding is located (≥1 ref) and optionally carries a fix direction.</p>`,
    cards,
    `</section>`,
  ].join("\n");
}

function renderPositiveFindings(findings: Finding[]): string {
  const cards =
    findings.length === 0
      ? `<p class="section-empty">No positive findings recorded.</p>`
      : `<div class="card-list">${findings.map((f) => renderFindingCard(f, true)).join("\n")}</div>`;
  return [
    `<section class="section" id="positive-findings" aria-labelledby="positive-heading">`,
    `<h2 class="section-title" id="positive-heading">Positive findings — what to keep</h2>`,
    `<p class="section-lede">Behaviors worth preserving across future runs.</p>`,
    cards,
    `</section>`,
  ].join("\n");
}

function findingAnchorId(id: string): string {
  return `finding-${slugId(id)}`;
}

function renderFindingCard(f: Finding, positive: boolean): string {
  const sevClass = `sev-${f.severity}`;
  const badge = [
    `<span class="badge ${sevClass}" title="Severity">`,
    `<span class="icon" aria-hidden="true">${severityIcon(f.severity)}</span>`,
    `<span>${escapeHtml(severityLabel(f.severity))}</span>`,
    `</span>`,
  ].join("");
  const conf = `<span class="badge" title="Confidence">${escapeHtml(fmtPercent(f.confidence))} conf</span>`;
  const cat = `<span class="badge">${escapeHtml(f.category)}</span>`;
  const crit = f.criterion
    ? `<a class="badge" href="#criterion-${escapeHtml(slugId(f.criterion))}">criterion ${escapeHtml(f.criterion)}</a>`
    : "";
  const recurring = f.recurring
    ? `<span class="badge recurring" title="First ${escapeHtml(f.recurring.firstSeenRun)} · last ${escapeHtml(f.recurring.lastSeenRun)}">↻ recurring ×${f.recurring.count}</span>`
    : "";

  const fix = f.fix ? renderFix(f.fix) : "";

  return [
    `<article class="finding-card${positive ? " positive" : ""}" id="${escapeHtml(findingAnchorId(f.id))}" data-severity="${escapeHtml(f.severity)}" data-finding-id="${escapeHtml(f.id)}">`,
    `<div class="finding-head">`,
    badge,
    conf,
    cat,
    crit,
    recurring,
    `</div>`,
    `<h3 class="finding-claim">${escapeHtml(f.claim)}</h3>`,
    renderRefList(f.refs),
    fix,
    `<div class="meta-row"><span class="badge meta">id ${escapeHtml(f.id)}</span></div>`,
    `</article>`,
  ].join("\n");
}

function renderFix(fix: NonNullable<Finding["fix"]>): string {
  const repro = fix.repro
    ? [
        `<pre class="repro"><code>$ ${escapeHtml(fix.repro.command)}\n# expected: ${escapeHtml(fix.repro.expected)}</code></pre>`,
      ].join("")
    : "";
  return [
    `<div class="fix-block">`,
    `<h4>Fix direction</h4>`,
    `<p class="fix-direction">${escapeHtml(fix.direction)}</p>`,
    repro,
    `</div>`,
  ].join("\n");
}

function renderRefList(refs: Ref[]): string {
  if (!refs.length) return "";
  return [
    `<ul class="ref-list" aria-label="Evidence references">`,
    ...refs.map((r) => {
      const href = refHref(r);
      const label = refLabel(r);
      return `<li><a class="ref-chip" href="${escapeHtml(href)}" data-ref-kind="${escapeHtml(r.kind)}">${escapeHtml(label)}</a></li>`;
    }),
    `</ul>`,
  ].join("");
}

// ── Improvements (two-lens) ──────────────────────────────────────────

function renderImprovements(verdict: Verdict, ctx: ReportContext): string {
  const imp = verdict.improvements;
  const hasWithSource = Array.isArray(imp.withSource);
  const without = imp.withoutSource.map((i) => renderImprovementCard(i, "without")).join("\n");
  const withSection = hasWithSource
    ? [
        `<div class="lens" id="improvements-with-source" data-lens="withSource">`,
        `<h3 class="lens-title">With-source lens</h3>`,
        `<p class="lens-note">Recommendations that require source artifacts (diff). May cite diff/file refs.</p>`,
        (imp.withSource ?? []).length === 0
          ? `<p class="section-empty">No source-level recommendations.</p>`
          : (imp.withSource ?? []).map((i) => renderImprovementCard(i, "with")).join("\n"),
        `</div>`,
      ].join("\n")
    : [
        `<div class="lens" id="improvements-no-source-note" data-lens="withSource-absent">`,
        `<h3 class="lens-title">With-source lens</h3>`,
        `<p class="section-empty">no source-level recommendations (run has no source artifacts)</p>`,
        `</div>`,
      ].join("\n");

  // hasSourceArtifacts context flag is advisory; the withSource key presence is the gate.
  void ctx;

  return [
    `<section class="section" id="improvements" aria-labelledby="improvements-heading">`,
    `<h2 class="section-title" id="improvements-heading">Improvements</h2>`,
    `<p class="section-lede">${escapeHtml(imp.summary)}</p>`,
    `<div class="lens" id="improvements-without-source" data-lens="withoutSource">`,
    `<h3 class="lens-title">Without-source lens</h3>`,
    `<p class="lens-note">Holds without source access — grounded in the trace/tool stream only.</p>`,
    without.length ? without : `<p class="section-empty">No without-source recommendations.</p>`,
    `</div>`,
    withSection,
    `</section>`,
  ].join("\n");
}

function renderImprovementCard(item: Improvement, lens: "with" | "without"): string {
  return [
    `<article class="improvement-card" data-lens="${lens}" data-area="${escapeHtml(item.area)}" data-priority="${escapeHtml(item.priority)}">`,
    `<div class="finding-head">`,
    `<span class="badge priority-${escapeHtml(item.priority)}">${escapeHtml(priorityLabel(item.priority))}</span>`,
    `<span class="badge">${escapeHtml(item.area)}</span>`,
    `</div>`,
    `<p class="improvement-change">${escapeHtml(item.change)}</p>`,
    `<p class="improvement-why">${escapeHtml(item.why)}</p>`,
    renderRefList(item.refs),
    renderLinkedFindings(item.linkedFindings),
    `</article>`,
  ].join("\n");
}

function renderLinkedFindings(ids: string[]): string {
  if (!ids.length) return "";
  const links = ids
    .map(
      (id) =>
        `<a class="finding-link" href="#${escapeHtml(findingAnchorId(id))}">${escapeHtml(id)}</a>`,
    )
    .join(" · ");
  return `<div class="linked-findings"><span>Linked findings:</span> ${links}</div>`;
}

// ── Criteria ─────────────────────────────────────────────────────────

function renderCriteria(criteria: CriterionVerdict[]): string {
  const cards =
    criteria.length === 0
      ? `<p class="section-empty">No criteria scored.</p>`
      : criteria.map(renderCriterionCard).join("\n");
  return [
    `<section class="section" id="criteria" aria-labelledby="criteria-heading">`,
    `<h2 class="section-title" id="criteria-heading">Criterion breakdown</h2>`,
    `<p class="section-lede">Feedback-then-score per rubric criterion. Score bars are 0..1 with a labeled axis.</p>`,
    cards,
    `</section>`,
  ].join("\n");
}

function renderCriterionCard(c: CriterionVerdict): string {
  const pct = Math.round(Math.min(1, Math.max(0, c.score)) * 100);
  const critical = c.critical
    ? `<span class="badge critical-flag">critical</span>`
    : "";
  const weight = `<span class="badge">weight ${escapeHtml(String(c.weight))}</span>`;
  const findingLinks = c.findingIds.length
    ? `<div class="linked-findings"><span>Findings:</span> ${c.findingIds
        .map(
          (id) =>
            `<a class="finding-link" href="#${escapeHtml(findingAnchorId(id))}">${escapeHtml(id)}</a>`,
        )
        .join(" · ")}</div>`
    : "";
  const evidence =
    c.evidence.length === 0
      ? ""
      : [
          `<h4 class="sr-only">Evidence</h4>`,
          `<ul class="evidence-list">`,
          ...c.evidence.map((e) => `<li>${escapeHtml(e)}</li>`),
          `</ul>`,
        ].join("");

  const aria = `Score ${fmtScore(c.score)} out of 1 for criterion ${c.criterion}`;

  return [
    `<article class="criterion-card" id="criterion-${escapeHtml(slugId(c.criterion))}" data-criterion="${escapeHtml(c.criterion)}">`,
    `<div class="criterion-head">`,
    `<h3 class="criterion-id">${escapeHtml(c.criterion)}</h3>`,
    critical,
    weight,
    `</div>`,
    // Feedback BEFORE score (feedback-then-score ordering).
    `<p class="criterion-feedback">${escapeHtml(c.feedback)}</p>`,
    `<div class="score-row">`,
    `<div style="width:100%">`,
    `<div class="score-bar" role="img" aria-label="${escapeHtml(aria)}">`,
    `<div class="score-bar-fill" style="width:${pct}%"></div>`,
    `</div>`,
    `<div class="score-axis" aria-hidden="true"><span>0</span><span>0.5</span><span>1</span></div>`,
    `</div>`,
    `<div class="score-value">${fmtScore(c.score)}</div>`,
    `</div>`,
    evidence,
    findingLinks,
    `</article>`,
  ].join("\n");
}

// ── Diagnostics ──────────────────────────────────────────────────────

function renderDiagnostics(diagnostics: Record<string, Diagnostic>): string {
  const keys = Object.keys(diagnostics).sort();
  const tiles =
    keys.length === 0
      ? `<p class="section-empty">No diagnostics recorded.</p>`
      : [
          `<div class="diag-grid">`,
          ...keys.map((k) => renderDiagTile(k, diagnostics[k]!)),
          `</div>`,
        ].join("\n");
  return [
    `<section class="section" id="diagnostics" aria-labelledby="diagnostics-heading">`,
    `<h2 class="section-title" id="diagnostics-heading">Diagnostics</h2>`,
    `<p class="section-lede">Localized yes/no failure modes — each tile shows WHERE via its refs (never bare booleans).</p>`,
    tiles,
    `</section>`,
  ].join("\n");
}

function renderDiagTile(name: string, d: Diagnostic): string {
  const valueLabel = d.value ? "true" : "false";
  const icon = d.value ? "⚠" : "✓";
  const note = d.note ? `<p class="diag-note">${escapeHtml(d.note)}</p>` : "";
  const refs = d.refs && d.refs.length ? renderRefList(d.refs) : `<p class="section-empty" style="margin:0">No refs</p>`;
  return [
    `<div class="diag-tile" data-value="${valueLabel}" data-diagnostic="${escapeHtml(name)}">`,
    `<h3 class="diag-name">${escapeHtml(name)}</h3>`,
    `<span class="diag-value" data-value="${valueLabel}"><span aria-hidden="true">${icon}</span> ${valueLabel}</span>`,
    note,
    refs,
    `</div>`,
  ].join("\n");
}

// ── Notable moments / observations ───────────────────────────────────

/**
 * Notable trajectory moments — derived from observations[] as bullet moments
 * (no fake trajectory mining). Same source as observations; framed for the
 * "notable moments" slot in the report structure.
 */
function renderNotableMoments(observations: string[]): string {
  const items =
    observations.length === 0
      ? `<p class="section-empty">No notable moments noted.</p>`
      : [
          `<ul class="bullet-list">`,
          ...observations.map((o) => `<li>${escapeHtml(o)}</li>`),
          `</ul>`,
        ].join("");
  return [
    `<section class="section" id="notable-moments" aria-labelledby="moments-heading">`,
    `<h2 class="section-title" id="moments-heading">Notable trajectory moments</h2>`,
    `<p class="section-lede">Moments drawn from the judge's observations of the run trajectory.</p>`,
    items,
    `</section>`,
  ].join("\n");
}

function renderObservations(observations: string[]): string {
  const items =
    observations.length === 0
      ? `<p class="section-empty">No observations.</p>`
      : [
          `<ul class="bullet-list">`,
          ...observations.map((o) => `<li>${escapeHtml(o)}</li>`),
          `</ul>`,
        ].join("");
  return [
    `<section class="section" id="observations" aria-labelledby="observations-heading">`,
    `<h2 class="section-title" id="observations-heading">Observations</h2>`,
    items,
    `</section>`,
  ].join("\n");
}

function renderMetaFindings(items: MetaFinding[]): string {
  if (!items.length) return "";
  const cards = items
    .map((m) => {
      return [
        `<article class="finding-card" data-meta-id="${escapeHtml(m.id)}">`,
        `<div class="finding-head">`,
        `<span class="badge meta">${escapeHtml(m.category)}</span>`,
        `</div>`,
        `<h3 class="finding-claim">${escapeHtml(m.claim)}</h3>`,
        m.note ? `<p class="improvement-why">${escapeHtml(m.note)}</p>` : "",
        `</article>`,
      ].join("\n");
    })
    .join("\n");
  return [
    `<section class="section" id="meta-findings" aria-labelledby="meta-heading">`,
    `<h2 class="section-title" id="meta-heading">Meta findings — task / rubric gaps</h2>`,
    `<p class="section-lede">Issues for the task author (not agent defects).</p>`,
    `<div class="card-list">${cards}</div>`,
    `</section>`,
  ].join("\n");
}

// ── Attribution / comparison / metadata ──────────────────────────────

function renderAttribution(verdict: Verdict): string {
  const a = verdict.attribution;
  const note = a.note ? `<p class="improvement-why">${escapeHtml(a.note)}</p>` : "";
  return [
    `<section class="section" id="attribution" aria-labelledby="attribution-heading">`,
    `<h2 class="section-title" id="attribution-heading">Attribution</h2>`,
    `<div class="attr-block">`,
    `<p><span class="badge">${escapeHtml(a.agent_vs_environment)}</span> <span class="meta-row" style="display:inline">agent vs environment</span></p>`,
    note,
    `</div>`,
    `</section>`,
  ].join("\n");
}

function renderComparison(verdict: Verdict): string {
  if (!verdict.comparison) return "";
  const c = verdict.comparison;
  const { arrow, label, tone } = comparisonLabel(c.direction);
  return [
    `<section class="section" id="comparison" aria-labelledby="comparison-heading">`,
    `<h2 class="section-title" id="comparison-heading">Comparison</h2>`,
    `<div class="comparison-block">`,
    `<div class="comparison-dir" data-tone="${escapeHtml(tone)}">`,
    `<span aria-hidden="true">${arrow}</span>`,
    `<span>${escapeHtml(label)}</span>`,
    `<span class="badge">vs ${escapeHtml(c.vsRunId)}</span>`,
    `</div>`,
    `<p class="improvement-why">${escapeHtml(c.why)}</p>`,
    `</div>`,
    `</section>`,
  ].join("\n");
}

function renderMetadataStrip(verdict: Verdict, ctx: ReportContext): string {
  const pairs: Array<[string, string]> = [];
  if (ctx.runId) pairs.push(["run", ctx.runId]);
  if (ctx.taskId) pairs.push(["task", ctx.taskId]);
  if (ctx.agent) pairs.push(["agent", ctx.agent]);
  if (ctx.agentCategory) pairs.push(["category", ctx.agentCategory]);
  if (ctx.model) pairs.push(["model", ctx.model]);
  if (ctx.judgeModel) pairs.push(["judge model", ctx.judgeModel]);
  if (ctx.systemPromptVersion) pairs.push(["system prompt", ctx.systemPromptVersion]);
  if (ctx.judgedAt) pairs.push(["judged at", ctx.judgedAt]);
  if (ctx.hasSourceArtifacts !== undefined) {
    pairs.push(["has source", ctx.hasSourceArtifacts ? "yes" : "no"]);
  }
  pairs.push(["schema", String(verdict.schemaVersion)]);
  pairs.push(["overall", `${fmtScore(verdict.overall.score)} / ${verdict.overall.verdict}`]);

  const meta = ctx.runMetadata ?? {};
  if (typeof meta.status === "string") pairs.push(["status", meta.status]);
  const dur = fmtDuration(meta.durationMs);
  if (dur) pairs.push(["duration", dur]);

  const tokenLine = fmtTokens(meta.tokens);
  const tokenStrip = tokenLine
    ? `<div class="token-strip" aria-label="Token usage"><span>${escapeHtml(tokenLine)}</span></div>`
    : "";

  const dl = pairs
    .map(
      ([k, v]) =>
        `<span class="meta-pair"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></span>`,
    )
    .join("");

  const prompt = ctx.taskPrompt
    ? `<p class="section-lede" style="margin-top:var(--sp-3)"><strong>Task prompt:</strong> ${escapeHtml(ctx.taskPrompt)}</p>`
    : "";

  return [
    `<footer class="section" id="metadata" aria-labelledby="metadata-heading">`,
    `<h2 class="section-title" id="metadata-heading">Metadata</h2>`,
    `<dl class="meta-strip">${dl}</dl>`,
    tokenStrip,
    prompt,
    // Hidden severity order marker for consumers / tests.
    `<div class="sr-only" data-severity-order="${SEVERITY_ORDER.join(",")}">${SEVERITY_ORDER.join(",")}</div>`,
    `</footer>`,
  ].join("\n");
}

// ── Inline JS (theme toggle only; defensive) ─────────────────────────

function renderScript(): string {
  // Minimal, defensive theme toggle. No errors if elements are absent.
  // Guards localStorage with try/catch (sandboxed iframes may throw).
  return `<script>
(function () {
  try {
    var root = document.documentElement;
    var btn = document.getElementById("theme-toggle");
    var KEY = "agenteval-report-theme";
    function apply(theme) {
      if (theme === "light" || theme === "dark") {
        root.setAttribute("data-theme", theme);
      } else {
        root.removeAttribute("data-theme");
      }
      if (btn) {
        var cur = root.getAttribute("data-theme");
        btn.textContent = cur === "dark" ? "Light mode" : cur === "light" ? "Dark mode" : "Theme";
        btn.setAttribute("aria-pressed", cur ? "true" : "false");
      }
    }
    var stored = null;
    try { stored = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
    if (stored === "light" || stored === "dark") apply(stored);
    else apply(null);
    if (btn) {
      btn.addEventListener("click", function () {
        var cur = root.getAttribute("data-theme");
        var next;
        if (cur === "dark") next = "light";
        else if (cur === "light") next = null;
        else {
          var prefersDark = false;
          try {
            prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
          } catch (e) { /* ignore */ }
          next = prefersDark ? "light" : "dark";
        }
        apply(next);
        try {
          if (next) localStorage.setItem(KEY, next);
          else localStorage.removeItem(KEY);
        } catch (e) { /* ignore */ }
      });
    }
  } catch (e) { /* never break the report */ }
})();
</script>`;
}
