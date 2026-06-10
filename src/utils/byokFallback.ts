import type { AgentId } from "#app/external";
import { getModelEnvVars, getProviderDisplayName } from "#app/models";

/**
 * Slug we fall back to when a BYOK-required model is configured but the
 * runner has no provider key in env. Picked because it's free, stable, and
 * currently served by OpenCode Zen without a key.
 *
 * The slug is intentionally hard-coded and not a config knob — the
 * fallback is a safety net, not a user-facing preference, and adding a
 * config surface here would just push the same "what to fall back to"
 * decision into another setting that goes stale the same way.
 */
export const FREE_FALLBACK_SLUG = "opencode/big-pickle";

/**
 * Outcome of the BYOK model gate.
 *
 *   - `use-resolved`: run the configured model as-is.
 *   - `fallback`: the runner has NO provider key for this model's provider,
 *     so swap to the free OpenCode slug — a genuine no-key safety net.
 *   - `unavailable`: a provider key IS present but the configured model is
 *     not one OpenCode can route with it. This is almost always a wrong or
 *     mistyped model id (or a key scoped to other models). We must NOT
 *     silently downgrade to the free model — that hides the misconfiguration
 *     and produces a free run the user didn't ask for (see PR #2). The caller
 *     fails loudly with the authorized-model list instead.
 */
export type FallbackDecision =
  | { kind: "use-resolved" }
  | { kind: "fallback"; from: string; to: string }
  | { kind: "unavailable"; model: string };

function hasEnvVar(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

/**
 * Does the runner have a provider credential for `resolvedModel`'s provider?
 *
 * Uses the provider→envVars map in `models.ts` (provider-level, since a
 * resolved specifier like `google/gemini-3.5-flash-lite` won't match a catalog
 * model key and correctly falls through to the provider's env vars). A present
 * key is what distinguishes the two not-authorized situations: key present =
 * wrong/unavailable model id (fail loudly); no key = genuine BYOK gap (free
 * fallback).
 */
export function hasProviderKeyForModel(resolvedModel: string): boolean {
  return getModelEnvVars(resolvedModel).some(hasEnvVar);
}

/**
 * Decide whether to run the configured model, fall back to the free model, or
 * fail because the model is unavailable to the present key.
 *
 * `authorized` is OpenCode's authoritative "what can I route right now"
 * snapshot, captured after Codex auth.json is in place.
 *
 * Skip cases (always `use-resolved`, without consulting `authorized`):
 *   - No resolved model: auto-select handles it downstream.
 *   - Resolved model is the free fallback already.
 *   - Resolved model is a raw Bedrock / Vertex ID (no `/`): the routing
 *     validators (`validateBedrockSetup` / `validateVertexSetup`) cover
 *     auth + region/location/model-id; `opencode models` does not.
 *   - The selected agent is `claude`: the Claude Code harness brings its own
 *     auth and `resolveAgent` only returns it when that auth is present.
 *     `opencode models` can't see `CLAUDE_CODE_OAUTH_TOKEN`, so without this
 *     an OAuth-subscription run on an Anthropic model would land in
 *     `unavailable` (the token counts as a present provider key) and fail a
 *     run the claude harness serves fine. `validateAgentApiKey` still covers
 *     the claude path with its own Anthropic auth check.
 */
export function selectFallbackModelIfNeeded(input: {
  resolvedModel: string | undefined;
  authorized: Set<string>;
  /** whether a provider key for the resolved model's provider is present in env */
  providerKeyPresent: boolean;
  /** which agent harness `resolveAgent` picks for the resolved model */
  agentName: AgentId;
}): FallbackDecision {
  if (!input.resolvedModel) return { kind: "use-resolved" };
  if (input.resolvedModel === FREE_FALLBACK_SLUG) return { kind: "use-resolved" };
  if (!input.resolvedModel.includes("/")) return { kind: "use-resolved" };
  if (input.agentName === "claude") return { kind: "use-resolved" };
  if (input.authorized.has(input.resolvedModel)) return { kind: "use-resolved" };

  // resolved model is NOT in OpenCode's authorized set. split the two cases:
  if (input.providerKeyPresent) {
    // a key for this provider is configured — the model id is wrong or not
    // available to this key. surface it; do not silently serve a free model.
    return { kind: "unavailable", model: input.resolvedModel };
  }
  // no key at all → genuine BYOK gap → free safety net so the run still works.
  return { kind: "fallback", from: input.resolvedModel, to: FREE_FALLBACK_SLUG };
}

/**
 * Loud, actionable error for the `unavailable` decision: a provider key is
 * present but the configured model isn't one the key can serve. Lists the
 * models OpenCode CAN route (same-provider first) so the user can copy a valid
 * slug instead of getting a silent free downgrade.
 */
export function buildUnavailableModelError(input: {
  model: string;
  authorized: Set<string>;
}): string {
  const provider = input.model.slice(0, input.model.indexOf("/"));
  const providerLabel = getProviderDisplayName(input.model) ?? provider;
  const all = [...input.authorized].sort();
  const sameProvider = all.filter((m) => m.startsWith(`${provider}/`));
  const shown = sameProvider.length > 0 ? sameProvider : all;
  const list =
    shown.length > 0
      ? shown.map((m) => `  - ${m}`).join("\n")
      : "  (none — your key does not authorize any model OpenCode can route)";

  return [
    `model "${input.model}" is not available to your ${providerLabel} key.`,
    ``,
    `A provider credential is present, so Terramend did not fall back to the free model —`,
    `it surfaces this instead so you can pick a valid id. Models your key can serve:`,
    ``,
    list,
    ``,
    `Set the model (the \`model\` input, or \`TERRAMEND_MODEL\`) to one of the slugs above.`,
  ].join("\n");
}
