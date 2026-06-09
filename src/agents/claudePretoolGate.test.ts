import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_AGENT_ID_VERIFIED_VERSION } from "#app/agents/claudePretoolGate";

// Tripwire for the subagent gate's load-bearing assumption: claude-code
// populates `agent_id` in the PreToolUse hook payload for subagent tool calls
// (the gate fails OPEN for subagents otherwise). claude-code ships as a native
// binary, so we can't assert the behavior statically — instead we pin the
// verified version and fail CI on any bump, forcing a human to re-verify
// `createBaseHookInput` before updating the pin + the constant together.
describe("subagent gate ↔ claude-code agent_id contract", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  it("pinned @anthropic-ai/claude-code matches the verified version", () => {
    const pinned =
      pkg.devDependencies?.["@anthropic-ai/claude-code"] ??
      pkg.dependencies?.["@anthropic-ai/claude-code"];
    expect(
      pinned,
      "claude-code was bumped: re-verify that subagent tool calls still populate " +
        "`agent_id` in the PreToolUse hook (createBaseHookInput) BEFORE updating " +
        "CLAUDE_CODE_AGENT_ID_VERIFIED_VERSION — the subagent gate fails OPEN otherwise.",
    ).toBe(CLAUDE_CODE_AGENT_ID_VERIFIED_VERSION);
  });
});
