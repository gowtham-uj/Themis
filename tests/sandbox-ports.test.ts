/** Sandbox port parsing. */

import { describe, expect, it } from "vitest";
import { parsePorts, resolveAdapterOverrides } from "../src/runner/project-config.ts";

describe("parsePorts", () => {
  it("accepts bare ports and camel/snake-case objects", () => {
    expect(parsePorts([3000])).toEqual([{ containerPort: 3000 }]);
    expect(
      parsePorts([
        { containerPort: 3000, hostPort: 13000, name: "web" },
        { container_port: 9222, host_port: 19222, protocol: "tcp", name: "cdp" },
      ]),
    ).toEqual([
      { containerPort: 3000, hostPort: 13000, name: "web" },
      { containerPort: 9222, hostPort: 19222, protocol: "tcp", name: "cdp" },
    ]);
  });

  it("drops malformed entries and invalid protocols", () => {
    expect(
      parsePorts([
        { containerPort: 0 },
        { containerPort: 70000 },
        { containerPort: "web" },
        { containerPort: 5173 },
        { containerPort: 3000, protocol: "sctp" },
      ]),
    ).toEqual([{ containerPort: 5173 }, { containerPort: 3000 }]);
  });

  it("reaches adapter overrides", () => {
    const out = resolveAdapterOverrides({
      adapterOverrides: { ports: [{ containerPort: 9222, name: "cdp" }] },
    });
    expect(out?.ports).toEqual([{ containerPort: 9222, name: "cdp" }]);
  });
});
