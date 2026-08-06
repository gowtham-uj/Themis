/**
 * Offline FakeJudgeProvider for tests — returns a canned verdict fixture
 * (or an injected override) plus synthetic thinking events. No network.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalEvent } from "../schema/events.js";
import { SCHEMA_VERSION } from "../schema/events.js";
import type {
  JudgeProvider,
  JudgeProviderResult,
  JudgeRequest,
} from "./provider.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Default fixture path (repo tests/fixtures/verdict-sample.json). */
export const DEFAULT_VERDICT_FIXTURE = join(
  HERE,
  "../../tests/fixtures/verdict-sample.json",
);

/** Options controlling what the fake returns. */
export interface FakeJudgeProviderOptions {
  /** Absolute path to a valid verdict JSON fixture (default: verdict-sample.json). */
  fixturePath?: string;
  /**
   * Override the verdict payload. Can be a full object or a mutator applied to
   * the loaded fixture (so tests can inject missing-refs / bare-boolean / withSource).
   */
  verdictOverride?: unknown | ((base: unknown) => unknown);
  /** Pre-stringified verdict JSON — skips fixture load when set (and no override). */
  verdictJson?: string;
  /** Wrap the verdict JSON in markdown fences + prose (for parse-robustness tests). */
  wrapInFences?: boolean;
  /** Optional synthetic thinking text. */
  thinkingText?: string;
  /** If true, throw before returning (provider failure path). */
  throwError?: Error | string;
}

/**
 * Fake judge provider — offline, deterministic, parameterizable for bad verdicts.
 */
export class FakeJudgeProvider implements JudgeProvider {
  private readonly opts: FakeJudgeProviderOptions;

  constructor(opts: FakeJudgeProviderOptions = {}) {
    this.opts = opts;
  }

  async judge(req: JudgeRequest): Promise<JudgeProviderResult> {
    if (this.opts.throwError) {
      throw typeof this.opts.throwError === "string"
        ? new Error(this.opts.throwError)
        : this.opts.throwError;
    }

    let verdictJson: string;
    if (this.opts.verdictJson !== undefined && this.opts.verdictOverride === undefined) {
      verdictJson = this.opts.verdictJson;
    } else {
      const baseText = this.opts.verdictJson
        ? this.opts.verdictJson
        : await readFile(this.opts.fixturePath ?? DEFAULT_VERDICT_FIXTURE, "utf8");
      let payload: unknown = JSON.parse(baseText);
      if (typeof this.opts.verdictOverride === "function") {
        payload = (this.opts.verdictOverride as (b: unknown) => unknown)(payload);
      } else if (this.opts.verdictOverride !== undefined) {
        payload = this.opts.verdictOverride;
      }
      verdictJson = JSON.stringify(payload);
    }

    if (this.opts.wrapInFences) {
      verdictJson =
        "Here is my evaluation.\n\n```json\n" +
        verdictJson +
        "\n```\n\nI am done.";
    }

    const runId = req.judgementId ?? "fake-judge";
    const ts = new Date().toISOString();
    const rawEvents: CanonicalEvent[] = [
      {
        v: SCHEMA_VERSION,
        runId,
        seq: 0,
        ts,
        type: "thinking",
        turn: 1,
        mode: "full",
        text:
          this.opts.thinkingText ??
          "Reviewing the diff and trace against the rubric before scoring.",
      },
      {
        v: SCHEMA_VERSION,
        runId,
        seq: 1,
        ts,
        type: "message",
        turn: 1,
        mode: "full",
        text: "Emitting STEP 1 verdict JSON.",
      },
    ];

    return { verdictJson, rawEvents };
  }
}
