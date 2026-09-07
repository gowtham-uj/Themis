/**
 * The court can only claim `fix_type: research_backed` when it holds a real
 * `web:` ref, so the search tool has to actually retrieve one. The old fallback
 * asked the eval provider to search through an OpenAI-compatible tools array;
 * DeepInfra answers `finish_reason: tool_calls` and runs nothing, so every
 * court got a body with zero URLs and honestly declined to cite anything.
 *
 * These cover the parts that decide what gets retrieved: which providers run,
 * how their results merge, and the ref shape minos copies.
 */
import { afterEach, describe, expect, it } from "vitest";
import { formatWebResults, webResearch, type WebResult } from "../src/judge/tools/web-research.ts";

const saved = {
  key: process.env.SERPER_API_KEY,
  aliasKey: process.env.SERPER_SEARCH_API_KEY,
  order: process.env.THEMIS_WEB_SEARCH_PROVIDERS,
};
const realFetch = globalThis.fetch;

afterEach(() => {
  if (saved.key === undefined) delete process.env.SERPER_API_KEY;
  else process.env.SERPER_API_KEY = saved.key;
  if (saved.aliasKey === undefined) delete process.env.SERPER_SEARCH_API_KEY;
  else process.env.SERPER_SEARCH_API_KEY = saved.aliasKey;
  if (saved.order === undefined) delete process.env.THEMIS_WEB_SEARCH_PROVIDERS;
  else process.env.THEMIS_WEB_SEARCH_PROVIDERS = saved.order;
  globalThis.fetch = realFetch;
});

/** Answer each provider's host with a canned body; record what was asked. */
function stubFetch(handlers: Record<string, () => string>): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    for (const [host, body] of Object.entries(handlers)) {
      if (url.includes(host)) {
        return new Response(body(), { status: 200 });
      }
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return seen;
}

const SERPER_BODY = () =>
  JSON.stringify({
    organic: [
      { title: "Verification in agent harnesses", link: "https://example.invalid/harness", snippet: "run the suite" },
      { title: "No link here" },
    ],
  });

const ARXIV_BODY = () =>
  `<feed><entry><title>Self-verifying code agents</title>` +
  `<id>http://arxiv.org/abs/2501.00001v1</id>` +
  `<summary>A study of agents that run their own tests.</summary></entry></feed>`;

describe("web research providers", () => {
  it("queries the general web and arXiv together, papers first", async () => {
    process.env.SERPER_API_KEY = "test-key-not-real";
    delete process.env.SERPER_SEARCH_API_KEY;
    delete process.env.THEMIS_WEB_SEARCH_PROVIDERS;
    const seen = stubFetch({ "serper.dev": SERPER_BODY, "arxiv.org": ARXIV_BODY });

    const results = await webResearch("agent verification");

    // Both ran. Serper answers what practitioners do; arXiv answers whether it
    // has been studied. Falling through to one would lose half the question.
    expect(seen.some((u) => u.includes("serper.dev"))).toBe(true);
    expect(seen.some((u) => u.includes("arxiv.org"))).toBe(true);
    // A court weighing a remedy should read the research before the blog posts.
    expect(results[0]?.source).toBe("arxiv");
    expect(results.map((r) => r.source)).toContain("serper");
    // The entry with no link is dropped rather than cited as an empty ref.
    expect(results.every((r) => r.url.startsWith("http"))).toBe(true);
  });

  it("skips a provider whose credential is missing instead of failing", async () => {
    delete process.env.SERPER_API_KEY;
    delete process.env.SERPER_SEARCH_API_KEY;
    delete process.env.THEMIS_WEB_SEARCH_PROVIDERS;
    const seen = stubFetch({ "arxiv.org": ARXIV_BODY, "r.jina.ai": () => "" });

    const results = await webResearch("agent verification");

    // No key means no Serper call at all, and the reader fallback covers the
    // general web. Adding the key later turns Serper on with no code change.
    expect(seen.some((u) => u.includes("serper.dev"))).toBe(false);
    expect(results.some((r) => r.source === "arxiv")).toBe(true);
  });

  it("accepts SERPER_SEARCH_API_KEY as the project-facing alias", async () => {
    delete process.env.SERPER_API_KEY;
    process.env.SERPER_SEARCH_API_KEY = "test-key-not-real";
    delete process.env.THEMIS_WEB_SEARCH_PROVIDERS;
    const seen = stubFetch({ "serper.dev": SERPER_BODY, "arxiv.org": ARXIV_BODY });

    const results = await webResearch("agent verification");

    expect(seen.some((u) => u.includes("serper.dev"))).toBe(true);
    expect(results.some((r) => r.source === "serper")).toBe(true);
  });

  it("keeps arXiv scholarly even when the override lists it first", async () => {
    process.env.SERPER_API_KEY = "test-key-not-real";
    process.env.THEMIS_WEB_SEARCH_PROVIDERS = "arxiv,serper";
    const seen = stubFetch({ "serper.dev": SERPER_BODY, "arxiv.org": ARXIV_BODY });

    await webResearch("agent verification");

    // Order in the override picks the set, not the roles: naming arXiv first
    // must not make it the general-web provider and shut Serper out.
    expect(seen.some((u) => u.includes("serper.dev"))).toBe(true);
    expect(seen.some((u) => u.includes("arxiv.org"))).toBe(true);
  });

  it("says nothing was retrieved rather than inviting a citation", async () => {
    const text = formatWebResults("some query", []);
    expect(text).toContain("No sources retrieved");
    expect(text).toContain("Do not cite anything");
  });

  it("prints each source as a ref minos can copy verbatim", () => {
    const results: WebResult[] = [
      { title: "T", url: "https://example.invalid/a", snippet: "s", source: "arxiv" },
    ];
    const text = formatWebResults("q", results);
    // The templates validate `web:<url>`; handing over the exact string means
    // minos cites by copying instead of reconstructing a URL from prose.
    expect(text).toContain("ref: web:https://example.invalid/a");
    expect(text).toContain("never");
  });
});
