import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput } from "../utils.ts";

/**
 * BYOK-no-keys fallback test — proves that an account configured for a
 * BYOK model (here: `moonshotai/kimi-k2`) but with no provider API
 * keys present in the runner env still gets a successful run by falling
 * back to a free OpenCode model.
 *
 * This was the structural failure that took out 15 accounts post-launch
 * before the fallback shipped: GH Actions secret references resolved to
 * empty strings (because the secrets didn't exist), the action launched
 * Claude Code with no key, the LLM provider 401'd, and the run died in
 * 20s with a synthesized "Invalid API key" message.
 *
 * The env block below empty-strings every known provider key — that's
 * exactly what GitHub Actions does when a `${{ secrets.X }}` reference
 * resolves to a missing secret. We verify:
 *   1. the run succeeded
 *   2. the fallback log line was emitted (proves the swap happened)
 */
const fixture = defineFixture(
  {
    prompt: "Reply with exactly the single character: 4",
    timeout: "5m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getAgentOutput(result);
  const fellBack = /fell back from .* to opencode\/big-pickle/.test(output);
  return [
    { name: "run_succeeded", passed: result.success },
    { name: "fallback_logged", passed: fellBack },
  ];
}

export const test: TestRunnerOptions = {
  name: "byok-no-keys-fallback",
  fixture,
  validator,
  env: {
    // simulate every BYOK provider's secret being absent — same shape as
    // a fresh-install account whose user never configured any keys.
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    OPENAI_API_KEY: "",
    OPENROUTER_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_GENERATIVE_AI_API_KEY: "",
    XAI_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    MOONSHOT_API_KEY: "",
    OPENCODE_API_KEY: "",
    AWS_BEARER_TOKEN_BEDROCK: "",
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    BEDROCK_MODEL_ID: "",
    // configure a model that requires a BYOK key — the fallback only
    // engages when there's a configured model whose provider key is
    // absent, so we have to pin one. any BYOK alias works; we pick
    // a cheap non-Anthropic model so the test doesn't burn opus
    // credits if the fallback ever regresses.
    TERRAMEND_MODEL: "moonshotai/kimi-k2",
  },
  tags: ["agnostic"],
  coverage: [
    "action/utils/byokFallback.ts",
    "action/utils/apiKeys.ts",
    "action/utils/agent.ts",
    "action/utils/openCodeModels.ts",
    "action/main.ts",
    "action/models.ts",
  ],
};
