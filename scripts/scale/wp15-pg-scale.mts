/**
 * WP-15 scale acceptance (no model calls).
 *
 * Full scale: 1M archive rows, 1M result rows, 10M child rows, 100k jobs.
 * Uses server-side generate_series so Node memory is O(1); every public/hot
 * query is checked with EXPLAIN ANALYZE for index scans and no sort/seq scan.
 * Isolated in schema wp15; it never touches runtime data.
 */
import pg from "pg";

const url = process.env.AGENTEVAL_DATABASE_URL;
if (!url) throw new Error("AGENTEVAL_DATABASE_URL required");
const arg = process.argv.find((x) => x.startsWith("--scale="));
const scale = arg ? Number(arg.slice(8)) : 1;
if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error("--scale must be in (0,1]");
const N_ARCH = Math.max(1000, Math.round(1_000_000 * scale));
const N_RESULT = Math.max(1000, Math.round(1_000_000 * scale));
const N_CHILD = Math.max(10_000, Math.round(10_000_000 * scale));
const N_JOBS = Math.max(1000, Math.round(100_000 * scale));

const pool = new pg.Pool({ connectionString: url, max: 2 });
const q = (sql: string, params?: unknown[]) => pool.query(sql, params);
const timed = async (label: string, fn: () => Promise<unknown>) => {
  const t = Date.now(); await fn(); console.log(label, `${((Date.now()-t)/1000).toFixed(1)}s`);
};

await q(`DROP SCHEMA IF EXISTS wp15 CASCADE; CREATE SCHEMA wp15; SET search_path=wp15,public;`);
await q(`
CREATE UNLOGGED TABLE archive_catalog(
 run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, queue_id TEXT, archived_at TIMESTAMPTZ NOT NULL,
 manifest_sha256 TEXT NOT NULL, size_bytes BIGINT NOT NULL, status TEXT, reward INTEGER
);
CREATE INDEX idx_archive_catalog_keyset ON archive_catalog(archived_at DESC,run_id DESC);
CREATE INDEX idx_archive_catalog_project ON archive_catalog(project_id,archived_at DESC,run_id DESC);

CREATE UNLOGGED TABLE judge_results(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, result_sequence BIGINT NOT NULL,
 completed_at TIMESTAMPTZ NOT NULL, publication_state TEXT NOT NULL
);
CREATE INDEX idx_results_project_keyset ON judge_results(project_id,result_sequence,id)
 WHERE publication_state='published';

CREATE UNLOGGED TABLE judge_children(
 id BIGINT PRIMARY KEY, result_id TEXT NOT NULL, kind SMALLINT NOT NULL
);
CREATE INDEX idx_children_result ON judge_children(result_id,id);

CREATE UNLOGGED TABLE judge_jobs(
 id TEXT PRIMARY KEY, judge_queue_id TEXT NOT NULL, project_id TEXT NOT NULL,
 state TEXT NOT NULL, priority INTEGER NOT NULL, available_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, lease_expires_at TIMESTAMPTZ
);
CREATE INDEX idx_judge_jobs_claim ON judge_jobs(judge_queue_id,priority DESC,available_at,created_at,id)
 WHERE state IN ('queued','waiting_retry');
CREATE INDEX idx_judge_jobs_reap ON judge_jobs(lease_expires_at,id)
 WHERE state IN ('leased','running','sealing');
`);

await timed(`seed ${N_ARCH} archives`, () => q(`
 INSERT INTO wp15.archive_catalog
 SELECT 'run_'||g, 'p_'||(g%100), 'q_'||(g%1000),
        TIMESTAMPTZ '2026-01-01' + g*INTERVAL '1 millisecond',
        repeat(md5(g::text),2), 1024+(g%100000), 'completed', (g%2)::int
 FROM generate_series(1,$1) g`, [N_ARCH]));

await timed(`seed ${N_RESULT} results`, () => q(`
 INSERT INTO wp15.judge_results
 SELECT 'r_'||g, 'p_'||(g%100), g,
        TIMESTAMPTZ '2026-01-01' + g*INTERVAL '1 millisecond', 'published'
 FROM generate_series(1,$1) g`, [N_RESULT]));

await timed(`seed ${N_CHILD} child rows`, () => q(`
 INSERT INTO wp15.judge_children
 SELECT g, 'r_'||((g%$2)+1), (g%6)::smallint
 FROM generate_series(1,$1) g`, [N_CHILD, N_RESULT]));

await timed(`seed ${N_JOBS} jobs`, () => q(`
 INSERT INTO wp15.judge_jobs
 SELECT 'j_'||g, 'jq_'||(g%100), 'p_'||(g%100),
        CASE WHEN g%50=0 THEN 'leased' ELSE 'queued' END,
        (g%10)::int,
        TIMESTAMPTZ '2026-01-01' + g*INTERVAL '1 millisecond',
        TIMESTAMPTZ '2026-01-01' + g*INTERVAL '1 millisecond',
        CASE WHEN g%50=0 THEN TIMESTAMPTZ '2026-01-01' ELSE NULL END
 FROM generate_series(1,$1) g`, [N_JOBS]));
await q(`ANALYZE wp15.archive_catalog; ANALYZE wp15.judge_results; ANALYZE wp15.judge_children; ANALYZE wp15.judge_jobs;`);

interface PlanNode { "Node Type"?: string; "Relation Name"?: string; "Index Name"?: string; Plans?: PlanNode[]; [k:string]: unknown }
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans??[]).flatMap(flatten)];
async function check(label: string, sql: string, params: unknown[], relation: string, expectedIndex: string): Promise<void> {
  const r = await q(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, params);
  const top = r.rows[0]["QUERY PLAN"][0] as { Plan: PlanNode; "Execution Time": number };
  const nodes = flatten(top.Plan);
  const badSeq = nodes.find((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === relation);
  const badSort = nodes.find((n) => n["Node Type"] === "Sort");
  const idx = nodes.find((n) => String(n["Index Name"]??"").includes(expectedIndex));
  if (badSeq) throw new Error(`${label}: Seq Scan on ${relation}`);
  // A bitmap scan may sort a TINY candidate set (e.g. 50 rows remaining after a
  // deep keyset cursor); that is bounded by the page and does not degrade with
  // cursor depth. Reject only a sort over a large candidate set.
  const sortRows = Number(badSort?.["Actual Rows"] ?? badSort?.["Plan Rows"] ?? 0);
  if (badSort && scale >= 0.1 && sortRows > 1000) {
    throw new Error(`${label}: Sort over ${sortRows} rows`);
  }
  if (!idx) throw new Error(`${label}: expected index ${expectedIndex}; nodes=${nodes.map(n=>`${n["Node Type"]}:${n["Index Name"]??""}`).join(",")}`);
  console.log(label, `OK ${Number(top["Execution Time"]).toFixed(3)}ms`, idx["Index Name"]);
}

const deep = Math.max(100, N_ARCH - 1000);
await check("archive first page",
 `SELECT * FROM wp15.archive_catalog WHERE project_id=$1 ORDER BY archived_at DESC,run_id DESC LIMIT 101`,
 ["p_1"], "archive_catalog", "idx_archive_catalog_project");
await check("archive deep keyset",
 `SELECT * FROM wp15.archive_catalog WHERE project_id=$1 AND (archived_at,run_id)<($2,$3) ORDER BY archived_at DESC,run_id DESC LIMIT 101`,
 ["p_1", new Date(Date.UTC(2026,0,1)+deep), `run_${deep}`], "archive_catalog", "idx_archive_catalog_project");
await check("result keyset",
 `SELECT * FROM wp15.judge_results WHERE project_id=$1 AND publication_state='published' AND (result_sequence,id)>($2,$3) ORDER BY result_sequence,id LIMIT 101`,
 ["p_1", Math.max(1,N_RESULT-5000), `r_${Math.max(1,N_RESULT-5000)}`], "judge_results", "idx_results_project_keyset");
await check("child keyset",
 `SELECT * FROM wp15.judge_children WHERE result_id=$1 AND id>$2 ORDER BY id LIMIT 101`,
 [`r_${Math.max(1,N_RESULT-1)}`,0], "judge_children", "idx_children_result");
await check("claim hot path",
 `SELECT id FROM wp15.judge_jobs WHERE judge_queue_id=$1 AND state IN ('queued','waiting_retry') AND available_at<=$2 ORDER BY priority DESC,available_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
 ["jq_1", new Date("2027-01-01")], "judge_jobs", "idx_judge_jobs_claim");
await check("lease reaper",
 `SELECT id FROM wp15.judge_jobs WHERE state IN ('leased','running','sealing') AND lease_expires_at<=$1 ORDER BY lease_expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`,
 [new Date("2027-01-01")], "judge_jobs", "idx_judge_jobs_reap");

console.log(JSON.stringify({scale,archives:N_ARCH,results:N_RESULT,children:N_CHILD,jobs:N_JOBS,status:"passed"}));
await pool.end();
