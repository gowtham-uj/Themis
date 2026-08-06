/**
 * Typed append helpers over the raw JSONL writer.
 */

import type { CanonicalEvent } from "./events.js";
import { appendJsonl } from "./jsonl.js";

/** Append one canonical event to a JSONL file (creates parent dirs). */
export async function appendEvent(
  filePath: string,
  event: CanonicalEvent,
): Promise<void> {
  await appendJsonl(filePath, event);
}
