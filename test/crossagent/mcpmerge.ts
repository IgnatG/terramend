import { randomUUID } from "node:crypto";
import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

/**
 * MCP merge test - validates repo-level MCP servers merge correctly with terramend.
 *
 * Uses GITHUB_REPOSITORY=terramend/test-repo-mcp whose robin-mcp reads a secret
 * from /tmp/terramend-mcp-secret/secret.txt (outside the repo) and exposes it
 * via get_test_value. The runner writes the secret
 * there via repoSetup before the agent starts. Runs with shell disabled.
 */

const secret = randomUUID();

const fixture = defineFixture(
  {
    prompt: `Call the get_test_value tool from the robinMCP server. It returns a JSON object with a "value" field. Extract that inner value string and pass it to set_output.`,
    shell: "disabled",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = result.structuredOutput;
  const setOutputCalled = output !== null;
  const correctValue = setOutputCalled && output === secret;

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "repo_mcp", passed: correctValue },
  ];
}

export const test: TestRunnerOptions = {
  name: "mcpmerge",
  fixture,
  validator,
  env: {
    GITHUB_REPOSITORY: "terramend/test-repo-mcp",
    TERRAMEND_DISABLE_SECURITY_INSTRUCTIONS: "1",
    TERRAMEND_MCP_SECRET: secret,
  },
  repoSetup:
    'mkdir -p /tmp/terramend-mcp-secret && printf "%s" "$TERRAMEND_MCP_SECRET" > /tmp/terramend-mcp-secret/secret.txt',
  // any MCP-layer change can affect repo-MCP merging; agents own MCP wiring.
  coverage: ["src/mcp/**", "src/agents/{claude,opencode}.ts"],
};
