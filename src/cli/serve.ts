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
const authEnabled = process.env.AGENTEVAL_AUTH === "1";
// Loopback by default. Exposing the API on a non-loopback interface with auth
// disabled would let any remote caller mint tokens, import evals, and start
// containers — require an explicit opt-in before allowing that combination.
const host = process.env.AGENTEVAL_HOST ?? (arg("host", "127.0.0.1") ?? "127.0.0.1");
const isLoopbackBind = host === "127.0.0.1" || host === "::1" || host === "localhost";
if (!authEnabled && !isLoopbackBind && process.env.AGENTEVAL_ALLOW_UNAUTH_NETWORK !== "1") {
  // eslint-disable-next-line no-console
  console.error(
    `refusing to bind ${host} with authentication disabled; ` +
      "set AGENTEVAL_AUTH=1 to require tokens, or AGENTEVAL_ALLOW_UNAUTH_NETWORK=1 to acknowledge the risk",
  );
  process.exit(1);
}
// Drive each project's pipeline in the background. Without a ticker a started
// run stays in eval_running until a caller POSTs /advance by hand.
const pipelineTickerMs = Number(process.env.AGENTEVAL_PIPELINE_TICK_MS ?? "3000");
const api = createServer({
  dataDir,
  authEnabled,
  ...(pipelineTickerMs > 0 ? { pipelineTickerMs } : {}),
});
const bound = await api.listen(port, host);
// eslint-disable-next-line no-console
console.log(`agenteval API serving on :${bound} (data=${dataDir}, auth=${authEnabled ? "on" : "off"})`);

const shutdown = async (sig: string): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log(`\n${sig} — shutting down`);
  await api.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
