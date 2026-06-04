import { modelAliases } from "../models.ts";

/**
 * Derive a cheaper subagent model override from the orchestrator's resolved
 * model spec.
 *
 * This is a pure registry lookup: every alias in `action/models.ts` declares
 * its own `subagentModel` (alias key in the same provider). At runtime we
 * reverse-lookup the orchestrator's resolved slug to find the alias that
 * produced it, follow the `subagentModel` pointer, and return the target
 * alias's resolve / openRouterResolve depending on which route the
 * orchestrator was using.
 *
 * Returns `{ reviewer: undefined }` when the orchestrator's alias has no
 * `subagentModel` (e.g. it's already at a sufficiently cheap tier, or its
 * provider doesn't have a clean cheaper-but-capable sibling). See models.ts
 * for the wiring + per-provider rationale.
 */
export function deriveSubagentModels(orchestratorSpec: string | undefined): {
  reviewer: string | undefined;
} {
  if (!orchestratorSpec) return { reviewer: undefined };

  // Reverse-lookup. The same resolve string appears in only one alias
  // (within its provider), so first match wins. We track which field
  // matched (resolve vs openRouterResolve) so we can pick the same field
  // off the subagent target — keeping the orchestrator's route consistent.
  for (const source of modelAliases) {
    const matchedDirect = source.resolve === orchestratorSpec;
    const matchedOR = source.openRouterResolve === orchestratorSpec;
    if (!matchedDirect && !matchedOR) continue;
    if (!source.subagentModel) return { reviewer: undefined };
    const target = modelAliases.find((a) => a.slug === source.subagentModel);
    if (!target) return { reviewer: undefined };
    const reviewer = matchedOR ? target.openRouterResolve : target.resolve;
    return { reviewer };
  }

  return { reviewer: undefined };
}
