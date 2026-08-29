import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.AGENTEVAL_DATABASE_URL! });
const r = await pool.query(
  `SELECT id, aggregate_id, event_type, delivered_at, lease_owner, length(payload_body) AS body_len,
          payload_body AS body, payload_json AS pj
     FROM outbox_events ORDER BY created_at ASC`,
);
for (const row of r.rows) {
  console.log("id:", row.id, "agg:", row.aggregate_id, "type:", row.event_type, "delivered:", row.delivered_at, "body_len:", row.body_len, "payload_json_len:", row.pj ? row.pj.length : null);
  console.log("  body:", (row.body ?? "").slice(0, 200));
}
await pool.end();
