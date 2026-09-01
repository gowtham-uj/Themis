/** Suite verifier crash surfacing (Phase-2 review fix). */
import { describe, expect, it } from "vitest";
import { parseSuiteVerifier } from "../src/runner/package-verifier.js";

describe("parseSuiteVerifier", () => {
  it("surfaces the stderr crash cause when stdout is not valid JSON", () => {
    const r = parseSuiteVerifier(
      Buffer.from("bash: /verifier/test.sh: No such file or directory\n"),
      127,
      Buffer.from("/verifier/test.sh: line 3: python3: command not found\n"),
    );
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]!.status).toBe("error");
    expect(r.checks[0]!.detail).toContain("python3: command not found");
    expect(r.checks[0]!.detail).toContain("exit 127");
  });

  it("parses a well-formed suite result into checks", () => {
    const r = parseSuiteVerifier(
      Buffer.from('{"reward":1,"passed":true,"checks":[{"name":"public_tests","passed":true},{"name":"hidden_contract","passed":true}]}\n'),
      0,
      Buffer.from(""),
    );
    expect(r.checks.map((c) => c.status)).toEqual(["pass", "pass"]);
  });
});
