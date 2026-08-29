/**
 * Structured-output ladder: json_object → local validate → one repair.
 */

import type { ChatMessage, ChatResult, ModelGateway } from "./client.js";
import { GatewayError } from "./errors.js";

export interface StructuredRequest {
  attemptId: string;
  node: string;
  metricOrRole: string;
  messages: ChatMessage[];
  /** Return null if ok, else an error string for repair. */
  validate: (value: unknown) => string | null;
  model?: string;
  maxTokens?: number;
  reasoningEffort?: string;
  fetchImpl?: typeof fetch;
}

function parseJsonContent(content: string): unknown {
  let t = content.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "");
    const end = t.lastIndexOf("```");
    if (end >= 0) t = t.slice(0, end);
  }
  return JSON.parse(t);
}

/** Call the gateway in json_object mode with one local repair attempt. */
export async function chatJsonObject(
  gateway: ModelGateway,
  req: StructuredRequest,
): Promise<{ value: unknown; result: ChatResult; repaired: boolean }> {
  const base = {
    attemptId: req.attemptId,
    node: req.node,
    metricOrRole: req.metricOrRole,
    model: req.model,
    maxTokens: req.maxTokens,
    reasoningEffort: req.reasoningEffort,
    responseFormat: "json_object" as const,
    fetchImpl: req.fetchImpl,
  };

  let result = await gateway.chat({ ...base, messages: req.messages });
  let repaired = false;
  try {
    const value = parseJsonContent(result.content);
    const err = req.validate(value);
    if (err === null) return { value, result, repaired };
    // one repair
    repaired = true;
    result = await gateway.chat({
      ...base,
      metricOrRole: `${req.metricOrRole}:repair`,
      messages: [
        ...req.messages,
        { role: "assistant", content: result.content },
        {
          role: "user",
          content: `Your previous JSON failed validation: ${err}. Return corrected JSON only.`,
        },
      ],
    });
    const value2 = parseJsonContent(result.content);
    const err2 = req.validate(value2);
    if (err2 === null) return { value: value2, result, repaired };
    throw new GatewayError(`schema validation failed after repair: ${err2}`, "schema");
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    // A truncated/partial JSON body (a model hitting its token ceiling
    // mid-object) is a schema failure too, not an unrecoverable transport
    // error. Plan §4: one local repair attempt before terminal failure.
    if (err instanceof SyntaxError) {
      repaired = true;
      const repairedResult = await gateway.chat({
        ...base,
        metricOrRole: `${req.metricOrRole}:repair`,
        messages: [
          ...req.messages,
          { role: "assistant", content: result.content },
          {
            role: "user",
            content:
              "Your previous reply was cut off before the JSON completed. " +
              "Return the COMPLETE JSON object only — no commentary, no code fences, and do not stop until every brace is closed.",
          },
        ],
      });
      const repairedValue = parseJsonContent(repairedResult.content);
      const repairedErr = req.validate(repairedValue);
      if (repairedErr === null) return { value: repairedValue, result: repairedResult, repaired };
      throw new GatewayError(
        `structured output parse failed after repair: ${repairedErr}`,
        "schema",
      );
    }
    throw new GatewayError(
      `structured output parse failed: ${err instanceof Error ? err.message : String(err)}`,
      "schema",
    );
  }
}
