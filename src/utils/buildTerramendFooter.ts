import { getModelProvider, modelAliases, providers, resolveDisplayAlias } from "#app/models";

export const TERRAMEND_DIVIDER = "<!-- TERRAMEND_DIVIDER_DO_NOT_REMOVE_PLZ -->";

export interface WorkflowRunFooterInfo {
  owner: string;
  repo: string;
  runId: number;
  /** optional job ID - if provided, will append /job/{jobId} to the workflow run URL */
  jobId?: string | undefined;
}

export interface BuildTerramendFooterParams {
  /** add "via Terramend" link */
  triggeredBy?: boolean;
  /** add "View workflow run" link */
  workflowRun?: WorkflowRunFooterInfo | undefined;
  /** alternative: just pass a pre-built URL directly (for shortlinks etc.) */
  workflowRunUrl?: string | undefined;
  /** arbitrary custom parts (e.g., action links) */
  customParts?: string[] | undefined;
  /** model slug from payload (e.g., "anthropic/claude-opus"). shown in footer as "Using `Model Name`" */
  model?: string | undefined;
  /**
   * When the action engaged the BYOK fallback, this is the slug the user
   * had configured (e.g. "anthropic/claude-opus") — the footer renders
   * `Using <free model> (credentials for <configured> not configured)`
   * so the substitution is visible in PR comments + reviews.
   */
  fallbackFrom?: string | undefined;
}

/** Provider display name (e.g. "Anthropic") for the slug, or the raw provider segment as a fallback. */
function providerDisplayName(slug: string): string {
  try {
    const key = getModelProvider(slug);
    const meta = providers[key as keyof typeof providers];
    return meta?.displayName ?? key;
  } catch {
    // raw IDs without a `/` (Bedrock model IDs) — never reach this function
    // in practice because the BYOK fallback skips Bedrock, but defensively
    // return the slug itself rather than throw if it ever does.
    return slug;
  }
}

function formatModelLabel(params: { model: string; fallbackFrom?: string | undefined }): string {
  const alias =
    resolveDisplayAlias(params.model) ??
    // reverse-lookup: when the caller passes an effective model (proxy or
    // resolved target like "openrouter/anthropic/claude-opus-4.7") instead of
    // a stored alias slug, find the alias whose resolve target matches so we
    // still render a friendly display name.
    modelAliases.find((a) => a.resolve === params.model || a.openRouterResolve === params.model);
  const displayName = alias?.displayName ?? params.model;
  const base = alias?.isFree ? `\`${displayName}\` (free)` : `\`${displayName}\``;
  if (!params.fallbackFrom) return base;
  return `${base} (credentials for ${providerDisplayName(params.fallbackFrom)} not configured)`;
}

/**
 * build a terramend footer with configurable parts
 * order: action links (customParts) > workflow run > model > attribution
 */
export function buildTerramendFooter(params: BuildTerramendFooterParams): string {
  const parts: string[] = [];

  if (params.customParts) {
    parts.push(...params.customParts);
  }

  if (params.workflowRunUrl) {
    parts.push(`[View workflow run](${params.workflowRunUrl})`);
  } else if (params.workflowRun) {
    const baseUrl = `https://github.com/${params.workflowRun.owner}/${params.workflowRun.repo}/actions/runs/${params.workflowRun.runId}`;
    const url = params.workflowRun.jobId ? `${baseUrl}/job/${params.workflowRun.jobId}` : baseUrl;
    parts.push(`[View workflow run](${url})`);
  }

  if (params.triggeredBy) {
    parts.push("via Terramend");
  }

  if (params.model) {
    parts.push(
      `Using ${formatModelLabel({ model: params.model, fallbackFrom: params.fallbackFrom })}`
    );
  }

  return `\n\n${TERRAMEND_DIVIDER}\n<sup>${parts.join(" ｜ ")}</sup>`;
}

/**
 * strip any existing terramend footer from a comment body
 */
export function stripExistingFooter(body: string): string {
  const dividerIndex = body.indexOf(TERRAMEND_DIVIDER);
  if (dividerIndex === -1) {
    return body;
  }
  return body.substring(0, dividerIndex).trimEnd();
}
