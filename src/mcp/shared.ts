import type { StandardSchemaV1 } from "@standard-schema/spec";
import { encode as toonEncode } from "@toon-format/toon";
import type { FastMCP, Tool } from "fastmcp";
import { isGeminiRouted, sanitizeToolForGemini } from "#app/mcp/geminiSanitizer";
import type { ToolContext } from "#app/mcp/server";
import { formatJsonValue, log } from "#app/utils/cli";

export const tool = <const params>(
  toolDef: Tool<any, StandardSchemaV1<params>>,
): Tool<any, StandardSchemaV1<params>> => toolDef;

export interface ToolResult {
  content: {
    type: "text";
    text: string;
  }[];
  isError?: boolean;
}

/**
 * Structured tool-outcome envelope (§3.5 "Structured tool errors"). Every tool
 * that can be unavailable, skipped, or degrade green returns the SAME shape so a
 * caller (the agent, or a downstream parser) can branch deterministically:
 *   - success: `{ ok: true, … }`
 *   - skip / unavailable / soft failure: `{ ok: false, code, detail }`
 * where `code` is a stable machine token (snake_case) and `detail` a human
 * sentence. The newer tools (terraform_roots / terraform_module_interface /
 * terraform_provider_schema / policy_check) emit this natively; the older
 * degrade-green tools historically returned `{ ran|found: false,
 * skipped_reason|reason }`. Those keep their legacy aliases ALONGSIDE the new
 * fields (the call site spreads `toolSkip(...)` into its existing object) so
 * prompt + test contracts keep working while the surface converges — additive,
 * never breaking.
 */
export type ToolOk<T extends Record<string, any>> = T & { ok: true };

/** wrap a success payload with `ok: true`. */
export const toolOk = <T extends Record<string, any>>(data: T): ToolOk<T> => ({
  ok: true,
  ...data,
});

/** the structured skip/unavailable envelope: `{ ok: false, code, detail }`. */
export const toolSkip = (
  code: string,
  detail: string,
): { ok: false; code: string; detail: string } => ({ ok: false, code, detail });

export const handleToolSuccess = (data: Record<string, any> | string): ToolResult => {
  const text = typeof data === "string" ? data : toonEncode(data);
  return {
    content: [{ type: "text", text }],
  };
};

export const handleToolError = (error: unknown): ToolResult => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: `Error: ${errorMessage}`,
      },
    ],
    isError: true,
  };
};

/**
 * Helper to wrap a tool execute function with error handling.
 * Captures ctx in closure so tools don't need to handle try/catch.
 * @param fn - the function to execute
 * @param toolName - optional tool name for error logging
 */
export const execute = <T, R extends Record<string, any> | string>(
  fn: (params: T) => Promise<R>,
  toolName?: string,
) => {
  const _fn = async (params: T): Promise<ToolResult> => {
    try {
      const result = await fn(params);
      return handleToolSuccess(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const prefix = toolName ? `[${toolName}]` : "tool";
      log.info(`${prefix} error: ${errorMessage}`);
      log.debug(`${prefix} params: ${formatJsonValue(params)}`);
      return handleToolError(error);
    }
  };
  return _fn;
};

export const addTools = (ctx: ToolContext, server: FastMCP<any>, tools: Tool<any, any>[]) => {
  const shouldSanitize = isGeminiRouted(ctx);
  for (const tool of tools) {
    server.addTool(shouldSanitize ? sanitizeToolForGemini(tool) : tool);
  }
  return server;
};
