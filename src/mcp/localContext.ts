import type { ToolState } from "#app/toolState";
import type { ResolvedPayload } from "#app/utils/payload";

/**
 * The cwd-scoped, GitHub-free subset of `ToolContext` that the read-only
 * Terraform tools depend on. Two providers exist:
 *
 *   - the GitHub Action run: the full `ToolContext` (structurally assignable —
 *     it carries these fields plus the GitHub/auth surface), and
 *   - `terramend mcp` (the local stdio MCP server): exactly this shape, built
 *     from CLI flags — no octokit, no tokens, no event payload.
 *
 * Keep this interface to fields a LOCAL run can genuinely provide. A tool that
 * needs more (octokit, push, PR state) belongs on `ToolContext`, not here.
 */
export interface LocalToolContext {
  payload: Pick<
    ResolvedPayload,
    | "cwd"
    | "scanScope"
    | "severityThreshold"
    | "autonomyThreshold"
    | "costIncreaseBlockUsd"
    | "moduleCatalogue"
    // §1.5 — the unified tool selection + module-fetch credential are honoured on
    // the local stdio MCP server too (read-only scans + private-module init).
    | "toolsEnabled"
    | "gitleaks"
    | "terratest"
    | "terraformMcp"
    | "moduleFetchToken"
  >;
  toolState: ToolState;
  tmpdir: string;
}
