import { describe, expect, it } from "vitest";
import { SetOutputTool } from "#app/mcp/output";
import type { ToolContext } from "#app/mcp/server";
import { initToolState, type ToolState } from "#app/toolState";

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

function makeCtx(): { ctx: ToolContext; toolState: ToolState } {
  const toolState = initToolState({ progressComment: undefined });
  const ctx = { toolState } as unknown as ToolContext;
  return { ctx, toolState };
}

type StandardValidate = {
  "~standard": {
    vendor: string;
    jsonSchema: { input: () => Record<string, unknown>; output: () => Record<string, unknown> };
    validate: (input: unknown) => {
      value?: unknown;
      issues?: { message: string; path: string[] }[];
    };
  };
};

const objectSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { foo: { type: "string" } },
  required: ["foo"],
  additionalProperties: false,
};

describe("SetOutputTool (string output)", () => {
  it("stores the raw value on tool state", async () => {
    const { ctx, toolState } = makeCtx();
    const result = await runTool(SetOutputTool(ctx), { value: "hello world" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("success: true");
    expect(toolState.output).toBe("hello world");
  });
});

describe("SetOutputTool (structured output schema)", () => {
  it("stores the params serialized as JSON", async () => {
    const { ctx, toolState } = makeCtx();
    const result = await runTool(SetOutputTool(ctx, objectSchema), { foo: "bar" });

    expect(result.isError).toBeUndefined();
    expect(toolState.output).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("exposes the JSON schema (minus $schema) through the standard-schema surface", () => {
    const { ctx } = makeCtx();
    const tool = SetOutputTool(ctx, objectSchema);
    const std = (tool.parameters as unknown as StandardValidate)["~standard"];

    expect(std.vendor).toBe("json-schema");
    expect(std.jsonSchema.input()).not.toHaveProperty("$schema");
    expect(std.jsonSchema.output()).toMatchObject({ type: "object" });
  });

  it("validates conforming input", () => {
    const { ctx } = makeCtx();
    const tool = SetOutputTool(ctx, objectSchema);
    const std = (tool.parameters as unknown as StandardValidate)["~standard"];

    expect(std.validate({ foo: "ok" })).toEqual({ value: { foo: "ok" } });
  });

  it("reports root-level validation failures with a '/' path", () => {
    const { ctx } = makeCtx();
    const tool = SetOutputTool(ctx, objectSchema);
    const std = (tool.parameters as unknown as StandardValidate)["~standard"];

    const result = std.validate(42);
    expect(result.value).toBeUndefined();
    expect(result.issues?.[0]?.message).toMatch(/^\/: must be object/);
    expect(result.issues?.[0]?.path).toEqual([]);
  });

  it("reports nested validation failures with the instance path", () => {
    const { ctx } = makeCtx();
    const tool = SetOutputTool(ctx, objectSchema);
    const std = (tool.parameters as unknown as StandardValidate)["~standard"];

    const result = std.validate({ foo: 42 });
    expect(result.issues?.[0]?.message).toMatch(/\/foo: must be string/);
    expect(result.issues?.[0]?.path).toEqual(["foo"]);
  });
});
