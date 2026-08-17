/** Result of one deterministic eval check. */
export interface CheckResult {
  exitCode?: number;
  checkId: string;
  kind: string;
  status: "pass" | "fail" | "error" | "skipped";
  detail?: string;
  durationMs?: number;
}
