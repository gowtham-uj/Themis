/**
 * Judge-side model policy for the mock gateway.
 *
 * The judge and the agents speak the same Anthropic Messages API, so one
 * gateway serves both. What differs is the reply: an agent gets tool calls, the
 * judge gets a verdict JSON.
 *
 * This policy reads the REAL prompt the judge assembled — the events preview,
 * the diff, the rubric — and returns a verdict grounded in what it finds there.
 * It is a stand-in for the model, not for the judge: prompt assembly, JSON
 * extraction, `validateVerdict`, findings ingest and theme building all run for
 * real against what this returns.
 *
 * The analysis is deliberately written the way the prompt asks for it — routed
 * to a subsystem, anchored at a decision point with a counterfactual, and
 * carrying a verification set — so the report's structure is exercised end to
 * end rather than assumed.
 */

import type { GatewayTurn, MockGatewayOptions } from "./mock-model-gateway.js";

/** Flatten the user turn to text, whatever content shape it arrived in. */
function userText(messages: ReadonlyArray<Record<string, unknown>>): string {
  const last = messages[messages.length - 1];
  const content = last?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .join("\n");
}

/** Extract the criterion ids the rubric actually defines. */
function criterionIds(prompt: string): string[] {
  const ids = new Set<string>();
  for (const m of prompt.matchAll(/"id"\s*:\s*"([A-H]\d+)"/g)) ids.add(m[1]!);
  for (const m of prompt.matchAll(/\b([A-H]\d)\b\s*[·:]/g)) ids.add(m[1]!);
  return [...ids];
}

/** Pull the highest trace seq mentioned, so refs point at real events. */
function maxSeq(prompt: string): number {
  let max = 0;
  for (const m of prompt.matchAll(/"seq"\s*:\s*(\d+)/g)) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Decide the verdict from what the prompt actually shows.
 *
 * Three signals, each read from the real evidence:
 *  - did the agent edit the target file (diff present)?
 *  - did it run a check AFTER its last edit (tool ordering in the trace)?
 *  - did it touch anything beyond what was asked?
 */
export function judgePolicy(): MockGatewayOptions["policy"] {
  return ({ messages }): GatewayTurn => {
    const prompt = userText(messages);

    const hasDiff = /diff --git|\+\+\+ b\//.test(prompt);
    const testRunSeqs = [...prompt.matchAll(/"name"\s*:\s*"(bash|run_tests|shell)"/g)];
    const editSeqs = [...prompt.matchAll(/"name"\s*:\s*"(edit_file|write_file|file_edit|str_replace)"/g)];
    // Ordering, not presence: verifying BEFORE the last edit proves nothing
    // about the state the agent left behind.
    const verifiedAfterLastEdit =
      testRunSeqs.length > 0 &&
      editSeqs.length > 0 &&
      (testRunSeqs[testRunSeqs.length - 1]?.index ?? 0) >
        (editSeqs[editSeqs.length - 1]?.index ?? 0);

    const ids = criterionIds(prompt);
    const top = maxSeq(prompt);
    const lastEditSeq = Math.max(1, Math.floor(top * 0.7));

    const outcomeScore = hasDiff ? 0.85 : 0.15;
    const verifyScore = verifiedAfterLastEdit ? 1 : 0;
    const scopeScore = 0.9;

    const findings: unknown[] = [];
    if (!hasDiff) {
      findings.push({
        id: "f-no-change",
        category: "task_incomplete",
        severity: "blocker",
        confidence: 0.95,
        claim:
          "The agent produced no change to the target file, so the requested fix was never made.",
        refs: [{ kind: "trace", runId: "r", seqs: [1, Math.max(1, top)] }],
        subsystem: "scaffold",
        decisionPoint: {
          seq: Math.max(1, top),
          whatHappened: "the run ended with the workspace unmodified",
          counterfactual:
            "before ending, confirm at least one edit was applied and re-read the file to prove it",
        },
        fix: {
          direction:
            "Require the loop to assert that an edit landed — re-read the target file and compare — before it is allowed to terminate.",
        },
      });
    }
    if (!verifiedAfterLastEdit) {
      findings.push({
        id: "f-unverified",
        category: "verification_skipped",
        severity: "major",
        confidence: 0.9,
        claim:
          "The agent did not run the test command after its final edit, so nothing in the trace establishes that the code it left behind works.",
        refs: [{ kind: "trace", runId: "r", seqs: [lastEditSeq, Math.max(lastEditSeq, top)] }],
        subsystem: "prompt",
        decisionPoint: {
          seq: Math.max(lastEditSeq, top),
          whatHappened:
            "the run concluded after the final edit with no subsequent test execution",
          counterfactual:
            "run the test command as the terminal action, and only report success if it passed",
          evidenceAvailableAtSeq: lastEditSeq,
        },
        fix: {
          direction:
            "Make the last action of any edit loop a fresh run of the task's verification command, and gate the success message on that run passing.",
          repro: { command: "node test/range.test.js", expected: "all tests passed" },
        },
      });
    }

    const verdict = {
      schemaVersion: 1,
      overall: {
        score: Number(
          (
            (outcomeScore * 3 + verifyScore * 2 + scopeScore * 1) /
            6
          ).toFixed(2),
        ),
        verdict: hasDiff && verifiedAfterLastEdit ? "pass" : "partial",
        summary: hasDiff
          ? verifiedAfterLastEdit
            ? "The change was made and verified after the final edit."
            : "The change was made, but the agent never re-ran the check afterwards, so its correctness is unestablished."
          : "No change was made to the target file.",
      },
      criteria: ids.slice(0, 3).map((id, i) => ({
        criterion: id,
        weight: [3, 2, 1][i] ?? 1,
        score: [outcomeScore, verifyScore, scopeScore][i] ?? 0.5,
        feedback:
          i === 0
            ? hasDiff
              ? "A change to the target file is present in the diff."
              : "The diff is empty — the requested change was not made."
            : i === 1
              ? verifiedAfterLastEdit
                ? "A verification command ran after the final edit."
                : "No verification ran after the final edit; earlier runs say nothing about the final state."
              : "No unrelated files were modified.",
        evidence: [
          i === 0
            ? hasDiff
              ? "diff contains a change to the target file"
              : "diff is empty"
            : `trace: ${testRunSeqs.length} check(s), ${editSeqs.length} edit(s)`,
        ],
        findingIds:
          i === 0 && !hasDiff
            ? ["f-no-change"]
            : i === 1 && !verifiedAfterLastEdit
              ? ["f-unverified"]
              : [],
      })),
      findings,
      positiveFindings:
        editSeqs.length > 0
          ? [
              {
                id: "p-located",
                category: "targeted_edit",
                severity: "nit",
                confidence: 0.8,
                claim:
                  "The agent located the relevant file and edited it directly rather than rewriting surrounding code.",
                refs: [{ kind: "trace", runId: "r", seqs: [1, Math.max(1, lastEditSeq)] }],
              },
            ]
          : [],
      metaFindings: [],
      diagnostics: {
        verification_performed: {
          value: verifiedAfterLastEdit,
          refs: [{ kind: "trace", runId: "r", seqs: [1, Math.max(1, top)] }],
          note: verifiedAfterLastEdit
            ? "a check ran after the last edit"
            : "no check ran after the last edit",
        },
      },
      attribution: { agent_vs_environment: "agent" },
      observations: [
        `${editSeqs.length} edit action(s) and ${testRunSeqs.length} check action(s) in the trace.`,
      ],
      improvements: {
        summary: verifiedAfterLastEdit
          ? "Behaviour is sound; no process change needed."
          : "One ordering change closes the gap: verify last, not first.",
        withoutSource: verifiedAfterLastEdit
          ? []
          : [
              {
                area: "verification",
                priority: "high",
                change:
                  "Make a fresh verification run the terminal action of the edit loop.",
                why:
                  "The trace shows edits after the last check, so the reported outcome describes a state the agent never observed.",
                refs: [
                  { kind: "trace", runId: "r", seqs: [lastEditSeq, Math.max(lastEditSeq, top)] },
                ],
                linkedFindings: ["f-unverified"],
              },
            ],
      },
    };

    return {
      stopReason: "end_turn",
      blocks: [{ type: "text", text: JSON.stringify(verdict) }],
    };
  };
}

/**
 * One policy serving both callers.
 *
 * The judge's request is recognizable by its prompt: it asks for verdict JSON
 * and advertises no tools, where an agent always advertises its toolset.
 */
export function combinedPolicy(
  agentPolicy: MockGatewayOptions["policy"],
): MockGatewayOptions["policy"] {
  const judge = judgePolicy();
  return (ctx) => {
    const isJudge =
      ctx.toolNames.length === 0 ||
      /verdict|rubric|criteria/i.test(userText(ctx.messages).slice(0, 4000));
    return isJudge ? judge(ctx) : agentPolicy(ctx);
  };
}
