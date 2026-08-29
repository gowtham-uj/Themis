import pg from "pg";
import { migrate, schemaVersion } from "../src/db/postgres/migrate.ts";
const pool = new pg.Pool({ connectionString: process.env.AGENTEVAL_DATABASE_URL! });
await migrate(pool);
console.log("fresh schemaVersion:", await schemaVersion(pool));
await migrate(pool);
console.log("fresh replay ok");
await pool.end();
