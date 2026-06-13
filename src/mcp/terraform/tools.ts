import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import type { LocalToolContext } from "#app/mcp/localContext";
import { resolveWithinCwd } from "#app/mcp/pathSafety";
import { execute, tool, toolOk } from "#app/mcp/shared";
import {
  type CostBreakdown,
  classifyCostEscalation,
  computeCostDelta,
  infracostBaseline,
  parseInfracostBreakdown,
  parseInfracostResources,
  runInfracostBreakdown,
} from "#app/mcp/terraform/cost";
import { checkVersionCurrency } from "#app/mcp/terraform/currency";
import {
  annotateGroups,
  classifyRefusal,
  clusterByLocation,
  computeConfidence,
  docUrlsForGroup,
  groupConcerns,
  groupConcernsByRule,
  type PreventiveControl,
  planBatches,
  preventiveControlFor,
  ruleDocUrl,
} from "#app/mcp/terraform/decisions";
import { buildSarifReport, parseFindingsFile } from "#app/mcp/terraform/findings";
import {
  aggregatePlans,
  classifyDestructive,
  comparePlanStability,
  computeBlastRadius,
  isPureMovePlan,
  type PlanSummary,
  parseTerraformPlanJson,
  type RootPlan,
} from "#app/mcp/terraform/plan";
import {
  changedTerraformFiles,
  checkArgumentsAgainstSchema,
  collectProviderRequirements,
  computeRegressions,
  computeRemediationVerdict,
  partitionByKey,
  regressionIdsByKey,
  runScanners,
  scanFmt,
  scanTflint,
  scanValidate,
} from "#app/mcp/terraform/scanners";
import {
  type Concern,
  concernKeyOf,
  dedupe,
  isTerraformConcern,
  resolveRoots,
  run,
  SEVERITY_RANK,
  type Severity,
  skipped,
  skipResult,
  sortConcerns,
} from "#app/mcp/terraform/types";
import { log } from "#app/utils/cli";
import { resolveModuleFetchEnv } from "#app/utils/moduleFetch";
import { resolveToolSelection } from "#app/utils/toolSelection";

export const TerraformScanParams = type({
  "scan_scope?": type("'full' | 'diff'").describe(
    "'full' (default) scans the whole workspace; 'diff' limits concerns to Terraform files changed vs the base branch.",
  ),
  "severity_threshold?": type("'critical' | 'high' | 'medium' | 'low' | 'info'").describe(
    "minimum severity to report (default: low). 'info' includes everything.",
  ),
  "group_by?": type("'file' | 'rule'").describe(
    "'file' (default) makes one group per file (smaller blast radius per PR). 'rule' groups a single rule's concerns across ALL files into one group — use for sweeping, low-risk rules (e.g. 'add tags everywhere') so they become one PR instead of many.",
  ),
});

export function TerraformScanTool(ctx: LocalToolContext) {
  return tool({
    name: "terraform_scan",
    description:
      "Scan the Terraform in the workspace against best practices using the deterministic check tools " +
      "(terraform fmt, terraform validate, tflint, trivy, checkov). Returns a stable, severity-ranked " +
      "list of `concerns` — each is one best-practice issue with a content-derived `id`, the producing " +
      "`source`, `rule_id`, `severity`, the `location` (file + line), and a `remediation_hint`. Concerns " +
      "are also rolled up into `groups` (one per file): different scanners flag the same defect under " +
      "different rule ids, so remediate ONE group per PR (its `id` is the branch/PR key; its `concern_ids` " +
      "are what the ✗→✓ re-scan must confirm cleared) rather than one PR per concern. Scanners that aren't " +
      "installed are reported as skipped (they never fail the scan). Also returns `co_located` (concerns " +
      "different scanners flagged at the same file:line — fix as ONE canonical change, §30), " +
      "`refusal_candidates` (concerns whose fix needs a human decision — prefer a structured refusal over " +
      "guessing, §29), and `prevention` (a CI guardrail per rule that stops it recurring, §21).",
    parameters: TerraformScanParams,
    execute: execute(async ({ scan_scope, severity_threshold, group_by }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      // precedence: explicit tool arg > the run's configured severity_threshold > "low"
      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";
      const minRank = SEVERITY_RANK[threshold];
      const scope = scan_scope ?? ctx.payload.scanScope ?? "full";

      // §1.5 — the unified tool selection (licence gate + allow/deny) and the
      // optional module-fetch credential, both derived from the run payload so
      // the scan and its ✗→✓ verification re-scan see the identical toolchain.
      const selection = resolveToolSelection(ctx.payload);
      const terraformEnv = resolveModuleFetchEnv(ctx.payload);
      if (selection.unknownTokens.length > 0) {
        log.warning(
          `» tools_enabled: ignoring unrecognised tool(s) [${selection.unknownTokens.join(", ")}]`,
        );
      }

      const outcomes = runScanners(cwd, { selection, terraformEnv });

      // diff scope: keep only concerns in Terraform files changed vs the base.
      let scopeNote: string | undefined;
      let changed: Set<string> | null = null;
      if (scope === "diff") {
        changed = changedTerraformFiles(cwd);
        if (changed === null) {
          scopeNote =
            "diff scope requested but the base branch could not be determined — scanned full instead";
        }
      }
      const inScope = (c: Concern): boolean =>
        changed === null
          ? true
          : changed.has(c.location.file.replace(/\\/g, "/").replace(/^\.\//, ""));

      // §1.4 baseline: the full, severity-unfiltered concern set, captured BEFORE
      // any fix and computed identically to verify's `current` set so the later
      // regression diff is apples-to-apples. We store BOTH the line-pinned ids and
      // the line-independent keys (concernKeyOf) — verify diffs on the keys so a
      // line-shifting fix can't fabricate a resolution or a regression.
      const fullBaseline = dedupe(outcomes.flatMap((o) => o.concerns));
      ctx.toolState.baselineConcernIds = fullBaseline.map((c) => c.id);
      ctx.toolState.baselineConcernKeys = fullBaseline.map((c) => concernKeyOf(c));

      const all = sortConcerns(dedupe(outcomes.flatMap((o) => o.concerns)))
        .filter(isTerraformConcern)
        .filter(inScope)
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank);

      // the reported (post-filter) set — read at end-of-run by
      // finalizeSuccessRun to emit the SARIF artifact + findings outputs (§5.4).
      ctx.toolState.lastScanConcerns = all;

      // §3.11 grouping mode: by-file (default, smaller per-PR blast radius) or
      // by-rule (one PR per rule across all files — for sweeping low-risk rules).
      const grouping = group_by ?? "file";
      const autonomyThreshold = (ctx.payload.autonomyThreshold as Severity | undefined) ?? "high";
      const groups = annotateGroups(
        grouping === "rule" ? groupConcernsByRule(all) : groupConcerns(all),
        all,
        autonomyThreshold,
      );

      // §3.10 batching plan: which auto/low-risk groups can ride one PR vs which
      // must be isolated. Advisory — the agent acts on it under max_prs.
      const batchPlan = planBatches(groups);

      // §30 — concerns different scanners flagged at the same file:line (one
      // canonical fix). §29 — concerns whose fix needs a human decision (prefer
      // a structured refusal). §21 — the preventive control per distinct rule.
      const coLocated = clusterByLocation(all);
      const refusalCandidates = all
        .map((c) => ({ id: c.id, ...classifyRefusal(c) }))
        .filter((r) => r.refuse)
        .map((r) => ({ concern_id: r.id, reason: r.reason }));
      const prevention: Record<string, PreventiveControl> = {};
      for (const c of all) {
        if (prevention[c.rule_id]) continue;
        const control = preventiveControlFor(c);
        if (control) prevention[c.rule_id] = control;
      }

      const by_severity: Record<string, number> = {};
      for (const c of all) by_severity[c.severity] = (by_severity[c.severity] ?? 0) + 1;

      const ran = outcomes.filter((o) => o.ran).map((o) => o.source);
      const skippedScanners = outcomes
        .filter((o) => !o.ran)
        .map((o) => ({ source: o.source, reason: o.skipped_reason }));

      log.info(
        `» terraform_scan: ${all.length} concern(s) ≥ ${threshold} from [${ran.join(", ")}] ` +
          `(${groups.length} ${grouping}-group(s))` +
          (skippedScanners.length
            ? ` (skipped: ${skippedScanners.map((s) => s.source).join(", ")})`
            : ""),
      );

      return toolOk({
        scanned_dir: cwd,
        scope: changed === null ? "full" : "diff",
        ...(scopeNote ? { scope_note: scopeNote } : {}),
        grouping,
        scanners_ran: ran,
        scanners_skipped: skippedScanners,
        // §1.5 — licence-aware tool posture: which non-permissive tools are off
        // for want of an explicit opt-in, and which were explicitly disabled.
        tool_selection: {
          licence_gated: selection.gated,
          disabled: selection.disabled,
        },
        summary: { total: all.length, groups: groups.length, by_severity },
        groups: groups.map((g) => ({ ...g, doc_urls: docUrlsForGroup(g, all) })),
        batch_plan: batchPlan,
        // §30 cross-tool co-location, §29 refusal candidates, §21 prevention.
        co_located: coLocated,
        refusal_candidates: refusalCandidates,
        prevention,
        concerns: all.map((c) => ({ ...c, doc_url: ruleDocUrl(c) })),
      });
    }),
  });
}

export const TerraformValidateParams = type({
  "paths?": type.string
    .array()
    .describe(
      "optional list of file globs/paths to limit fmt+lint to; omit to check the whole workspace",
    ),
});

export function TerraformValidateTool(ctx: LocalToolContext) {
  return tool({
    name: "terraform_validate",
    description:
      "Fast pre-PR gate. Runs `terraform fmt -check`, `terraform validate` (per Terraform root — " +
      "multi-root aware, see `roots_validated`), and `tflint` over the " +
      "workspace and returns whether the Terraform is well-formed and idiomatic. Also reports `providers` " +
      "— the pinned provider requirements (name + source + version constraint + resolved `major`, §4.15): " +
      "honour the pinned major when writing a fix, because argument names and valid blocks differ across " +
      "provider majors, and a 'correct' fix for the wrong major just breaks `plan`. Call this AFTER " +
      "applying a fix and BEFORE opening a PR — never open a PR whose `terraform_validate` did not pass.",
    parameters: TerraformValidateParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      // §1.5 — honour the same licence gate + module-fetch credential as
      // terraform_scan: tflint (MPL-2.0) runs only when opted in; validate's init
      // gets the credential so a private cross-repo module resolves.
      const selection = resolveToolSelection(ctx.payload);
      const terraformEnv = resolveModuleFetchEnv(ctx.payload);
      // `terraform validate` runs per-root (multi-root aware); fmt + tflint are
      // recursive over the whole tree.
      const checks = [
        scanFmt(cwd),
        scanValidate(cwd, terraformEnv),
        selection.enabled("tflint")
          ? scanTflint(cwd)
          : skipped("tflint", selection.offReason("tflint") ?? "disabled by tools_enabled"),
      ];
      const remaining = sortConcerns(dedupe(checks.flatMap((c) => c.concerns)));
      const ran = checks.filter((c) => c.ran).map((c) => c.source);
      // count of roots where terraform ran but `validate -json` couldn't be
      // parsed — a real failure, not a clean tree. We genuinely don't know if
      // those roots are valid, so `passed` must fail closed below rather than
      // silently treating an un-validated root as passing.
      const unvalidatedRoots =
        checks.find((c) => c.source === "terraform-validate")?.unvalidated ?? 0;
      // §4.15 — surface the pinned provider majors so the fix targets the right
      // argument schema (deterministic, read straight from required_providers).
      const providers = collectProviderRequirements(cwd);
      const roots = resolveRoots(cwd).map((r) => r.relDir || ".");
      // §4.15-next — cross-check the arguments actually written in the workspace
      // against the INSTALLED provider's schema, so an argument that's invalid
      // for the pinned provider major (a "correct" fix for the wrong version) is
      // caught here, before the PR, instead of surfacing as a `plan` failure.
      // Deterministic and degrades green (omitted) when the schema isn't
      // available (terraform not installed / dir not init-ed).
      const schemaCheck = checkArgumentsAgainstSchema(cwd);
      return toolOk({
        // `passed` stays gated on fmt + validate + tflint only — those are
        // authoritative. The schema cross-check is a high-signal ADVISORY (a
        // conservative HCL parse), surfaced separately so a parser edge case can
        // never wrongly block a valid fix. Fails closed when a root ran but
        // couldn't be validated: an un-validated root is "unknown", not "clean".
        passed: remaining.length === 0 && unvalidatedRoots === 0,
        checks_ran: ran,
        // true when ≥1 Terraform root could not be validated (terraform ran but
        // its `-json` output was unparseable). When set, `passed` is false even
        // with no remaining_issues — re-run after fixing the root's init/state,
        // or inspect it by hand; do NOT treat the clean issue list as a pass.
        validate_incomplete: unvalidatedRoots > 0,
        remaining_issues: remaining,
        providers,
        // §4.15-next — arguments written in the workspace that are NOT in the
        // installed provider's schema (would break `plan` on the pinned major).
        // `schema_checked` is false when the schema was unavailable (terraform
        // not installed / dir not init-ed) — then `unknown_arguments` is empty
        // and you should rely on `terraform_plan` to catch a bad argument.
        schema_checked: schemaCheck.checked,
        unknown_arguments: schemaCheck.unknown_arguments,
        // the Terraform roots `validate` covered (each was init+validate'd).
        roots_validated: roots,
      });
    }),
  });
}

export const TerraformVerifyRemediationParams = type({
  concern_ids: type.string
    .array()
    .describe(
      "the `concern_ids` of the group being remediated (from the original terraform_scan). the tool re-runs the scanners and reports which are now resolved vs still present.",
    ),
});

export function TerraformVerifyRemediationTool(ctx: LocalToolContext) {
  return tool({
    name: "terraform_verify_remediation",
    description:
      "Deterministic ✗→✓ proof for a remediation. Re-runs the scanners and partitions the given " +
      "`concern_ids` into `resolved` (gone from the re-scan) and `remaining` (still present), with a " +
      "`verified` flag that is true ONLY when every id is gone. Also reports `regressions` — NEW concern " +
      "ids the fix introduced that were not in the pre-fix scan (§1.4): when `has_regressions` is true the " +
      "PR must be labelled `needs-human` and the new concerns listed. Finally returns a deterministic " +
      "`confidence` (high/medium/low, §5.19) computed from the verification evidence (verified + no " +
      "regressions + plan idempotency + blast radius + cost direction) — render it as a PR label/badge. " +
      "Call this AFTER pushing the fix branch and build the PR's Validation section from its result — do " +
      "NOT eyeball a scan or self-report resolution. A concern may be listed as ✓ resolved only if it " +
      "appears in `resolved`.",
    parameters: TerraformVerifyRemediationParams,
    execute: execute(async ({ concern_ids }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      // §1.5 — re-scan with the SAME selection + module-fetch credential the
      // scan used, so a licence-gated tool is consistently off across baseline +
      // verification and the ✗→✓ partition stays apples-to-apples.
      const outcomes = runScanners(cwd, {
        selection: resolveToolSelection(ctx.payload),
        terraformEnv: resolveModuleFetchEnv(ctx.payload),
      });
      const currentConcerns = dedupe(outcomes.flatMap((o) => o.concerns));
      const currentIds = currentConcerns.map((c) => c.id);
      // line-INDEPENDENT keys: verify on (source|rule|file), not the line-pinned
      // id, so a fix that shifts lines (almost every fix) can't make an unfixed
      // concern look resolved nor a pre-existing one look like a regression.
      const currentKeys = new Set(currentConcerns.map((c) => concernKeyOf(c)));

      // Map each requested id → its key via the original scan's concerns
      // (lastScanConcerns). Ids we can't key-map (verify called without a prior
      // scan this run — e.g. a bare findings.json) fall back to exact-id matching.
      const keyById = new Map(
        (ctx.toolState.lastScanConcerns ?? []).map((c) => [c.id, concernKeyOf(c)] as const),
      );
      const keyed: { id: string; key: string }[] = [];
      const unkeyed: string[] = [];
      for (const id of concern_ids) {
        const key = keyById.get(id);
        if (key !== undefined) keyed.push({ id, key });
        else unkeyed.push(id);
      }
      const keyedVerdict = partitionByKey(keyed, currentKeys);
      const fallbackVerdict = computeRemediationVerdict(unkeyed, new Set(currentIds));
      const resolved = [...keyedVerdict.resolved, ...fallbackVerdict.resolved];
      const remaining = [...keyedVerdict.remaining, ...fallbackVerdict.remaining];
      const verified = remaining.length === 0;

      // §1.4 — concerns the fix INTRODUCED, on the SAME line-independent key basis
      // (a pre-existing concern that merely shifted lines is NOT a regression).
      // Prefer baseline keys; fall back to the legacy raw-id diff only when keys
      // weren't captured (no scan this run) — then report as unknown if neither is.
      const baselineKeys = ctx.toolState.baselineConcernKeys;
      const baselineIds = ctx.toolState.baselineConcernIds;
      const regressions = baselineKeys
        ? regressionIdsByKey(
            currentConcerns.map((c) => ({ id: c.id, key: concernKeyOf(c) })),
            new Set(baselineKeys),
          )
        : baselineIds
          ? computeRegressions(baselineIds, currentIds)
          : [];
      const regressionsKnown = baselineKeys !== undefined || baselineIds !== undefined;

      // §5.19 — deterministic confidence from the evidence on hand.
      const confidence = computeConfidence({
        verified,
        regressionCount: regressions.length,
        idempotent: ctx.toolState.lastIdempotent,
        blastTier: ctx.toolState.lastBlastTier,
        costDirection: ctx.toolState.lastCostDirection,
      });

      const ran = outcomes.filter((o) => o.ran).map((o) => o.source);
      log.info(
        `» terraform_verify_remediation: ${resolved.length}/${concern_ids.length} resolved` +
          ` (${remaining.length} still present` +
          (regressionsKnown ? `, ${regressions.length} regression(s)` : "") +
          `) — confidence: ${confidence.level} — from [${ran.join(", ")}]`,
      );
      return toolOk({
        verified,
        resolved_count: resolved.length,
        remaining_count: remaining.length,
        resolved,
        remaining,
        // §1.4 regression guard
        has_regressions: regressions.length > 0,
        regressions,
        ...(regressionsKnown
          ? {}
          : {
              regressions_note:
                "no pre-fix baseline captured (run terraform_scan first) — regressions not checked",
            }),
        // §5.19 confidence label
        confidence: confidence.level,
        confidence_reasons: confidence.reasons,
        scanners_ran: ran,
      });
    }),
  });
}

export const InfracostDiffParams = type({});

export function InfracostDiffTool(ctx: LocalToolContext) {
  return tool({
    name: "infracost_diff",
    description:
      "Estimate the monthly cost impact of the remediation. Runs Infracost on the current (fixed) " +
      "Terraform and, when the base branch is resolvable, on the base version too — returning the " +
      "monthly cost delta so a security fix that meaningfully raises spend can be flagged rather than " +
      "merged blindly. Auto-skips (never fails) when INFRACOST_API_KEY is unset or the infracost CLI " +
      "is absent — cost analysis is opt-in. Call it after the fix is committed and, when it returns " +
      "`ran: true`, fold a one-line cost note into the PR body.",
    parameters: InfracostDiffParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const key = process.env.INFRACOST_API_KEY || undefined;
      if (!key) {
        return skipResult(
          "infracost_key_unset",
          "INFRACOST_API_KEY not set — cost analysis is opt-in",
        );
      }
      const cur = runInfracostBreakdown(cwd, key);
      if (cur.missing) return skipResult("infracost_not_installed", "infracost not installed");
      if (cur.status !== 0) {
        return skipResult(
          "infracost_failed",
          `infracost breakdown failed: ${cur.stderr.trim().slice(0, 300) || "unknown error"}`,
        );
      }
      let current: CostBreakdown;
      try {
        current = parseInfracostBreakdown(cur.stdout);
      } catch {
        return skipResult("infracost_parse_error", "could not parse infracost json output");
      }
      const baseline = infracostBaseline(cwd, key, ctx.tmpdir);
      const delta = computeCostDelta(baseline, current);
      // per-resource breakdown (top drivers) for a collapsed <details> in the PR.
      const topResources = parseInfracostResources(cur.stdout).slice(0, 10);
      // §5.19 — record the cost direction for the confidence label.
      ctx.toolState.lastCostDirection = delta.direction;
      // §4.16-next — escalate to human review when the increase crosses the
      // operator's threshold.
      const escalation = classifyCostEscalation(
        delta.deltaMonthly,
        ctx.payload.costIncreaseBlockUsd,
      );
      log.info(
        `» infracost_diff: current ${delta.currentMonthly ?? "?"} ${delta.currency}/mo` +
          (delta.deltaMonthly !== null
            ? `, delta ${delta.deltaMonthly >= 0 ? "+" : ""}${delta.deltaMonthly}`
            : " (no baseline)") +
          (escalation.escalate ? " ⚠ COST ESCALATION (needs-human)" : ""),
      );
      return toolOk({
        ran: true,
        currency: delta.currency,
        current_monthly_cost: delta.currentMonthly,
        baseline_monthly_cost: delta.baselineMonthly,
        monthly_delta: delta.deltaMonthly,
        direction: delta.direction,
        // §4.16-next — when true, label the PR needs-human (large spend increase).
        needs_human: escalation.escalate,
        ...(escalation.reason ? { cost_escalation_reason: escalation.reason } : {}),
        // per-resource cost drivers (top 10) for a collapsed <details> block.
        ...(topResources.length ? { top_resource_costs: topResources } : {}),
        ...(delta.deltaMonthly === null
          ? {
              note: "Baseline cost unavailable (no base ref or unpriced) — reporting current monthly cost only.",
            }
          : {}),
      });
    }),
  });
}

export const TerraformEmitSarifParams = type({
  "output_path?": type.string.describe(
    "where to write the SARIF file (default: ./terramend.sarif in the workspace). Upload it with github/codeql-action/upload-sarif to populate the repo's Security tab.",
  ),
  "severity_threshold?": type("'critical' | 'high' | 'medium' | 'low' | 'info'").describe(
    "minimum severity to include (default: the run's configured threshold, else low).",
  ),
});

export function TerraformEmitSarifTool(ctx: LocalToolContext) {
  return tool({
    name: "terraform_emit_sarif",
    description:
      "Emit the current best-practice scan as a SARIF 2.1.0 file for GitHub code-scanning (§3.5). Re-runs " +
      "the scanners and writes a SARIF report (default `terramend.sarif`) that a later workflow step uploads " +
      "with `github/codeql-action/upload-sarif`, surfacing every concern in the repo's Security tab with the " +
      "right severity + doc link. This is the EMIT side (the inverse of `read_findings`' SARIF INGEST) — use " +
      "it when the goal is to REPORT findings to code-scanning rather than open a remediation PR. Degrades " +
      "green: writes an empty-result report when the tree is clean.",
    parameters: TerraformEmitSarifParams,
    execute: execute(async ({ output_path, severity_threshold }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";
      const minRank = SEVERITY_RANK[threshold];
      // §1.5 — same selection + module-fetch credential as terraform_scan, so the
      // SARIF report mirrors exactly what a scan reports (no extra gated tools).
      const outcomes = runScanners(cwd, {
        selection: resolveToolSelection(ctx.payload),
        terraformEnv: resolveModuleFetchEnv(ctx.payload),
      });
      const concerns = sortConcerns(dedupe(outcomes.flatMap((o) => o.concerns)))
        .filter(isTerraformConcern)
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank);
      const report = buildSarifReport(concerns);
      // SECURITY: confine the agent-supplied output_path to the workspace so it
      // can't be used to clobber arbitrary files on the runner (the action
      // process runs outside the shell sandbox). Computed BEFORE the try so an
      // escape attempt surfaces as a clear error, not a "write failed" skip.
      const target = resolveWithinCwd(cwd, output_path ?? "terramend.sarif");
      try {
        writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      } catch (e) {
        return skipResult(
          "sarif_write_failed",
          `could not write SARIF to ${target}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // record the agent-emitted path so the end-of-run findings-output safety
      // net (finalizeSuccessRun) defers to this file instead of rewriting it.
      ctx.toolState.emittedSarifPath = target;
      log.info(`» terraform_emit_sarif: ${concerns.length} result(s) → ${target}`);
      return toolOk({
        sarif_path: target,
        result_count: concerns.length,
        rule_count: report.runs?.[0]?.tool?.driver?.rules?.length ?? 0,
        note: "Upload with github/codeql-action/upload-sarif to populate the repo's Security tab.",
      });
    }),
  });
}

const PLAN_JSON_ARGS = ["plan", "-input=false", "-no-color", "-lock=false", "-json"];

interface RootPlanOutcome {
  ran: boolean;
  skipReason?: string | undefined;
  summary?: PlanSummary | undefined;
  stable?: boolean | undefined;
  stabilityReason?: string | undefined;
  planText?: string | undefined;
}

/** init + plan (+ a stability re-plan + a human-readable plan) in a SINGLE root.
 * Used by terraform_plan once per discovered root. */
function planOneRoot(absDir: string, creds: Record<string, string>): RootPlanOutcome {
  const init = run("terraform", ["init", "-input=false", "-no-color"], absDir, creds);
  if (init.missing) return { ran: false, skipReason: "terraform not installed" };
  if (init.status !== 0) {
    return {
      ran: false,
      skipReason: `terraform init failed: ${init.stderr.trim().slice(0, 200) || "unknown error"}`,
    };
  }
  const plan = run("terraform", PLAN_JSON_ARGS, absDir, creds);
  if (plan.status !== 0) {
    return {
      ran: false,
      skipReason: `terraform plan failed: ${plan.stderr.trim().slice(0, 200) || "unknown error"}`,
    };
  }
  const summary = parseTerraformPlanJson(plan.stdout);
  const hasChanges =
    summary.add + summary.change + summary.destroy > 0 || summary.changed.length > 0;

  // §1.3 stability: re-plan once and compare (only when there's a change).
  let stable = true;
  let stabilityReason: string | undefined;
  if (hasChanges) {
    const plan2 = run("terraform", PLAN_JSON_ARGS, absDir, creds);
    if (plan2.status === 0) {
      const s = comparePlanStability(summary, parseTerraformPlanJson(plan2.stdout));
      stable = s.stable;
      stabilityReason = s.reason;
    }
  }
  // §1.2 human-readable plan for the PR <details> block (separate non-json run).
  let planText: string | undefined;
  if (hasChanges) {
    const readable = run(
      "terraform",
      ["plan", "-input=false", "-no-color", "-lock=false"],
      absDir,
      creds,
    );
    if (readable.status === 0 && readable.stdout.trim())
      planText = readable.stdout.trim().slice(0, 12_000);
  }
  return { ran: true, summary, stable, stabilityReason, planText };
}

// env vars that signal a cloud provider credential is present — terraform plan
// needs live provider/backend access, so we only attempt it when one is set.
const CLOUD_CRED_SIGNALS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "ARM_CLIENT_ID",
  "ARM_USE_OIDC",
  "AZURE_CLIENT_ID",
  "GOOGLE_CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
] as const;

function hasCloudCredentials(): boolean {
  return CLOUD_CRED_SIGNALS.some((k) => !!process.env[k]);
}

// env vars terraform/providers legitimately consume, re-admitted past the
// secret-stripping `run()` env for the plan invocation. Terramend is BYOK
// across providers (Anthropic / OpenAI / Google Gemini / …), so NONE of those
// LLM keys may leak into the terraform subprocess. PREFIXES are only ones that
// can't collide with a provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
// `GEMINI_API_KEY` carry no cloud prefix; the bare `GOOGLE_` prefix is
// deliberately NOT used — it would re-admit `GOOGLE_GENERATIVE_AI_API_KEY`).
// GCP creds are matched by exact NAME / the safe `GOOGLE_CLOUD_` prefix instead.
const CLOUD_CRED_PREFIXES = [
  "AWS_",
  "ARM_",
  "AZURE_",
  "GCLOUD_",
  "GOOGLE_CLOUD_",
  "TF_VAR_",
  "TF_TOKEN_",
  "TF_CLI_",
];
const CLOUD_CRED_NAMES = new Set([
  "GOOGLE_CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_KEYFILE_JSON",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "GOOGLE_PROJECT",
  "GOOGLE_REGION",
  "GOOGLE_ZONE",
  "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT",
]);

// LLM/model-provider credentials that collide with a cloud PREFIX above and so
// must be explicitly denied — otherwise a BYOK key would leak into the terraform
// subprocess. `AWS_BEARER_TOKEN_BEDROCK` (Amazon Bedrock) matches `AWS_`;
// `AZURE_OPENAI_*` matches `AZURE_`. NB `AWS_REGION` (also a Bedrock env var) is
// a legitimate cloud/terraform setting and is intentionally NOT denied. Keep in
// sync with the provider `envVars` in src/models.ts.
const LLM_CRED_DENY = new Set([
  "AWS_BEARER_TOKEN_BEDROCK",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
]);

export function collectCloudCredentials(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (LLM_CRED_DENY.has(k)) continue; // never leak a model-provider key, even if it matches a cloud prefix
    if (CLOUD_CRED_PREFIXES.some((p) => k.startsWith(p)) || CLOUD_CRED_NAMES.has(k)) env[k] = v;
  }
  return env;
}

export const TerraformPlanParams = type({});

export function TerraformPlanTool(ctx: LocalToolContext) {
  return tool({
    name: "terraform_plan",
    description:
      "Run `terraform plan` and report the planned change summary (resources to add / change / destroy), " +
      "any resource that would be DESTROYED or REPLACED, a blast-radius score (how much the fix touches), " +
      "and a plan-stability check (a second plan must match the first — a perpetual-diff smell otherwise). " +
      "Opt-in and degrades green — it auto-skips (returns `ran: false`, never fails the run) when no cloud " +
      "credentials are detected, terraform is not installed, or init/plan can't complete (plan needs live " +
      "provider/backend access). Call it after a fix to attach the real-world effect to the PR and surface " +
      "destructive changes for human review. **Multi-root aware:** it plans EVERY Terraform root in the repo " +
      "(`roots_planned`) and aggregates — counts summed, destructive/blast unioned — so you don't loop " +
      "yourself. Returns `plan_text` (the full human-readable plan(s), for a collapsed <details> block) and " +
      "`needs_human` (true when a high blast radius, a stateful destroy/replace, or a non-deterministic plan " +
      "means a human must review). For an M2 modularization refactor, `refactor_safe: true` is the gate: " +
      "the plan is purely `moved` state operations (every resource address preserved via `moved {}` blocks, " +
      "zero add/change/destroy) — if a modularization PR's plan is NOT refactor_safe, fix the moved blocks " +
      "rather than accepting resource churn.",
    parameters: TerraformPlanParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      if (!hasCloudCredentials()) {
        return skipResult(
          "no_cloud_credentials",
          "no cloud credentials detected — terraform plan needs provider/backend access; skipped (add AWS/Azure/GCP creds or an OIDC role to enable it)",
        );
      }
      // §1.5 — fold the optional module-fetch credential into the plan env so
      // `terraform init` can resolve a private cross-repo `git::` module. The
      // GIT_CONFIG_* keys never collide with the cloud creds.
      const creds = { ...collectCloudCredentials(), ...(resolveModuleFetchEnv(ctx.payload) ?? {}) };

      // multi-root: plan EACH root (hepcare: terraform/ + terraform/core/) and
      // aggregate. resolveRoots falls back to [cwd] for a single-root repo, so
      // behaviour there is identical to before.
      const roots = resolveRoots(cwd);
      const perRoot = roots.map((r) => ({
        dir: r.relDir || ".",
        outcome: planOneRoot(r.absDir, creds),
      }));
      const ran = perRoot.filter((p) => p.outcome.ran);
      if (ran.length === 0) {
        // every root skipped — surface the first reason (e.g. not installed / init failed).
        const reason = perRoot[0]?.outcome.skipReason ?? "no terraform root could be planned";
        const code = reason.includes("not installed")
          ? "terraform_not_installed"
          : reason.includes("init failed")
            ? "terraform_init_failed"
            : "terraform_plan_failed";
        return skipResult(code, `terraform plan skipped — ${reason}`);
      }

      const rootPlans: RootPlan[] = ran.map((p) => ({
        dir: p.dir,
        summary: p.outcome.summary!,
        stable: p.outcome.stable!,
      }));
      const agg = aggregatePlans(rootPlans);
      const classified = classifyDestructive(agg.destructive);
      const blastRadius = computeBlastRadius(agg.changed);
      // record the UNION across roots so the push-time destroy-block guardrail
      // blocks if ANY root would destroy/replace a stateful resource.
      ctx.toolState.plannedDestroy = {
        stateful: classified.stateful,
        ephemeral: classified.ephemeral,
      };
      // §5.19 — record the blast tier + idempotency for the confidence label.
      ctx.toolState.lastBlastTier = blastRadius.tier;
      ctx.toolState.lastIdempotent = agg.idempotent;

      // §1.2 — per-root human-readable plans, headed by root, for the PR <details>.
      const planTextParts = ran
        .filter((p) => p.outcome.planText)
        .map((p) =>
          ran.length > 1 ? `### Root: ${p.dir}\n${p.outcome.planText}` : p.outcome.planText,
        );
      const planText = planTextParts.length
        ? planTextParts.join("\n\n").slice(0, 20_000)
        : undefined;
      const idempotencyWarning = ran.find((p) => !p.outcome.stable)?.outcome.stabilityReason;

      // §2.6 → §3.9 — deterministic escalation to human review.
      const escalationReasons: string[] = [];
      if (blastRadius.tier === "high") {
        escalationReasons.push(
          `high blast radius (${blastRadius.resourceCount} resources / ${blastRadius.modules.length} modules)`,
        );
      }
      if (classified.stateful.length > 0) {
        escalationReasons.push(
          `${classified.stateful.length} stateful resource(s) would be destroyed/replaced`,
        );
      }
      if (!agg.idempotent) escalationReasons.push("non-deterministic plan (perpetual-diff smell)");

      log.info(
        `» terraform_plan: +${agg.add} ~${agg.change} -${agg.destroy} across ${ran.length} root(s) ` +
          `[blast: ${blastRadius.tier}, ${blastRadius.resourceCount} res / ${blastRadius.modules.length} mod]` +
          (agg.hasDestroyOrReplace
            ? ` (DESTRUCTIVE: ${agg.destructive.length}, stateful: ${classified.stateful.length})`
            : "") +
          (agg.idempotent ? "" : " ⚠ UNSTABLE (non-deterministic plan)") +
          (escalationReasons.length ? " ⚠ needs-human" : ""),
      );
      return toolOk({
        ran: true,
        roots_planned: ran.map((p) => p.dir),
        to_add: agg.add,
        to_change: agg.change,
        to_destroy: agg.destroy,
        has_destroy_or_replace: agg.hasDestroyOrReplace,
        destructive: agg.destructive,
        // data-bearing resources that would be lost — these block the push
        // unless allowed via `allow_replace`.
        stateful_destructive: classified.stateful,
        // §2.6 — how much this fix touches; `high` should force human review.
        blast_radius: blastRadius,
        // §1.3 — false when any root's second plan disagreed (perpetual-diff smell).
        idempotent: agg.idempotent,
        idempotency_warning: idempotencyWarning,
        // §M2 — state-only moves and the modularization no-op gate.
        moved_count: agg.moved.length,
        ...(agg.moved.length ? { moved: agg.moved.slice(0, 50) } : {}),
        refactor_safe: isPureMovePlan(agg),
        // §2.6 → §3.9 — deterministic escalation to human review.
        needs_human: escalationReasons.length > 0,
        ...(escalationReasons.length ? { needs_human_reasons: escalationReasons } : {}),
        // §1.2 — full human-readable plan(s) for a collapsed <details> block.
        ...(planText ? { plan_text: planText } : {}),
        // roots where plan couldn't run (no backend creds for that root, etc.).
        ...(perRoot.some((p) => !p.outcome.ran)
          ? {
              roots_skipped: perRoot
                .filter((p) => !p.outcome.ran)
                .map((p) => ({ dir: p.dir, reason: p.outcome.skipReason })),
            }
          : {}),
      });
    }),
  });
}

export const ReadFindingsParams = type({
  "path?": type.string.describe(
    "path to the Assessor's findings.json. Defaults to $TERRAMEND_FINDINGS_PATH, then ./findings.json in the workspace.",
  ),
  "severity_threshold?": type("'critical' | 'high' | 'medium' | 'low' | 'info'").describe(
    "minimum severity to report (default: the run's configured threshold, else low).",
  ),
  "group_by?": type("'file' | 'rule'").describe(
    "'file' (default) makes one group per file; 'rule' groups a single rule across all files into one group (§3.11).",
  ),
});

export function ReadFindingsTool(ctx: LocalToolContext) {
  return tool({
    name: "read_findings",
    description:
      "Load best-practice concerns from a terraform-reviewer (Assessor) findings.json INSTEAD of running " +
      "the scanners. Returns the SAME { concerns, groups, summary } shape as terraform_scan, so Remediate " +
      "consumes it identically. `human_only` findings and non-Terraform files are dropped. Concerns from " +
      "checkov / tflint / terraform-fmt re-verify deterministically (✗→✓); findings exclusive to the reviewer " +
      "(tfsec / infracost / llm) carry source `reviewer` and can't be reproduced by Terramend's scanners, so " +
      "terraform_verify_remediation will report them unresolved — rely on terraform_validate + your explanation " +
      "for those. Returns `found: false` (never an error) when no findings.json is present.",
    parameters: ReadFindingsParams,
    execute: execute(async ({ path, severity_threshold, group_by }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      // SECURITY: confine the agent-supplied `path` to the workspace so it can't
      // be used as an arbitrary file-read primitive. The env-var fallback is
      // operator-controlled (not agent-controlled), so it stays unconfined.
      const findingsPath = path
        ? resolveWithinCwd(cwd, path)
        : process.env.TERRAMEND_FINDINGS_PATH || join(cwd, "findings.json");
      let raw: string;
      try {
        raw = readFileSync(findingsPath, "utf8");
      } catch {
        return skipResult(
          "findings_not_found",
          `no findings.json at ${findingsPath} (set the path arg or $TERRAMEND_FINDINGS_PATH)`,
          { key: "found", reasonKey: "reason", extra: { concerns: [], groups: [] } },
        );
      }
      let parsed: Concern[];
      try {
        // accept BOTH a terraform-reviewer findings.json AND a standard SARIF
        // report (Trivy/Checkov/tflint -o sarif) — the dispatcher detects which.
        parsed = parseFindingsFile(raw, cwd);
      } catch {
        return skipResult(
          "findings_parse_error",
          `could not parse findings file at ${findingsPath}`,
          {
            key: "found",
            reasonKey: "reason",
            extra: { concerns: [], groups: [] },
          },
        );
      }

      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";
      const minRank = SEVERITY_RANK[threshold];

      // §1.4 baseline — same role as terraform_scan's, so a regression check
      // after a reviewer-sourced fix has a baseline to diff against. Store ids +
      // line-independent keys (verify diffs on the keys).
      const fullBaseline = dedupe(parsed);
      ctx.toolState.baselineConcernIds = fullBaseline.map((c) => c.id);
      ctx.toolState.baselineConcernKeys = fullBaseline.map((c) => concernKeyOf(c));

      const all = sortConcerns(dedupe(parsed))
        .filter(isTerraformConcern)
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank);
      // §3.9 + §3.11 — group (by-file or by-rule) and annotate autonomy, exactly
      // as terraform_scan does, so the rest of the Remediate checklist is
      // source-agnostic.
      const grouping = group_by ?? "file";
      const autonomyThreshold = (ctx.payload.autonomyThreshold as Severity | undefined) ?? "high";
      const groups = annotateGroups(
        grouping === "rule" ? groupConcernsByRule(all) : groupConcerns(all),
        all,
        autonomyThreshold,
      );
      const batchPlan = planBatches(groups);
      const by_severity: Record<string, number> = {};
      for (const c of all) by_severity[c.severity] = (by_severity[c.severity] ?? 0) + 1;

      log.info(
        `» read_findings: ${all.length} concern(s) ≥ ${threshold} from ${findingsPath} (${groups.length} ${grouping}-group(s))`,
      );

      return toolOk({
        found: true,
        source_file: findingsPath,
        grouping,
        summary: { total: all.length, groups: groups.length, by_severity },
        groups: groups.map((g) => ({ ...g, doc_urls: docUrlsForGroup(g, all) })),
        batch_plan: batchPlan,
        concerns: all.map((c) => ({ ...c, doc_url: ruleDocUrl(c) })),
      });
    }),
  });
}

export const TerraformVersionCurrencyParams = type({});

export function TerraformVersionCurrencyTool(ctx: LocalToolContext) {
  return tool({
    name: "terraform_version_currency",
    description:
      "Check the workspace's pinned providers and registry modules against the Terraform Registry's " +
      "published versions — the upgrade intelligence no scanner provides (tflint checks pins EXIST, not " +
      "that they're current). Reports per provider/module the written constraint, the `latest` stable " +
      "version, the newest version the constraint admits, and `outdated`/`majors_behind`; registry " +
      "modules with no version pin are flagged `unpinned` (pin them to `latest`). Remediation contract " +
      "(M3): one `chore(deps)` PR per upgrade group; minor/patch bumps may proceed autonomously; a MAJOR " +
      "bump means the module/provider interface may have changed — apply it only with a `needs-human` " +
      "label, and re-verify every bump with terraform_validate (plus terraform_plan when credentials " +
      "exist; an upgrade that plans destructive changes is never auto). Network-dependent and degrades " +
      "green: per-source lookup failures are reported per row, and an unreachable registry returns " +
      "`ok: false` with code `registry_unreachable` (never an error).",
    parameters: TerraformVersionCurrencyParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const report = await checkVersionCurrency(cwd);
      if (report.lookups_attempted === 0) {
        return toolOk({
          providers: [],
          modules: [],
          outdated_count: 0,
          unpinned_count: 0,
          note: "no provider requirements or registry modules found in the workspace",
        });
      }
      if (report.lookups_failed === report.lookups_attempted) {
        return skipResult(
          "registry_unreachable",
          `all ${report.lookups_attempted} registry lookup(s) failed — registry.terraform.io unreachable from this runner; currency not checked`,
        );
      }
      log.info(
        `» terraform_version_currency: ${report.outdated_count} outdated, ${report.unpinned_count} unpinned ` +
          `across ${report.providers.length} provider(s) + ${report.modules.length} registry module(s)` +
          (report.lookups_failed ? ` (${report.lookups_failed} lookup(s) failed)` : ""),
      );
      return toolOk({
        providers: report.providers,
        modules: report.modules,
        outdated_count: report.outdated_count,
        unpinned_count: report.unpinned_count,
        ...(report.lookups_failed > 0
          ? { note: `${report.lookups_failed} lookup(s) failed — those rows report lookup != "ok"` }
          : {}),
      });
    }),
  });
}
