/**
 * Standalone API server entry: `node dist/cli/serve.js --port 8080 --data-dir ./data`.
 * Boots createServer on the given port and stays up. Auth off by default for
 * loopback testing; set AGENTEVAL_AUTH=1 to require bearer tokens.
 */
import { resolve } from "node:path";
import { createServer } from "../api/server.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const port = Number(arg("port", process.env.PORT ?? "8080"));
const dataDir = resolve(arg("data-dir", process.env.DATA_DIR ?? "./data") ?? "./data");
const api = createServer({
  dataDir,
  authEnabled: process.env.AGENTEVAL_AUTH === "1",
});
const bound = await api.listen(port, "0.0.0.0");
// eslint-disable-next-line no-console
console.log(`agenteval API serving on :${bound} (data=${dataDir})`);

const shutdown = async (sig: string): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log(`\n${sig} — shutting down`);
  await api.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
