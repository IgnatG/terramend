import type { ToolContext } from "#app/mcp/server";

/**
 * Bind the GitHub REST write tools to the issue/PR the run is scoped to.
 *
 * Terramend's threat model treats the agent as semi-trusted: attacker-controlled
 * PR/issue content can prompt-inject it. The git tools already refuse to act on a
 * PR the run was not triggered against (the cross-PR clobber guard in
 * `mcp/git.ts`). These helpers extend the same scoping to the REST write tools
 * (comment, review, labels, PR-body update, review reply, thread resolve) so an
 * injected agent cannot comment on / approve / label an UNRELATED issue or PR in
 * the same repo. The installation token already prevents cross-REPO writes; this
 * closes the remaining cross-issue/PR-within-the-repo gap.
 *
 * In scope = the triggering issue/PR (`event.issue_number`) OR a PR/issue THIS
 * run created (`create_pull_request` / `create_issue`, recorded via
 * `recordCreatedTarget`). A merely checked-out PR is NOT in scope: `checkout_pr`
 * is agent-controlled, so letting it widen write scope would defeat the guard.
 *
 * Standalone runs (workflow_dispatch / CLI: `event.trigger === "unknown"`) carry
 * no triggering issue/PR and therefore no injection surface — there is nothing to
 * bind to, so the guard is a no-op and the operator-supplied target is honored.
 */

/** the PR/issue this run was triggered against, or undefined for standalone runs. */
function scopedTarget(ctx: ToolContext): number | undefined {
  // optional chain: production always sets `payload.event` (resolvePayload
  // defaults event to {trigger:"unknown"}), but degrade to "no scope" if it's
  // somehow absent rather than throwing from a guard.
  return ctx.payload?.event?.issue_number;
}

/**
 * Record a PR/issue this run created so later body edits / comments / reviews on
 * it pass {@link assertTargetInScope}. Call after a successful
 * `create_pull_request` / `create_issue`.
 */
export function recordCreatedTarget(ctx: ToolContext, target: number): void {
  ctx.toolState.createdTargets ??= new Set();
  ctx.toolState.createdTargets.add(target);
}

/** true when `target` is the run's triggering issue/PR or one it created. */
export function isTargetInScope(ctx: ToolContext, target: number): boolean {
  const scoped = scopedTarget(ctx);
  // standalone run — no triggering issue/PR to bind to (no injection surface).
  if (scoped === undefined) return true;
  if (target === scoped) return true;
  return ctx.toolState.createdTargets?.has(target) ?? false;
}

/**
 * Throw if `target` is neither the run's triggering issue/PR nor one it created.
 * `action` is a short verb phrase used in the error (e.g. "comment on",
 * "submit a review on", "add labels to").
 */
export function assertTargetInScope(ctx: ToolContext, target: number, action: string): void {
  if (isTargetInScope(ctx, target)) return;
  const scoped = scopedTarget(ctx);
  throw new Error(
    `blocked: this run is scoped to #${scoped}; refusing to ${action} #${target}. ` +
      `terramend only writes to the issue/PR that triggered the run (or one it opened during the run). ` +
      `if acting on #${target} is intended, trigger a run against #${target}.`,
  );
}
