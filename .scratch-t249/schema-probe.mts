import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.AGENTEVAL_DATABASE_URL! });
for (const t of ["outbox_events", "judge_result_versions", "judge_current_pointers", "judge_config_snapshots", "judge_queues", "judge_provider_operations"]) {
  const r = await pool.query(`SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t]);
  console.log(`\n== ${t} ==`);
  console.log(r.rows.map((c: any) => `${c.column_name}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`).join(", "));
}
await pool.end();
