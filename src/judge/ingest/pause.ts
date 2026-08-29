/**
 * Pause / resume for judge work (design §3 "Claims" and retry classes).
 *
 * A provider quota or rate-limit response must not burn retry attempts: the
 * queue pauses, in-flight jobs stop being claimable, and a later resume puts
 * them back on the queue at their last committed checkpoint. `pause_kind`
 * records WHY, so resume policy is explicit rather than inferred.
 */

import type Database from "better-sqlite3";

import { JUDGE_JOB_STATE, JUDGE_PAUSE_KIND, type JudgePauseKind } from "../../db/contracts.js";

/** Job states that can be paused (i.e. work that has not reached a terminal state). */
const PAUSABLE = [
  JUDGE_JOB_STATE.queued,
  JUDGE_JOB_STATE.leased,
  JUDGE_JOB_STATE.running,
  JUDGE_JOB_STATE.waiting_retry,
] as const;

export interface PauseResult {
  judgeQueueId: string;
  pausedJobs: number;
  pauseKind: JudgePauseKind;
  reason: string | null;
}

export interface ResumeResult {
  judgeQueueId: string;
  resumedJobs: number;
}

/**
 * Pause a judge queue and every non-terminal job on it.
 *
 * Pausing does NOT consume a retry attempt: `attempt_count` is untouched, and
 * the job keeps its `current_node`/`current_round`, so resume continues from
 * the last committed checkpoint rather than restarting the case.
 */
export function pauseJudgeQueue(
  db: Database.Database,
  judgeQueueId: string,
  opts: { kind?: JudgePauseKind; reason?: string | null; now?: string } = {},
): PauseResult {
  const kind = opts.kind ?? JUDGE_PAUSE_KIND.manual;
  const reason = opts.reason ?? null;
  const now = opts.now ?? new Date().toISOString();

  const tx = db.transaction((): number => {
    db.prepare(
      `UPDATE judge_queues SET status = 'paused', updated_at = ? WHERE id = ?`,
    ).run(now, judgeQueueId);

    const placeholders = PAUSABLE.map(() => "?").join(",");
    const res = db
      .prepare(
        `UPDATE judge_jobs
            SET state = '${JUDGE_JOB_STATE.paused}',
                pause_kind = ?,
                pause_reason = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
          WHERE judge_queue_id = ?
            AND state IN (${placeholders})`,
      )
      .run(kind, reason, now, judgeQueueId, ...PAUSABLE);
    return res.changes;
  });

  return { judgeQueueId, pausedJobs: tx(), pauseKind: kind, reason };
}

/**
 * Resume a paused judge queue: paused jobs become claimable again from their
 * committed checkpoints. Terminal jobs are never revived.
 */
export function resumeJudgeQueue(
  db: Database.Database,
  judgeQueueId: string,
  opts: { now?: string; onlyKind?: JudgePauseKind } = {},
): ResumeResult {
  const now = opts.now ?? new Date().toISOString();

  const tx = db.transaction((): number => {
    db.prepare(
      `UPDATE judge_queues SET status = 'active', updated_at = ? WHERE id = ?`,
    ).run(now, judgeQueueId);

    const kindClause = opts.onlyKind ? " AND pause_kind = ?" : "";
    const params: unknown[] = [now, judgeQueueId];
    if (opts.onlyKind) params.push(opts.onlyKind);

    const res = db
      .prepare(
        `UPDATE judge_jobs
            SET state = '${JUDGE_JOB_STATE.queued}',
                pause_kind = NULL,
                pause_reason = NULL,
                available_at = ?,
                updated_at = ?
          WHERE judge_queue_id = ?
            AND state = '${JUDGE_JOB_STATE.paused}'${kindClause}`,
      )
      .run(now, now, judgeQueueId, ...(opts.onlyKind ? [opts.onlyKind] : []));
    return res.changes;
  });

  return { judgeQueueId, resumedJobs: tx() };
}

/** Count jobs on a queue by state — the readable half of pause/resume. */
export function judgeQueueStatus(
  db: Database.Database,
  judgeQueueId: string,
): { status: string | null; byState: Record<string, number>; pauseKinds: Record<string, number> } {
  const q = db
    .prepare(`SELECT status FROM judge_queues WHERE id = ?`)
    .get(judgeQueueId) as { status?: string } | undefined;

  const rows = db
    .prepare(
      `SELECT state, COUNT(*) AS n FROM judge_jobs WHERE judge_queue_id = ? GROUP BY state`,
    )
    .all(judgeQueueId) as Array<{ state: string; n: number }>;

  const kinds = db
    .prepare(
      `SELECT pause_kind AS k, COUNT(*) AS n FROM judge_jobs
        WHERE judge_queue_id = ? AND pause_kind IS NOT NULL GROUP BY pause_kind`,
    )
    .all(judgeQueueId) as Array<{ k: string; n: number }>;

  return {
    status: q?.status ?? null,
    byState: Object.fromEntries(rows.map((r) => [r.state, r.n])),
    pauseKinds: Object.fromEntries(kinds.map((r) => [r.k, r.n])),
  };
}
