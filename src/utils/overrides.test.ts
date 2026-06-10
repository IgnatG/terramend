import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyOverrides, DENIED_OVERRIDE_NAMES, parseOverrides } from "#app/utils/overrides";

vi.mock("@actions/core", () => ({
  setSecret: vi.fn(),
}));

import * as core from "@actions/core";

const setSecretMock = vi.mocked(core.setSecret);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseOverrides", () => {
  it("returns an empty object for empty or whitespace input", () => {
    expect(parseOverrides("")).toEqual({});
    expect(parseOverrides("   \n\t ")).toEqual({});
  });

  it("parses a valid JSON object of string values", () => {
    expect(parseOverrides('{"A":"1","B":""}')).toEqual({ A: "1", B: "" });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseOverrides("{nope")).toThrow(/invalid UNSAFE_OVERRIDES: not valid JSON/);
  });

  it("throws on non-object JSON", () => {
    expect(() => parseOverrides('"string"')).toThrow(/must be a JSON object/);
    expect(() => parseOverrides("null")).toThrow(/must be a JSON object/);
    expect(() => parseOverrides('["a"]')).toThrow(/must be a JSON object/);
  });

  it("throws when a value is not a string", () => {
    expect(() => parseOverrides('{"A":42}')).toThrow(/key "A" must have a string value/);
  });
});

describe("applyOverrides", () => {
  it("applies overrides, masks values, and strips the raw input var", () => {
    const env: NodeJS.ProcessEnv = { UNSAFE_OVERRIDES: '{"MY_KEY":"secret-value"}' };

    const result = applyOverrides({ raw: '{"MY_KEY":"secret-value"}', env });

    expect(result).toEqual({ applied: ["MY_KEY"], denied: [] });
    expect(env.MY_KEY).toBe("secret-value");
    expect(env.UNSAFE_OVERRIDES).toBeUndefined();
    expect(setSecretMock).toHaveBeenCalledWith("secret-value");
  });

  it("refuses denied names while applying the rest", () => {
    const env: NodeJS.ProcessEnv = {};

    const result = applyOverrides({
      raw: '{"GITHUB_TOKEN":"stolen","ANTHROPIC_API_KEY":"sk-test"}',
      env,
    });

    expect(result.denied).toEqual(["GITHUB_TOKEN"]);
    expect(result.applied).toEqual(["ANTHROPIC_API_KEY"]);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("does not register empty values as secrets", () => {
    const env: NodeJS.ProcessEnv = {};

    const result = applyOverrides({ raw: '{"EMPTY":""}', env });

    expect(result.applied).toEqual(["EMPTY"]);
    expect(env.EMPTY).toBe("");
    expect(setSecretMock).not.toHaveBeenCalled();
  });

  it("denies every name on the deny list", () => {
    const raw = JSON.stringify(
      Object.fromEntries(Array.from(DENIED_OVERRIDE_NAMES, (name) => [name, "x"])),
    );
    const env: NodeJS.ProcessEnv = {};

    const result = applyOverrides({ raw, env });

    expect(result.applied).toEqual([]);
    expect(result.denied.sort()).toEqual(Array.from(DENIED_OVERRIDE_NAMES).sort());
    expect(setSecretMock).not.toHaveBeenCalled();
  });
});
