import { BEDROCK_MODEL_ID_ENV, resolveDisplayAlias, VERTEX_MODEL_ID_ENV } from "../models.ts";
import { getApiUrl } from "./apiUrl.ts";
import {
  GOOGLE_CLOUD_PROJECT_ENV,
  readProjectIdFromVertexServiceAccountJson,
  VERTEX_LOCATION_ENV,
  VERTEX_SERVICE_ACCOUNT_JSON_ENV,
} from "./vertex.ts";

/** marker prefix on the throw message for the catch-side reclassification path */
const MISSING_KEY_MARKER = "no API key found";

/** Markdown body used for both the thrown error and the formatted PR comment summary. */
function buildMissingApiKeyError(params: { owner: string; name: string }): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;
  const settingsUrl = `${getApiUrl()}/console/${params.owner}/${params.name}`;

  return [
    `**${MISSING_KEY_MARKER}** — Lintel needs at least one LLM provider API key (e.g. \`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`, \`GEMINI_API_KEY\`) configured as a GitHub Actions secret.`,
    "",
    `[Open repo secrets →](${githubSecretsUrl}) · [Configure model →](${settingsUrl}) · [Setup docs →](https://docs.lintel.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
  ].join("\n");
}

function buildBedrockSetupError(params: {
  owner: string;
  name: string;
  missing: string[];
}): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;

  return `Bedrock model selected but required configuration is missing: ${params.missing.join(", ")}.

add the missing secret(s) to your GitHub repository at ${githubSecretsUrl}, then reference them in your workflow's \`env:\` block:

  AWS_BEARER_TOKEN_BEDROCK: \${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
  AWS_REGION: \${{ secrets.AWS_REGION }}
  ${BEDROCK_MODEL_ID_ENV}: \${{ secrets.${BEDROCK_MODEL_ID_ENV} }}

\`AWS_BEARER_TOKEN_BEDROCK\` may be substituted with \`AWS_ACCESS_KEY_ID\` + \`AWS_SECRET_ACCESS_KEY\` (and optional \`AWS_SESSION_TOKEN\`) if you prefer access keys.

for full setup instructions, see https://docs.lintel.com/bedrock`;
}

function buildVertexSetupError(params: { owner: string; name: string; missing: string[] }): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;

  return `Google Vertex AI model selected but required configuration is missing: ${params.missing.join(", ")}.

add the missing secret(s) to your GitHub repository at ${githubSecretsUrl}, then reference them in your workflow's \`env:\` block:

  ${VERTEX_SERVICE_ACCOUNT_JSON_ENV}: \${{ secrets.${VERTEX_SERVICE_ACCOUNT_JSON_ENV} }}
  ${GOOGLE_CLOUD_PROJECT_ENV}: my-project
  ${VERTEX_LOCATION_ENV}: global
  ${VERTEX_MODEL_ID_ENV}: <vertex-model-id>

for full setup instructions, see https://docs.lintel.com/vertex`;
}

function hasEnvVar(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

function validateBedrockSetup(params: { owner: string; name: string }): void {
  const hasAuth =
    hasEnvVar("AWS_BEARER_TOKEN_BEDROCK") ||
    (hasEnvVar("AWS_ACCESS_KEY_ID") && hasEnvVar("AWS_SECRET_ACCESS_KEY"));

  const missing: string[] = [];
  if (!hasAuth)
    missing.push("AWS_BEARER_TOKEN_BEDROCK (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)");
  if (!hasEnvVar("AWS_REGION")) missing.push("AWS_REGION");
  if (!hasEnvVar(BEDROCK_MODEL_ID_ENV)) missing.push(BEDROCK_MODEL_ID_ENV);

  if (missing.length > 0) {
    throw new Error(buildBedrockSetupError({ owner: params.owner, name: params.name, missing }));
  }
}

function validateVertexSetup(params: { owner: string; name: string }): void {
  const hasAuth = hasEnvVar(VERTEX_SERVICE_ACCOUNT_JSON_ENV);
  const hasProject =
    hasEnvVar(GOOGLE_CLOUD_PROJECT_ENV) ||
    readProjectIdFromVertexServiceAccountJson() !== undefined;

  const missing: string[] = [];
  if (!hasAuth) missing.push(VERTEX_SERVICE_ACCOUNT_JSON_ENV);
  if (!hasProject) missing.push(GOOGLE_CLOUD_PROJECT_ENV);
  if (!hasEnvVar(VERTEX_LOCATION_ENV)) missing.push(VERTEX_LOCATION_ENV);
  if (!hasEnvVar(VERTEX_MODEL_ID_ENV)) missing.push(VERTEX_MODEL_ID_ENV);

  if (missing.length > 0) {
    throw new Error(buildVertexSetupError({ owner: params.owner, name: params.name, missing }));
  }
}

/**
 * Validate that the resolved model can actually be served by the chosen
 * agent. For routing slugs (Bedrock / Vertex) the auth shape is multi-var
 * (auth + region/location + model-id) and `opencode models` doesn't catch
 * gaps in the latter two — keep dedicated setup validators. For the
 * opencode path, the authoritative answer comes from OpenCode's own model
 * introspection (`authorized` set captured in `openCodeModels.ts`). For
 * the claude path, fall back to the static check (`ANTHROPIC_API_KEY` /
 * `CLAUDE_CODE_OAUTH_TOKEN`).
 */
export function validateAgentApiKey(params: {
  agent: { name: string };
  model: string | undefined;
  authorized: Set<string>;
  owner: string;
  name: string;
}): void {
  if (params.model) {
    const alias = resolveDisplayAlias(params.model);
    if (alias?.routing === "bedrock") {
      validateBedrockSetup({ owner: params.owner, name: params.name });
      return;
    }
    if (alias?.routing === "vertex") {
      validateVertexSetup({ owner: params.owner, name: params.name });
      return;
    }

    // raw backend model IDs (post-resolveModel for routing slugs) have no
    // `/`. discriminate by the env-var sentinel, then run the matching
    // setup validator — `opencode models` doesn't help here because the
    // Bedrock/Vertex provider plugins need region/location/model-id wired
    // through env regardless of CLI-side auth.
    if (!params.model.includes("/")) {
      if (process.env[VERTEX_MODEL_ID_ENV]?.trim() === params.model) {
        validateVertexSetup({ owner: params.owner, name: params.name });
        return;
      }
      validateBedrockSetup({ owner: params.owner, name: params.name });
      return;
    }

    if (params.agent.name === "opencode") {
      if (params.authorized.has(params.model)) return;
      throw new Error(buildMissingApiKeyError({ owner: params.owner, name: params.name }));
    }

    // claude: single-provider check on the Anthropic auth shapes.
    if (hasEnvVar("ANTHROPIC_API_KEY") || hasEnvVar("CLAUDE_CODE_OAUTH_TOKEN")) return;
    throw new Error(buildMissingApiKeyError({ owner: params.owner, name: params.name }));
  }

  // no model configured (auto-select path).
  if (params.agent.name === "opencode") {
    if (params.authorized.size > 0) return;
    throw new Error(buildMissingApiKeyError({ owner: params.owner, name: params.name }));
  }
  if (hasEnvVar("ANTHROPIC_API_KEY") || hasEnvVar("CLAUDE_CODE_OAUTH_TOKEN")) return;
  throw new Error(buildMissingApiKeyError({ owner: params.owner, name: params.name }));
}

/**
 * Detect agent-runtime auth failures that should be reformatted as an actionable
 * key-fix CTA before being shown to the user. Covers the shapes we see:
 *   - missing key (validateAgentApiKey throw): contains MISSING_KEY_MARKER
 *   - revoked / invalid key (Claude CLI 401 surfaced via api_error_status):
 *     "Invalid API key · Fix external API key" + similar provider variants
 *   - direct-Anthropic 401 (`Failed to authenticate. API Error: 401 ...
 *     {"type":"error","error":{"type":"authentication_error", ...
 *     "Invalid bearer token"}}`) emitted by the Claude CLI for revoked /
 *     mistyped / rotated `ANTHROPIC_API_KEY`. see #782.
 */
export function isApiKeyAuthError(text: string): boolean {
  if (!text) return false;
  return (
    text.includes(MISSING_KEY_MARKER) ||
    /Invalid API key/i.test(text) ||
    /\bUser not found\b/i.test(text) ||
    /\bInvalid authentication\b/i.test(text) ||
    /authentication_error/i.test(text) ||
    /Invalid bearer token/i.test(text) ||
    /api_error_status\s*=\s*401/i.test(text) ||
    /API Error:\s*401/i.test(text)
  );
}

/**
 * Friendly Markdown summary for both the missing-key and invalid-key cases.
 * Used in the catch / result-failure paths in `main.ts` to overwrite the raw
 * agent error before it's posted to the PR progress comment.
 */
export function formatApiKeyErrorSummary(params: {
  owner: string;
  name: string;
  raw: string;
}): string {
  if (params.raw.includes(MISSING_KEY_MARKER)) {
    return buildMissingApiKeyError({ owner: params.owner, name: params.name });
  }

  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;
  const settingsUrl = `${getApiUrl()}/console/${params.owner}/${params.name}`;

  return [
    `**Your LLM provider API key was rejected (401).** Rotate the key in your provider dashboard, then update the matching GitHub Actions secret.`,
    "",
    `[Update repo secret →](${githubSecretsUrl}) · [Model settings →](${settingsUrl}) · [Setup docs →](https://docs.lintel.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
  ].join("\n");
}
