/**
 * Barrel re-export for the verdict HTML report renderer.
 */

export { renderVerdictReport, type ReportContext } from "./render.js";
export {
  escapeHtml,
  fmtScore,
  fmtPercent,
  severityLabel,
  colorForSeverity,
  refHref,
  refLabel,
  severityRank,
  severityIcon,
  verdictLevelLabel,
  priorityLabel,
  comparisonLabel,
  slugId,
} from "./render-helpers.js";
export { REPORT_STYLES } from "./styles.js";
