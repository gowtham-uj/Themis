/** Removed application surfaces stay unavailable in the API-only backend. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";

const servers: ApiServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function boot(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-removed-surfaces-"));
  dirs.push(dataDir);
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  return `http://127.0.0.1:${port}`;
}

describe("removed API surfaces", () => {
  it("does not mount judge, report, finding, rubric, or artifact routes", async () => {
    const base = await boot();
    const paths = [
      "/api/judgements",
      "/api/judgements/example",
      "/api/runs/example/judgements",
      "/api/runs/example/report",
      "/api/runs/example/artifacts",
      "/api/projects/example/findings",
      "/api/projects/example/rubrics",
      "/api/projects/example/queues/example/analyses",
      "/api/projects/example/compare/releases",
      "/api/projects/example/improvements",
      // Outbound webhooks removed; inbound watcher HMAC hooks remain.
      "/api/projects/example/webhooks",
      "/api/projects/example/webhooks/sub-1",
      "/api/projects/example/webhooks/sub-1/deliveries",
      "/api/projects/example/webhooks/sub-1/test",
      // Commit-evaluation routes removed (commit selection moves to queue config).
      "/api/projects/example/evaluate",
      "/api/projects/example/evaluations",
      "/api/evaluations/batch-1",
    ];
    for (const path of paths) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
    }
  });
});
