import { describe, expect, it } from "vitest";
import { modelAliases } from "#app/models";
import { geminiHighThinkingOverrides } from "#app/agents/opencodeShared";

describe("geminiHighThinkingOverrides", () => {
  // Expected truth pulled the same way the helper does — both must derive from
  // the registry so the test exercises the wiring, not a hand-maintained list.
  const expectedApiIds = modelAliases
    .filter((a) => a.provider === "google")
    .map((a) => a.resolve.replace(/^google\//, ""));
  const overrides = geminiHighThinkingOverrides();

  it("covers every direct-Google alias in the registry", () => {
    expect(Object.keys(overrides).sort()).toEqual([...expectedApiIds].sort());
  });

  it("is non-empty (catches accidental whole-provider removal)", () => {
    expect(Object.keys(overrides).length).toBeGreaterThan(0);
  });

  it("strips the `google/` prefix from each resolve to get the bare API id", () => {
    for (const id of Object.keys(overrides)) {
      expect(id).not.toMatch(/^google\//);
    }
  });

  it("pins every entry to thinkingLevel: high", () => {
    for (const [id, value] of Object.entries(overrides)) {
      expect(value, `entry for ${id}`).toEqual({
        options: { thinkingConfig: { thinkingLevel: "high" } },
      });
    }
  });
});
