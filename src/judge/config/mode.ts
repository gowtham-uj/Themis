/**
 * Judge run mode — what the final report is FOR.
 *
 * The `evalJudge.yaml` deliverable exists to improve the AGENT under
 * evaluation (reapercode, pi, …), never the platform that ran it. Findings
 * about the harness — setup failures, metric mislabeling, unarchived harness
 * files, container issues — are "platform findings" and are surfaced only in
 * dev mode, where an operator debugging the pipeline wants to see them.
 *
 * In prod mode they are routed to the orchestrator's case record (never into
 * `improvements` or `open_questions` of the agent report), so the shipped
 * deliverable stays strictly about the agent's work.
 *
 * `THEMIS_MODE=dev` opts into dev mode; anything else (or unset) is prod —
 * the safe default.
 */

export type JudgeMode = "dev" | "prod";

/** Resolve the judge run mode from the environment. */
export function judgeMode(env: NodeJS.ProcessEnv = process.env): JudgeMode {
  return (env.THEMIS_MODE ?? "").toLowerCase() === "dev" ? "dev" : "prod";
}

/** True only in dev mode (platform findings may surface in the report). */
export function isDevJudgeMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return judgeMode(env) === "dev";
}
