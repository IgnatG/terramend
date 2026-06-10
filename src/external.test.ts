import { describe, expect, it } from "vitest";
import { formatMcpToolRef, terramendMcpName } from "#app/external";

describe("formatMcpToolRef", () => {
  it("formats claude tool refs with the mcp__ prefix", () => {
    expect(formatMcpToolRef("claude", "select_mode")).toBe("mcp__terramend__select_mode");
  });

  it("formats opencode tool refs with the server-name prefix", () => {
    expect(formatMcpToolRef("opencode", "select_mode")).toBe("terramend_select_mode");
  });

  it("uses the shared mcp server name constant", () => {
    expect(formatMcpToolRef("claude", "push_branch")).toBe(`mcp__${terramendMcpName}__push_branch`);
  });
});
