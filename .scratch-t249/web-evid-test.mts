import { checkTierA } from "../src/judge/quality/tier-a-structural.ts";
const yaml = `
final_report: true
eval_id: r-web
agent_under_evaluation: reapercode
rounds_run: 1
official_reward: 1
verdict:
  approach: principled
  integrity: clean
  competence: 4
  reconciliation: consistent
narrative: The agent showed a recurring over-eager self-test pattern, then verified each transition.
what_the_agent_did_well:
  - observation: Verified every transition with a self-written behavioral script.
    ref: tool_call:call_abc
improvements:
  - issue: Recurring pattern of writing over-eager ad-hoc self-tests that miss downgrade corners.
    evidence:
      - report: report:logos#round1
        ref: report:logos#round1
        kind: archive
      - report: web:https://example.com/coding-agent-verification
        ref: web:https://example.com/coding-agent-verification
        kind: web
    recommendation: Adopt property-based self-verification (see the web source) instead of example-driven ad-hoc scripts.
    category: process
    impact: medium
    confidence: high
integrity_summary:
  verdict: clean
  findings: []
reward_reconciliation: The reward follows from the recorded process.
case_coverage:
  tangents_total: 0
  tangents_resolved: 0
  tangents_open: 0
  closed_by: no_new_tangents
  converged: true
open_questions: []
revision_history: []
confidence_in_this_report: medium
confidence_basis: Grounded in the diff and the trajectory.
`;
const a = checkTierA(yaml);
console.log("A:", a.status, a.violations.length);
for (const v of a.violations) console.log("  A:", v.rule, "@"+v.path, v.message);
