import { describe, expect, it } from "vitest";
import {
  BUILTIN_MODE_NAMES,
  computeModes,
  modes,
  NON_COMMITTING_MODES,
  PR_SUMMARY_FORMAT,
  REMEDIATION_PR_FORMAT,
} from "#app/modes";

const EXPECTED_MODE_NAMES = [
  "Build",
  "AddressReviews",
  "Review",
  "IncrementalReview",
  "Plan",
  "Fix",
  "ResolveConflicts",
  "Remediate",
  "GenerateTerraform",
  "Task",
];

describe("computeModes", () => {
  it("returns the same mode set for both agents", () => {
    expect(computeModes("claude").map((m) => m.name)).toEqual(EXPECTED_MODE_NAMES);
    expect(computeModes("opencode").map((m) => m.name)).toEqual(EXPECTED_MODE_NAMES);
  });

  it("gives every built-in mode a description and a prompt", () => {
    for (const mode of computeModes("opencode")) {
      expect(mode.description.length).toBeGreaterThan(0);
      expect(typeof mode.prompt).toBe("string");
      expect(mode.prompt?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("formats MCP tool refs per agent", () => {
    const claudeBuild = computeModes("claude").find((m) => m.name === "Build");
    const opencodeBuild = computeModes("opencode").find((m) => m.name === "Build");
    expect(claudeBuild?.prompt).toContain("mcp__terramend__checkout_pr");
    expect(claudeBuild?.prompt).not.toContain("terramend_checkout_pr");
    expect(opencodeBuild?.prompt).toContain("terramend_checkout_pr");
    expect(opencodeBuild?.prompt).not.toContain("mcp__terramend__checkout_pr");
  });

  it("embeds the review summary format into both review modes", () => {
    const byName = new Map(computeModes("opencode").map((m) => [m.name, m]));
    expect(byName.get("Review")?.prompt).toContain(PR_SUMMARY_FORMAT);
    expect(byName.get("IncrementalReview")?.prompt).toContain(PR_SUMMARY_FORMAT);
  });

  it("embeds the remediation PR format into Remediate and GenerateTerraform", () => {
    const byName = new Map(computeModes("opencode").map((m) => [m.name, m]));
    expect(byName.get("Remediate")?.prompt).toContain(REMEDIATION_PR_FORMAT);
    expect(byName.get("GenerateTerraform")?.prompt).toContain(REMEDIATION_PR_FORMAT);
  });
});

describe("static mode exports", () => {
  it("modes is the opencode-rendered list", () => {
    expect(modes.map((m) => m.name)).toEqual(EXPECTED_MODE_NAMES);
    const task = modes.find((m) => m.name === "Task");
    expect(task?.prompt).toContain("terramend_report_progress");
  });

  it("BUILTIN_MODE_NAMES mirrors the mode list and has no duplicates", () => {
    expect(BUILTIN_MODE_NAMES).toEqual(EXPECTED_MODE_NAMES);
    expect(new Set(BUILTIN_MODE_NAMES).size).toBe(BUILTIN_MODE_NAMES.length);
  });

  it("NON_COMMITTING_MODES only names real built-in modes", () => {
    expect([...NON_COMMITTING_MODES].sort()).toEqual(["IncrementalReview", "Plan", "Review"]);
    for (const mode of NON_COMMITTING_MODES) {
      expect(BUILTIN_MODE_NAMES).toContain(mode);
    }
    // Build/Remediate-style modes commit; they must never be suppressed.
    expect(NON_COMMITTING_MODES.has("Build")).toBe(false);
    expect(NON_COMMITTING_MODES.has("Remediate")).toBe(false);
  });
});
