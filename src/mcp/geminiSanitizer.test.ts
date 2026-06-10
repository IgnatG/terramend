import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Tool } from "fastmcp";
import { describe, expect, it } from "vitest";
import {
  isGeminiRouted,
  sanitizeForGemini,
  sanitizeToolForGemini,
  wrapSchemaForGemini,
} from "#app/mcp/geminiSanitizer";
import type { ToolContext } from "#app/mcp/server";

describe("sanitizeForGemini", () => {
  it("passes through primitives and null untouched", () => {
    expect(sanitizeForGemini(null)).toBeNull();
    expect(sanitizeForGemini(undefined)).toBeUndefined();
    expect(sanitizeForGemini("string")).toBe("string");
    expect(sanitizeForGemini(42)).toBe(42);
    expect(sanitizeForGemini(true)).toBe(true);
  });

  it("maps arrays element-wise", () => {
    expect(sanitizeForGemini([{ $schema: "x", type: "object" }, 1])).toEqual([
      { type: "object" },
      1,
    ]);
  });

  it("adds type: string to an enum-only string union (case 1)", () => {
    expect(sanitizeForGemini({ enum: ["A", "B"] })).toEqual({
      type: "string",
      enum: ["A", "B"],
    });
  });

  it("keeps the description when typing an enum-only schema", () => {
    expect(sanitizeForGemini({ enum: ["A"], description: "pick one" })).toEqual({
      type: "string",
      enum: ["A"],
      description: "pick one",
    });
  });

  it("leaves a mixed-type enum to the generic pass (no fabricated type)", () => {
    expect(sanitizeForGemini({ enum: ["A", 1] })).toEqual({ enum: ["A", 1] });
  });

  it("does not re-type an enum that already declares a string type", () => {
    expect(sanitizeForGemini({ type: "string", enum: ["A"], extra: 1 })).toEqual({
      type: "string",
      enum: ["A"],
      extra: 1,
    });
  });

  it("collapses an anyOf of string enums into a typed enum (case 2)", () => {
    expect(
      sanitizeForGemini({
        anyOf: [{ enum: ["a"] }, { enum: ["b", "c"] }],
        description: "choice",
      }),
    ).toEqual({ type: "string", enum: ["a", "b", "c"], description: "choice" });
  });

  it("collapses const branches and dedupes repeated values", () => {
    expect(sanitizeForGemini({ oneOf: [{ const: "x" }, { const: "y" }, { enum: ["x"] }] })).toEqual(
      { type: "string", enum: ["x", "y"] },
    );
  });

  it("strips sibling fields from a non-collapsible anyOf (case 3)", () => {
    const result = sanitizeForGemini({
      anyOf: [{ type: "string" }, { type: "number" }],
      type: "string",
      description: "dropped per gemini rule",
    });
    expect(result).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  it("handles a oneOf-only non-collapsible union (no anyOf key fabricated)", () => {
    expect(
      sanitizeForGemini({ oneOf: [{ type: "number" }, { type: "boolean" }], description: "d" }),
    ).toEqual({ oneOf: [{ type: "number" }, { type: "boolean" }] });
  });

  it("keeps both anyOf and oneOf when neither collapses, recursing into branches", () => {
    const result = sanitizeForGemini({
      anyOf: [{ $schema: "x", type: "string" }],
      oneOf: [{ type: "number" }, { type: "boolean" }],
    });
    expect(result).toEqual({
      anyOf: [{ type: "string" }],
      oneOf: [{ type: "number" }, { type: "boolean" }],
    });
  });

  it("treats a branch with an empty or non-string enum as non-collapsible", () => {
    // the union is NOT collapsed (case 2 fails); branches are still sanitized
    // individually, so the all-strings empty enum gains a string type (case 1).
    expect(sanitizeForGemini({ anyOf: [{ enum: [] }, { enum: ["a"] }] })).toEqual({
      anyOf: [
        { type: "string", enum: [] },
        { type: "string", enum: ["a"] },
      ],
    });
    expect(sanitizeForGemini({ anyOf: [{ enum: [1, 2] }, "not-an-object"] })).toEqual({
      anyOf: [{ enum: [1, 2] }, "not-an-object"],
    });
  });

  it("drops $schema and renames $defs to definitions (case 4)", () => {
    expect(
      sanitizeForGemini({
        $schema: "http://json-schema.org/draft-07/schema#",
        $defs: { inner: { enum: ["a"] } },
        type: "object",
        properties: { mode: { enum: ["Build", "Review"] } },
      }),
    ).toEqual({
      definitions: { inner: { type: "string", enum: ["a"] } },
      type: "object",
      properties: { mode: { type: "string", enum: ["Build", "Review"] } },
    });
  });
});

// structural view of the proxied schema, so tests can reach into the wrapped
// `~standard`/`toJsonSchema` chain without scattering `any` casts.
type SchemaView = {
  "~standard": {
    vendor: string;
    validate: unknown;
    jsonSchema: {
      input: (args?: unknown) => unknown;
      output: () => unknown;
      version: string;
    };
  };
  toJsonSchema: (() => unknown) | string;
  infer: unknown;
};

function view(schema: StandardSchemaV1<unknown>): SchemaView {
  return schema as unknown as SchemaView;
}

describe("wrapSchemaForGemini", () => {
  function makeSchema(overrides?: Record<string, unknown>): StandardSchemaV1<unknown> {
    return {
      "~standard": {
        version: 1,
        vendor: "arktype",
        validate: () => ({ value: undefined }),
        jsonSchema: {
          input: () => ({ $schema: "x", enum: ["a", "b"] }),
          output: () => ({ $defs: { d: {} }, type: "object" }),
          version: "v1",
        },
      },
      ...overrides,
    } as unknown as StandardSchemaV1<unknown>;
  }

  it("sanitizes through the ~standard.jsonSchema.input path (xsschema path A)", () => {
    const wrapped = view(wrapSchemaForGemini(makeSchema()));
    const produced = wrapped["~standard"].jsonSchema.input({ target: "draft-07" });
    expect(produced).toEqual({ type: "string", enum: ["a", "b"] });
  });

  it("sanitizes the jsonSchema.output producer too", () => {
    const wrapped = view(wrapSchemaForGemini(makeSchema()));
    expect(wrapped["~standard"].jsonSchema.output()).toEqual({
      definitions: { d: {} },
      type: "object",
    });
  });

  it("passes non-function jsonSchema members through unchanged", () => {
    const wrapped = view(wrapSchemaForGemini(makeSchema()));
    expect(wrapped["~standard"].jsonSchema.version).toBe("v1");
  });

  it("passes other ~standard members (vendor, validate) through unchanged", () => {
    const wrapped = view(wrapSchemaForGemini(makeSchema()));
    expect(wrapped["~standard"].vendor).toBe("arktype");
    expect(typeof wrapped["~standard"].validate).toBe("function");
  });

  it("sanitizes through the toJsonSchema path (xsschema path B)", () => {
    const schema = makeSchema({
      toJsonSchema: () => ({ $schema: "x", type: "object" }),
    });
    const wrapped = view(wrapSchemaForGemini(schema));
    expect(typeof wrapped.toJsonSchema).toBe("function");
    if (typeof wrapped.toJsonSchema === "function") {
      expect(wrapped.toJsonSchema()).toEqual({ type: "object" });
    }
  });

  it("returns a non-function toJsonSchema property as-is", () => {
    const schema = makeSchema({ toJsonSchema: "not callable" });
    const wrapped = view(wrapSchemaForGemini(schema));
    expect(wrapped.toJsonSchema).toBe("not callable");
  });

  it("returns a non-object ~standard value as-is", () => {
    const schema = { "~standard": null } as unknown as StandardSchemaV1<unknown>;
    const wrapped = view(wrapSchemaForGemini(schema));
    expect(wrapped["~standard"]).toBeNull();
  });

  it("returns a non-object jsonSchema value as-is", () => {
    const schema = {
      "~standard": { version: 1, vendor: "arktype", jsonSchema: "nope" },
    } as unknown as StandardSchemaV1<unknown>;
    const wrapped = view(wrapSchemaForGemini(schema));
    expect(wrapped["~standard"].jsonSchema).toBe("nope");
  });

  it("passes unrelated schema properties through the outer proxy", () => {
    const schema = makeSchema({ infer: "marker" });
    const wrapped = view(wrapSchemaForGemini(schema));
    expect(wrapped.infer).toBe("marker");
  });
});

describe("sanitizeToolForGemini", () => {
  type AnyTool = Tool<Record<string, never>, StandardSchemaV1<unknown>>;

  it("returns the tool unchanged when it has no parameters", () => {
    const bare = { name: "t", execute: async () => "ok" } as unknown as AnyTool;
    expect(sanitizeToolForGemini(bare)).toBe(bare);
  });

  it("wraps the parameters schema and preserves the other fields", () => {
    const params = {
      "~standard": {
        version: 1,
        vendor: "arktype",
        jsonSchema: { input: () => ({ enum: ["x"] }) },
      },
    } as unknown as StandardSchemaV1<unknown>;
    const original = {
      name: "t",
      description: "d",
      parameters: params,
      execute: async () => "ok",
    } as unknown as AnyTool;
    const wrapped = sanitizeToolForGemini(original);
    expect(wrapped).not.toBe(original);
    expect(wrapped.name).toBe("t");
    const wrappedParams = wrapped.parameters as StandardSchemaV1<unknown> | undefined;
    expect(wrappedParams).toBeDefined();
    if (wrappedParams) {
      expect(view(wrappedParams)["~standard"].jsonSchema.input()).toEqual({
        type: "string",
        enum: ["x"],
      });
    }
  });
});

describe("isGeminiRouted", () => {
  const ctx = (resolvedModel: string | undefined, payloadModel?: string): ToolContext =>
    ({ resolvedModel, payload: { model: payloadModel } }) as unknown as ToolContext;

  it("matches any slug containing 'gemini' regardless of provider prefix", () => {
    expect(isGeminiRouted(ctx("google/gemini-3.1-pro-preview"))).toBe(true);
    expect(isGeminiRouted(ctx("opencode/Gemini-2.5-flash"))).toBe(true);
    expect(isGeminiRouted(ctx("openrouter/google/gemini-2.5-pro"))).toBe(true);
  });

  it("treats an unresolved specifier (undefined / auto / bare slug) as gemini-possible", () => {
    expect(isGeminiRouted(ctx(undefined))).toBe(true);
    expect(isGeminiRouted(ctx("auto"))).toBe(true);
    expect(isGeminiRouted(ctx("some-unknown-slug"))).toBe(true);
  });

  it("falls back to the payload model when no resolved model exists", () => {
    expect(isGeminiRouted(ctx(undefined, "google/gemini-2.5-pro"))).toBe(true);
    expect(isGeminiRouted(ctx(undefined, "anthropic/claude-opus-4-7"))).toBe(false);
  });

  it("returns false for a concrete non-gemini provider/model", () => {
    expect(isGeminiRouted(ctx("anthropic/claude-opus-4-7"))).toBe(false);
    expect(isGeminiRouted(ctx("openai/gpt-5.2"))).toBe(false);
  });
});
