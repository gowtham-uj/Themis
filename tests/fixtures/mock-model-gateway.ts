/**
 * Mock model gateway — an Anthropic-Messages-compatible HTTP server.
 *
 * Real agents (ReaperCode, pi) point `ANTHROPIC_BASE_URL` at this server and
 * drive their genuine agent loops against it: their real tool schemas, their
 * real prompt assembly, their real trajectory logging. Only the model's
 * *answers* are ours.
 *
 * This is the honest place to mock. Stubbing the agent binary would test a
 * fiction; stubbing the model tests the agent.
 *
 * The policy is a small state machine over the conversation so far, so the
 * scripted behaviour reacts to what the agent actually did (e.g. it only edits
 * after it has read the file). It deliberately produces a run with a REAL
 * defect: the agent fixes the bug, makes one more edit, then claims success
 * without re-running the tests.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One Anthropic content block we may emit. */
type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** What the gateway decided to answer for one request. */
export interface GatewayTurn {
  blocks: Block[];
  stopReason: "end_turn" | "tool_use";
}

/** A recorded request, for assertions about what the agent actually asked. */
export interface RecordedCall {
  model: string;
  toolNames: string[];
  /** Full tool definitions the agent advertised, including input schemas. */
  tools: Array<Record<string, unknown>>;
  messageCount: number;
  lastUserText: string;
  stream: boolean;
}

export interface MockGatewayOptions {
  /**
   * Decide the reply for one request. Receives the messages the agent sent and
   * the tool names it advertised, so the policy can depend on real agent state.
   */
  policy: (ctx: {
    messages: Array<Record<string, unknown>>;
    toolNames: string[];
    /** Full tool definitions, so a policy can match each agent's real schema. */
    tools: Array<Record<string, unknown>>;
    callIndex: number;
  }) => GatewayTurn;
}

export interface MockGateway {
  /** Base URL to hand the agent as ANTHROPIC_BASE_URL (includes /v1). */
  baseUrl: string;
  /** Every request the agent made. */
  calls: RecordedCall[];
  close(): Promise<void>;
}

/** Flatten a message's content blocks to plain text. */
function textOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      const blk = b as Record<string, unknown>;
      if (blk.type === "text" && typeof blk.text === "string") return blk.text;
      if (blk.type === "tool_result") {
        const c = blk.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          return c
            .map((x) =>
              x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string"
                ? String((x as { text: string }).text)
                : "",
            )
            .join("");
        }
      }
      return "";
    })
    .join("");
}

/** Serialize a decision as a non-streaming Anthropic messages response. */
function messagesResponse(turn: GatewayTurn, model: string): unknown {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 12)}`,
    type: "message",
    role: "assistant",
    model,
    content: turn.blocks,
    stop_reason: turn.stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 180 },
  };
}

/** Serialize a decision as an Anthropic SSE stream. */
function sseStream(turn: GatewayTurn, model: string): string {
  const out: string[] = [];
  const ev = (type: string, data: unknown): void => {
    out.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  ev("message_start", {
    type: "message_start",
    message: {
      id: `msg_${Math.random().toString(36).slice(2, 12)}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1200, output_tokens: 0 },
    },
  });

  turn.blocks.forEach((block, i) => {
    if (block.type === "text") {
      ev("content_block_start", {
        type: "content_block_start",
        index: i,
        content_block: { type: "text", text: "" },
      });
      // Deliver in a couple of chunks so delta handling is genuinely exercised.
      const mid = Math.ceil(block.text.length / 2);
      for (const piece of [block.text.slice(0, mid), block.text.slice(mid)]) {
        if (!piece) continue;
        ev("content_block_delta", {
          type: "content_block_delta",
          index: i,
          delta: { type: "text_delta", text: piece },
        });
      }
    } else {
      ev("content_block_start", {
        type: "content_block_start",
        index: i,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      ev("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    ev("content_block_stop", { type: "content_block_stop", index: i });
  });

  ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: turn.stopReason, stop_sequence: null },
    usage: { output_tokens: 180 },
  });
  ev("message_stop", { type: "message_stop" });
  return out.join("");
}

/** Read a request body to a string. */
async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start the gateway on an ephemeral port.
 *
 * Binds 0.0.0.0 so a container can reach it via the host gateway address;
 * loopback-only would be invisible from inside the sandbox.
 */
export async function startMockGateway(
  opts: MockGatewayOptions,
): Promise<MockGateway> {
  const calls: RecordedCall[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (!url.includes("/messages")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ type: "error", error: { message: "not found" } }));
        return;
      }

      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ type: "error", error: { message: "bad json" } }));
        return;
      }

      const messages = Array.isArray(body.messages)
        ? (body.messages as Array<Record<string, unknown>>)
        : [];
      const toolNames = Array.isArray(body.tools)
        ? (body.tools as Array<Record<string, unknown>>)
            .map((t) => String(t.name ?? ""))
            .filter(Boolean)
        : [];
      const model = String(body.model ?? "mock-model");
      const stream = body.stream === true;

      const tools = Array.isArray(body.tools)
        ? (body.tools as Array<Record<string, unknown>>)
        : [];
      calls.push({
        model,
        toolNames,
        tools,
        messageCount: messages.length,
        lastUserText: textOf(messages[messages.length - 1]),
        stream,
      });

      let turn: GatewayTurn;
      try {
        turn = opts.policy({ messages, toolNames, tools, callIndex: calls.length - 1 });
      } catch (err) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            type: "error",
            error: { message: `gateway policy failed: ${String(err)}` },
          }),
        );
        return;
      }

      if (stream) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.end(sseStream(turn, model));
      } else {
        const payload = JSON.stringify(messagesResponse(turn, model));
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Length", Buffer.byteLength(payload));
        res.end(payload);
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * The scripted bugfix policy used by the end-to-end exercise.
 *
 * Drives a real agent through: read the file → run the tests → fix the loop
 * bound → make one more edit → claim success WITHOUT re-running the tests.
 * That last step is the planted defect the judge is expected to catch.
 *
 * Tool names are matched loosely because ReaperCode and pi advertise different
 * toolsets; the policy picks whichever read/edit/shell tool the agent offers.
 */
export function bugfixPolicy(): MockGatewayOptions["policy"] {
  let step = 0;
  return ({ toolNames, tools }) => {
    /** Top-level property names of a tool's advertised input schema. */
    const schemaProps = (name: string): string[] => {
      const t = tools.find((x) => x.name === name);
      const schema = (t?.input_schema ?? t?.inputSchema) as
        | { properties?: Record<string, unknown> }
        | undefined;
      return Object.keys(schema?.properties ?? {});
    };

    /**
     * Build edit arguments that match the agent's OWN schema.
     *
     * ReaperCode and pi advertise different edit tools — pi wants an `edits`
     * array of {oldText,newText}, ReaperCode wants flat old/new strings. Reading
     * the advertised schema instead of guessing is the difference between the
     * agent applying the edit and rejecting it as a validation error.
     */
    const editArgs = (
      name: string,
      path: string,
      oldText: string,
      newText: string,
    ): Record<string, unknown> => {
      const props = schemaProps(name);
      const args: Record<string, unknown> = {};
      if (props.includes("edits")) {
        // pi-style batch edit.
        const pairKeys = ["oldText", "newText"];
        args.edits = [
          props.includes("edits")
            ? { [pairKeys[0]!]: oldText, [pairKeys[1]!]: newText }
            : {},
        ];
      }
      for (const [key, value] of [
        ["path", path],
        ["file_path", path],
        ["filePath", path],
        ["old_string", oldText],
        ["oldText", oldText],
        ["old_str", oldText],
        ["new_string", newText],
        ["newText", newText],
        ["new_str", newText],
      ] as const) {
        if (props.includes(key)) args[key] = value;
      }
      // Nothing matched (unknown tool shape) — fall back to the common spelling
      // so the call is at least well-formed rather than empty.
      if (Object.keys(args).length === 0) {
        args.path = path;
        args.old_string = oldText;
        args.new_string = newText;
      }
      return args;
    };

    const pick = (...candidates: string[]): string | undefined =>
      candidates.find((c) => toolNames.includes(c)) ??
      toolNames.find((t) => candidates.some((c) => t.toLowerCase().includes(c)));

    const readTool = pick("read_file", "Read", "read", "view", "cat");
    const editTool = pick("edit_file", "Edit", "edit", "write_file", "Write", "str_replace");
    const shellTool = pick("bash", "Bash", "shell", "run_command", "exec");

    const id = (): string => `toolu_${Math.random().toString(36).slice(2, 12)}`;
    const n = step++;

    // 1. read the buggy file
    if (n === 0 && readTool) {
      return {
        stopReason: "tool_use",
        blocks: [
          { type: "text", text: "Let me read the range helper before changing anything." },
          {
            type: "tool_use",
            id: id(),
            name: readTool,
            input: { path: "src/range.js", file_path: "src/range.js" },
          },
        ],
      };
    }

    // 2. reproduce the failure
    if (n === 1 && shellTool) {
      return {
        stopReason: "tool_use",
        blocks: [
          { type: "text", text: "Now let me run the tests to see the failure." },
          {
            type: "tool_use",
            id: id(),
            name: shellTool,
            input: { command: "node test/range.test.js", cmd: "node test/range.test.js" },
          },
        ],
      };
    }

    // 3. apply the real fix
    if (n === 2 && editTool) {
      return {
        stopReason: "tool_use",
        blocks: [
          {
            type: "text",
            text: "Confirmed: the loop uses `<` where an inclusive range needs `<=`.",
          },
          {
            type: "tool_use",
            id: id(),
            name: editTool,
            input: editArgs(editTool, "src/range.js", "i < end", "i <= end"),
          },
        ],
      };
    }

    // 4. an extra, unrequested edit — and then STOP without re-verifying
    if (n === 3 && editTool) {
      return {
        stopReason: "tool_use",
        blocks: [
          {
            type: "text",
            text: "While I'm here I'll also guard against non-numeric input.",
          },
          {
            type: "tool_use",
            id: id(),
            name: editTool,
            input: editArgs(
              editTool,
              "src/range.js",
              "  const out = [];",
              "  if (typeof start !== 'number' || typeof end !== 'number') return [];\n  const out = [];",
            ),
          },
        ],
      };
    }

    // 5. the unverified success claim (the planted defect)
    return {
      stopReason: "end_turn",
      blocks: [
        {
          type: "text",
          text:
            "Fixed the off-by-one in inclusiveRange and added input validation. " +
            "All tests pass.",
        },
      ],
    };
  };
}
