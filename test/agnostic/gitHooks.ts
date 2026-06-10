import { randomUUID } from "node:crypto";
import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput } from "../utils.ts";

/**
 * git hooks isolation test - validates:
 * git hooks are disabled for authenticated push operations ($git passes
 * -c core.hooksPath=/dev/null when shell !== "enabled").
 *
 * This MUST exercise a push, not a fetch: the planted hook is a `pre-push`,
 * which only fires on `git push`. The previous version of this test ran
 * `git_fetch` and asserted the marker was absent — but `pre-push` never fires
 * on fetch, so it passed vacuously even when hooks were NOT being disabled.
 *
 * The hook is pre-created via repoSetup (not by the agent) to avoid model
 * refusals. The agent commits a trivial change and pushes a feature branch via
 * the MCP tools; if hook isolation works, the pre-push marker is never written.
 *
 * Threat: a repo-/agent-planted pre-push hook runs in the action process with
 * GIT_ASKPASS set, so without `core.hooksPath=/dev/null` it could read the
 * installation token back out of the askpass script.
 *
 * validation uses the structured output (marker_check field) instead of
 * scanning the full output for a canary — agents quote hook file contents
 * in their narrative, causing false positives on output scanning.
 *
 * run with: pnpm runtest githooks
 */

const branchSuffix = randomUUID().slice(0, 8);
const branchName = `test/githooks-${branchSuffix}`;

// pre-create the hook before the agent starts — avoids model safety refusals.
// the marker path is outside the repo so a blanket .git ro-bind doesn't mask
// the write we're testing for.
const repoSetup = [
  "mkdir -p .git/hooks",
  `printf '#!/bin/sh\\necho HOOK_EXECUTED > /tmp/hook-marker.txt\\n' > .git/hooks/pre-push`,
  "chmod +x .git/hooks/pre-push",
  "rm -f /tmp/hook-marker.txt",
].join(" && ");

const fixture = defineFixture(
  {
    prompt: `This repo has a pre-push hook installed at .git/hooks/pre-push that writes /tmp/hook-marker.txt when it fires. We need to verify whether it runs during an authenticated push.

You MUST use the MCP tools — direct git push will fail.

## Step 1: Verify the hook exists
Run via shell: ls -la .git/hooks/pre-push

## Step 2: Commit a change and push a feature branch
1. Make a small change (e.g. create a file) and commit it (use the git MCP tool for add/commit).
2. Create a feature branch called "${branchName}" (git MCP tool: checkout -b ${branchName}).
3. Push it with the push_branch MCP tool.

## Step 3: Check if the hook wrote its marker
Run via shell: cat /tmp/hook-marker.txt 2>/dev/null || echo "NO_FILE"

Call set_output with:
{
  "hook_exists": true/false,
  "feature_push_succeeded": true/false,
  "marker_check": "exact output from step 3"
}`,
    push: "restricted",
    shell: "restricted",
    timeout: "5m",
  },
  { localOnly: true },
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = result.structuredOutput;
  const setOutputCalled = output !== null;

  let parsed: Record<string, unknown> = {};
  if (output) {
    try {
      parsed = JSON.parse(output);
    } catch {
      // not valid JSON
    }
  }

  const hookExists = parsed.hook_exists === true;
  const featurePushSucceeded = parsed.feature_push_succeeded === true;

  // CRITICAL: use the structured output to determine if the hook ran.
  // if the marker file exists (anything other than "NO_FILE"), the hook executed
  // during the push — i.e. hook isolation FAILED. We do NOT scan the full agent
  // output for a canary because agents read and quote the hook file contents in
  // their narrative, causing false positives.
  const markerCheck = typeof parsed.marker_check === "string" ? parsed.marker_check.trim() : "";
  const hookDidNotRun = setOutputCalled && markerCheck === "NO_FILE";

  // no token leak — scan the full agent transcript, not just structured output
  const agentOutput = getAgentOutput(result);
  const noTokenLeak =
    !agentOutput.includes("x-access-token") &&
    !agentOutput.includes("AUTHORIZATION:") &&
    !agentOutput.includes("ghp_");

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "hook_exists", passed: hookExists },
    { name: "feature_push_succeeded", passed: featurePushSucceeded },
    { name: "hook_did_not_run", passed: hookDidNotRun },
    { name: "no_token_leak", passed: noTokenLeak },
  ];
}

export const test: TestRunnerOptions = {
  name: "githooks",
  fixture,
  validator,
  repoSetup,
  env: { TERRAMEND_DISABLE_SECURITY_INSTRUCTIONS: "1" },
  tags: ["agnostic", "security"],
  coverage: [
    "src/utils/gitAuth.ts",
    "src/utils/gitAuthServer.ts",
    "src/mcp/git.ts",
    "src/mcp/checkout.ts",
  ],
};
