import { BUILTIN_MODE_NAMES } from "#app/modes";
import {
  Inputs,
  JsonPayload,
  parseAllowReplace,
  parseBaseBranch,
  parseMode,
} from "#app/utils/payload";

describe("Inputs schema", () => {
  it("only prompt is required", () => {
    const result = Inputs.assert({ prompt: "test prompt" });
    expect(result).toEqual({ prompt: "test prompt" });
    expect(() => Inputs.assert({})).toThrow();
  });

  it.each([
    ["push", "enabled"],
    ["push", "disabled"],
    ["push", undefined],
    ["shell", "enabled"],
    ["shell", "restricted"],
    ["shell", "disabled"],
    ["shell", undefined],
    ["timeout", "10m"],
    ["timeout", "1h30m"],
    ["timeout", "30s"],
    ["timeout", undefined],
  ] as const)("should accept %s for %s", (prop, value) => {
    const input = { prompt: "test", [prop]: value };
    expect(() => Inputs.assert(input)).not.toThrow();
  });

  it.each([["push"], ["shell"]] as const)("should reject invalid %s values", (prop) => {
    const input = { prompt: "test", [prop]: "invalid" as any };
    expect(() => Inputs.assert(input)).toThrow();
  });

  it("accepts a free-form mode string (validation happens in parseMode)", () => {
    expect(() => Inputs.assert({ prompt: "test", mode: "Remediate" })).not.toThrow();
    expect(() => Inputs.assert({ prompt: "test", mode: undefined })).not.toThrow();
  });
});

describe("parseMode", () => {
  it("returns undefined for unset/empty input", () => {
    expect(parseMode(undefined)).toBeUndefined();
    expect(parseMode("")).toBeUndefined();
    expect(parseMode("   ")).toBeUndefined();
  });

  it("canonicalizes a case-insensitive match to the built-in name", () => {
    expect(parseMode("remediate")).toBe("Remediate");
    expect(parseMode("  REMEDIATE  ")).toBe("Remediate");
    expect(parseMode("Build")).toBe("Build");
    expect(parseMode("generateterraform")).toBe("GenerateTerraform");
  });

  it("exposes the GenerateTerraform mode as a pinnable built-in", () => {
    expect(BUILTIN_MODE_NAMES).toContain("GenerateTerraform");
  });

  it("every built-in mode name round-trips through itself", () => {
    for (const name of BUILTIN_MODE_NAMES) {
      expect(parseMode(name)).toBe(name);
      expect(parseMode(name.toLowerCase())).toBe(name);
    }
  });

  it("falls back to undefined (agent auto-selects) for an unknown mode", () => {
    expect(parseMode("definitely-not-a-mode")).toBeUndefined();
  });
});

describe("parseBaseBranch", () => {
  it("returns undefined for unset/empty input", () => {
    expect(parseBaseBranch(undefined)).toBeUndefined();
    expect(parseBaseBranch("")).toBeUndefined();
    expect(parseBaseBranch("   ")).toBeUndefined();
  });

  it("trims and returns a plain branch name", () => {
    expect(parseBaseBranch("main")).toBe("main");
    expect(parseBaseBranch("  release/1.2  ")).toBe("release/1.2");
  });

  it("strips a leading refs/heads/", () => {
    expect(parseBaseBranch("refs/heads/main")).toBe("main");
    expect(parseBaseBranch("refs/heads/release/1.2")).toBe("release/1.2");
  });
});

describe("parseAllowReplace", () => {
  it("returns undefined for unset/empty input", () => {
    expect(parseAllowReplace(undefined)).toBeUndefined();
    expect(parseAllowReplace("")).toBeUndefined();
    expect(parseAllowReplace("  ,  ")).toBeUndefined();
  });

  it("splits, trims, and drops empties", () => {
    expect(parseAllowReplace("aws_db_instance.main, aws_s3_bucket.*")).toEqual([
      "aws_db_instance.main",
      "aws_s3_bucket.*",
    ]);
    expect(parseAllowReplace("*")).toEqual(["*"]);
  });
});

describe("JsonPayload schema", () => {
  it("requires ~terramend and version and prompt", () => {
    const result = JsonPayload.assert({
      "~terramend": true,
      version: "1.2.3",
      prompt: "test prompt",
    });
    expect(result).toMatchObject({ "~terramend": true, version: "1.2.3", prompt: "test prompt" });
    expect(() => JsonPayload.assert({})).toThrow();
    expect(() => JsonPayload.assert({ "~terramend": true })).toThrow();
    expect(() => JsonPayload.assert({ version: "1.2.3" })).toThrow();
  });

  it.each([
    ["timeout", "10m"],
    ["timeout", "1h30m"],
    ["timeout", "30s"],
    ["model", "anthropic/claude-opus"],
    ["event", { trigger: "unknown" }],
  ] as const)("should accept optional %s with value %s", (prop, value) => {
    const input = { "~terramend": true, version: "1.2.3", prompt: "test prompt", [prop]: value };
    expect(() => JsonPayload.assert(input)).not.toThrow();
  });
});
