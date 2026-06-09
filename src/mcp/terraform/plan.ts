import type { BlastTier } from "#app/mcp/terraform/types";

// --- terraform plan (the safety gate) -------------------------------------

export interface PlanSummary {
  /** resources to add / change / destroy, from the plan's change_summary. */
  add: number;
  change: number;
  destroy: number;
  /** every resource with a real action (create/update/delete/replace) — the set
   * that powers blast-radius (§2.6) and plan-stability (§1.3). */
  changed: { address: string; action: string }[];
  /** resources that would be deleted or replaced — the destructive set. */
  destructive: { address: string; action: string }[];
  hasDestroyOrReplace: boolean;
}

/**
 * Parse `terraform plan -json` (newline-delimited JSON). `change_summary` gives
 * the add/change/destroy totals; each `planned_change` with a real action is
 * collected into `changed`, and the delete/replace subset into `destructive`
 * (the high-risk set a reviewer must scrutinise). Non-mutating actions are
 * ignored, as are non-JSON / non-plan lines, so a noisy stream (provider logs,
 * diagnostics) parses cleanly.
 *
 * NB on the action enum: terraform's machine-readable UI (the `-json` stream)
 * spells no-op as `"noop"` — NOT `"no-op"` — and also emits `"move"` / `"import"`
 * / `"forget"` for state-only operations that don't mutate live infrastructure.
 * None of those should count toward `changed` (they'd inflate the blast radius
 * §2.6). We skip them explicitly; `"no-op"` is tolerated too in case a wrapper
 * or older format hyphenates it. See
 * https://developer.hashicorp.com/terraform/internals/machine-readable-ui.
 */
const NON_MUTATING_PLAN_ACTIONS: ReadonlySet<string> = new Set([
  "noop",
  "no-op",
  "read",
  "move",
  "import",
  "forget",
]);

export function parseTerraformPlanJson(stdout: string): PlanSummary {
  let add = 0;
  let change = 0;
  let destroy = 0;
  const changed: { address: string; action: string }[] = [];
  const destructive: { address: string; action: string }[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let msg: {
      type?: string;
      changes?: { add?: number; change?: number; remove?: number };
      change?: { action?: string; resource?: { addr?: string; resource?: string } };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (msg.type === "change_summary" && msg.changes) {
      add = Number(msg.changes.add) || 0;
      change = Number(msg.changes.change) || 0;
      destroy = Number(msg.changes.remove) || 0;
    } else if (msg.type === "planned_change" && msg.change) {
      const action = String(msg.change.action ?? "");
      if (!action || NON_MUTATING_PLAN_ACTIONS.has(action)) continue;
      const address = msg.change.resource?.addr || msg.change.resource?.resource || "(unknown)";
      changed.push({ address, action });
      // "delete", "replace", and the "*-then-delete" / "delete-then-*" forms.
      if (action.includes("delete") || action === "replace") {
        destructive.push({ address, action });
      }
    }
  }
  return {
    add,
    change,
    destroy,
    changed,
    destructive,
    hasDestroyOrReplace: destructive.length > 0,
  };
}

// --- stateful destroy/replace classification (safety gate §2.5) ------------

/**
 * Resource types that hold data/state — destroying or replacing one of these
 * means data loss, not just recreation. A remediation that would delete or
 * replace one is hard-blocked at push time unless the operator opts in via the
 * `allow_replace` input. Not exhaustive: it covers the common managed
 * datastores across AWS / Azure / GCP; extend as new ones come up.
 */
export const STATEFUL_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  // AWS
  "aws_db_instance",
  "aws_rds_cluster",
  "aws_rds_cluster_instance",
  "aws_s3_bucket",
  "aws_ebs_volume",
  "aws_efs_file_system",
  "aws_dynamodb_table",
  "aws_dynamodb_global_table",
  "aws_elasticache_cluster",
  "aws_elasticache_replication_group",
  "aws_redshift_cluster",
  "aws_docdb_cluster",
  "aws_neptune_cluster",
  "aws_opensearch_domain",
  "aws_elasticsearch_domain",
  // Azure
  "azurerm_sql_database",
  "azurerm_mssql_database",
  "azurerm_postgresql_database",
  "azurerm_postgresql_flexible_server",
  "azurerm_mysql_database",
  "azurerm_mysql_flexible_server",
  "azurerm_cosmosdb_account",
  "azurerm_cosmosdb_sql_database",
  "azurerm_storage_account",
  "azurerm_managed_disk",
  // GCP
  "google_sql_database_instance",
  "google_storage_bucket",
  "google_bigtable_instance",
  "google_bigquery_dataset",
  "google_spanner_database",
  "google_redis_instance",
  "google_filestore_instance",
  "google_compute_disk",
]);

/**
 * Extract the Terraform resource TYPE from a plan address, stripping any
 * `module.<name>.` prefixes and an instance index/key suffix:
 *   `module.db.aws_db_instance.main`               -> `aws_db_instance`
 *   `aws_s3_bucket.data["prod"]`                   -> `aws_s3_bucket`
 *   `module.a.module.b.google_storage_bucket.x[0]` -> `google_storage_bucket`
 * Returns "" when the address has no parseable `type.name` pair.
 */
export function resourceTypeOf(address: string): string {
  const withoutModules = address.replace(/^(?:module\.[^.]+\.)+/, "");
  const cleaned = withoutModules.replace(/\[[^\]]*\]$/, "");
  const segments = cleaned.split(".");
  return segments.length >= 2 ? segments[segments.length - 2] : "";
}

export interface DestroyClassification {
  /** destroy/replace of a data-bearing type — high-risk, blocked by default. */
  stateful: { address: string; action: string; type: string }[];
  /** destroy/replace of a recreatable type — recorded, not blocked. */
  ephemeral: { address: string; action: string; type: string }[];
}

/** partition a plan's destructive set into stateful (blocked) vs ephemeral. */
export function classifyDestructive(
  destructive: { address: string; action: string }[],
): DestroyClassification {
  const stateful: DestroyClassification["stateful"] = [];
  const ephemeral: DestroyClassification["ephemeral"] = [];
  for (const d of destructive) {
    const type = resourceTypeOf(d.address);
    (STATEFUL_RESOURCE_TYPES.has(type) ? stateful : ephemeral).push({ ...d, type });
  }
  return { stateful, ephemeral };
}

// --- blast-radius scoring (§2.6) -------------------------------------------

export interface BlastRadius {
  tier: BlastTier;
  /** count of resources the plan would create/update/delete/replace. */
  resourceCount: number;
  /** distinct module addresses touched (root resources count as `root`). */
  modules: string[];
}

/**
 * Extract the module address from a resource address: the `module.X[.module.Y]`
 * call path, or `root` for a top-level resource. Strips instance index/key from
 * EVERY segment — a `count`/`for_each` MODULE carries its key on the module
 * segment (`module.net[0]`), so all instances of one module collapse to one
 * address (else a single-module fix would look cross-module). Removing keys
 * first also tolerates a `.` inside a `for_each` string key.
 *   `aws_s3_bucket.b`                  -> `root`
 *   `module.db.aws_db_instance.main`   -> `module.db`
 *   `module.net[0].aws_vpc.main`       -> `module.net`
 *   `module.a.module.b.google_x.y[0]`  -> `module.a.module.b`
 */
export function moduleAddressOf(address: string): string {
  const cleaned = address.replace(/\[[^\]]*\]/g, "");
  const segments = cleaned.split(".");
  // the resource is the final `type.name` pair; anything before is the module path.
  return segments.length <= 2 ? "root" : segments.slice(0, segments.length - 2).join(".");
}

/**
 * Score how much a fix touches, to route large changes through stricter review:
 * 1–2 resources = `low`, 3–10 = `medium`, more than 10 OR spanning more than one
 * module = `high`. A `high` blast radius should force human-in-the-loop
 * regardless of finding severity (feeds §3.9). 0 changes is `low` (nothing to do).
 */
export function computeBlastRadius(changed: { address: string }[]): BlastRadius {
  const resourceCount = changed.length;
  const modules = [...new Set(changed.map((c) => moduleAddressOf(c.address)))].sort();
  const crossModule = modules.length > 1;
  let tier: BlastTier;
  if (resourceCount > 10 || crossModule) tier = "high";
  else if (resourceCount >= 3) tier = "medium";
  else tier = "low";
  return { tier, resourceCount, modules };
}

// --- plan stability / idempotency (§1.3) -----------------------------------

export interface StabilityResult {
  /** true when a second plan produced the identical change set. */
  stable: boolean;
  reason?: string;
}

/** a normalized signature of a plan's change set (summary counts + sorted
 * address:action pairs) — two plans with the same signature are equivalent. */
function planSignature(s: PlanSummary): string {
  const set = s.changed
    .map((c) => `${c.address}:${c.action}`)
    .sort()
    .join(",");
  return `+${s.add}~${s.change}-${s.destroy}|${set}`;
}

/**
 * Compare two consecutive plans for stability. Terramend never `apply`s (it only
 * opens PRs), so a true "no perpetual diff after apply" cannot be proven here —
 * but a fix whose plan is non-deterministic (e.g. `timestamp()`, `uuid()`, an
 * unkeyed `random_*`, or a data source that varies run-to-run) yields a DIFFERENT
 * plan on the second run, and that is a real perpetual-diff smell we can catch
 * without applying. Stable ⇒ the two plans matched; unstable ⇒ report it.
 */
export function comparePlanStability(first: PlanSummary, second: PlanSummary): StabilityResult {
  if (planSignature(first) === planSignature(second)) return { stable: true };
  return {
    stable: false,
    reason:
      `the plan is not deterministic — a second \`terraform plan\` (same state, no apply) produced a ` +
      `different change set (first: +${first.add} ~${first.change} -${first.destroy}; ` +
      `second: +${second.add} ~${second.change} -${second.destroy}). This is a perpetual-diff smell, ` +
      `usually a non-deterministic value in the config (timestamp()/uuid()/unkeyed random_*/a varying data source).`,
  };
}

// --- multi-root plan aggregation -------------------------------------------

export interface RootPlan {
  /** display label for the root ("." for the top-level root). */
  dir: string;
  summary: PlanSummary;
  stable: boolean;
}

export interface AggregatedPlan {
  add: number;
  change: number;
  destroy: number;
  changed: { address: string; action: string }[];
  destructive: { address: string; action: string }[];
  hasDestroyOrReplace: boolean;
  idempotent: boolean;
}

/**
 * Aggregate per-root plan results into one view: SUM the add/change/destroy
 * counts, UNION the changed + destructive sets (so blast-radius and the
 * destroy-block see every root's effect), and treat the whole run as
 * non-idempotent if ANY root's plan was unstable. Pure. Single-root input passes
 * straight through (identical to the pre-multi-root behaviour).
 */
export function aggregatePlans(roots: RootPlan[]): AggregatedPlan {
  let add = 0;
  let change = 0;
  let destroy = 0;
  let idempotent = true;
  const changed: { address: string; action: string }[] = [];
  const destructive: { address: string; action: string }[] = [];
  for (const r of roots) {
    add += r.summary.add;
    change += r.summary.change;
    destroy += r.summary.destroy;
    changed.push(...r.summary.changed);
    destructive.push(...r.summary.destructive);
    if (!r.stable) idempotent = false;
  }
  return {
    add,
    change,
    destroy,
    changed,
    destructive,
    hasDestroyOrReplace: destructive.length > 0,
    idempotent,
  };
}
