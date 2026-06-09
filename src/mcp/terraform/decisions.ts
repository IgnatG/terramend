import { createHash } from "node:crypto";
import type { CostDelta } from "#app/mcp/terraform/cost";
import {
  type Autonomy,
  type BlastTier,
  type Concern,
  type ConcernGroup,
  SEVERITY_RANK,
  type Severity,
} from "#app/mcp/terraform/types";

// --- grouping --------------------------------------------------------------

function groupId(file: string): string {
  return createHash("sha1").update(`group|${file}`).digest("hex").slice(0, 12);
}

function ruleGroupId(ruleId: string): string {
  return createHash("sha1").update(`rulegroup|${ruleId}`).digest("hex").slice(0, 12);
}

function maxSeverity(cs: Concern[]): Severity {
  return cs.reduce<Severity>(
    (max, c) => (SEVERITY_RANK[c.severity] > SEVERITY_RANK[max] ? c.severity : max),
    "info",
  );
}

function sortGroups(groups: ConcernGroup[]): ConcernGroup[] {
  return groups.sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    return a.id.localeCompare(b.id);
  });
}

/** group concerns by file into scoped units, sorted by max severity. */
export function groupConcerns(concerns: Concern[]): ConcernGroup[] {
  const byFile = new Map<string, Concern[]>();
  for (const c of concerns) {
    const arr = byFile.get(c.location.file) ?? [];
    arr.push(c);
    byFile.set(c.location.file, arr);
  }
  const groups: ConcernGroup[] = [];
  for (const [file, cs] of byFile) {
    groups.push({
      id: groupId(file),
      file,
      files: [file],
      grouping: "file",
      severity: maxSeverity(cs),
      concern_count: cs.length,
      rule_ids: [...new Set(cs.map((c) => c.rule_id))].sort(),
      concern_ids: cs.map((c) => c.id),
    });
  }
  return sortGroups(groups);
}

/**
 * §3.11 — group concerns by RULE across files instead of by file. When a single
 * rule fires in many files ("add `tags` to every resource", "enable encryption
 * on every bucket"), fixing it as ONE coherent change is far better than N
 * near-identical per-file PRs. Each group covers one `rule_id` and lists every
 * `file` it spans; the branch key (`remediate/<id>`) is rule-derived and stable.
 * Opt-in (scan `group_by: "rule"`) — by-file stays the default because it keeps
 * each PR's blast radius smaller; by-rule suits sweeping, low-risk rules.
 */
export function groupConcernsByRule(concerns: Concern[]): ConcernGroup[] {
  const byRule = new Map<string, Concern[]>();
  for (const c of concerns) {
    const arr = byRule.get(c.rule_id) ?? [];
    arr.push(c);
    byRule.set(c.rule_id, arr);
  }
  const groups: ConcernGroup[] = [];
  for (const [ruleId, cs] of byRule) {
    const files = [...new Set(cs.map((c) => c.location.file))].sort();
    groups.push({
      id: ruleGroupId(ruleId),
      file: files.length === 1 ? files[0] : `${files.length} files`,
      files,
      grouping: "rule",
      severity: maxSeverity(cs),
      concern_count: cs.length,
      rule_ids: [ruleId],
      concern_ids: cs.map((c) => c.id),
    });
  }
  return sortGroups(groups);
}

/**
 * §3.9 — annotate each group with an autonomy decision. Works for BOTH grouping
 * modes: it resolves a group's concerns by `concern_ids` membership (not by
 * `file`, which is just a label for by-rule groups), so the severity/category
 * policy applies identically. Blast radius isn't known until terraform_plan
 * runs, so it can only escalate a group later (the plan tool + prompt apply the
 * `high`-blast override); at scan time autonomy is severity/category-driven.
 */
export function annotateGroups(
  groups: ConcernGroup[],
  all: Concern[],
  threshold: Severity,
): ConcernGroup[] {
  const byId = new Map(all.map((c) => [c.id, c]));
  return groups.map((g) => {
    const groupConcerns = g.concern_ids.map((id) => byId.get(id)).filter((c): c is Concern => !!c);
    const decision = classifyAutonomy(groupConcerns, threshold);
    return { ...g, autonomy: decision.autonomy, autonomy_reasons: decision.reasons };
  });
}

// --- §3.10 atomic vs batched PRs -------------------------------------------

export interface BatchPlan {
  /** group ids safe to combine into ONE low-risk PR (`remediate/batch-<hash>`). */
  batchable: string[];
  /** group ids that must each get their own PR (security / higher severity /
   * needs-human / large blast). */
  isolated: string[];
  /** deterministic branch name for the batch (stable for the same member set). */
  batch_branch: string | null;
}

/** a group is safe to batch when it's low-risk: severity `low`/`info` AND its
 * autonomy decision is `auto` (no escalating security finding, no high blast). */
function isBatchable(g: ConcernGroup): boolean {
  const lowRisk = g.severity === "low" || g.severity === "info";
  return lowRisk && g.autonomy !== "needs-human";
}

/**
 * §3.10 — split annotated groups into a single low-risk BATCH (merged into one
 * easy-to-review PR) and the riskier groups that each stay ISOLATED in their own
 * PR (so they can be reviewed/reverted independently). The batch branch name
 * hashes the sorted member ids, so re-runs over the same set reuse the branch
 * (idempotent). Returns `batch_branch: null` when fewer than two groups are
 * batchable (one group is just a normal single-group PR, not a batch).
 */
export function planBatches(groups: ConcernGroup[]): BatchPlan {
  const batchable = groups
    .filter(isBatchable)
    .map((g) => g.id)
    .sort();
  const isolated = groups
    .filter((g) => !isBatchable(g))
    .map((g) => g.id)
    .sort();
  const batch_branch =
    batchable.length >= 2
      ? `remediate/batch-${createHash("sha1").update(batchable.join("|")).digest("hex").slice(0, 12)}`
      : null;
  return { batchable, isolated, batch_branch };
}

// --- §5.17 per-finding explanation (rule documentation links) --------------

/**
 * Resolve the canonical documentation URL for a concern's rule, for the PR's
 * per-finding explanation. Prefers the scanner's own `remediation_hint` when it
 * is already a URL (checkov guideline, tflint rule link, trivy reference).
 * Otherwise derives the well-known page deterministically: a trivy `AVD-*` rule
 * maps to its Aqua Vulnerability Database page. Returns null when no canonical
 * URL is known (the agent then explains from `evidence` alone).
 */
export function ruleDocUrl(concern: Pick<Concern, "rule_id" | "remediation_hint">): string | null {
  const hint = concern.remediation_hint?.trim();
  if (hint && /^https?:\/\//i.test(hint)) return hint;
  // trivy:AVD-AWS-0088 → https://avd.aquasec.com/misconfig/avd-aws-0088
  const trivyMatch = concern.rule_id.match(/^trivy:(AVD-[A-Z0-9-]+)$/i);
  if (trivyMatch) return `https://avd.aquasec.com/misconfig/${trivyMatch[1].toLowerCase()}`;
  return null;
}

/** distinct rule→doc-url map for a group, for the PR body's per-finding links. */
export function docUrlsForGroup(g: ConcernGroup, all: Concern[]): Record<string, string> {
  const byId = new Map(all.map((c) => [c.id, c]));
  const out: Record<string, string> = {};
  for (const id of g.concern_ids) {
    const c = byId.get(id);
    if (!c) continue;
    const url = ruleDocUrl(c);
    if (url) out[c.rule_id] = url;
  }
  return out;
}

// --- severity-driven autonomy (§3.9) ---------------------------------------

export interface AutonomyDecision {
  autonomy: Autonomy;
  /** human-readable reasons a group was escalated (empty for `auto`). */
  reasons: string[];
}

/**
 * Decide whether a group of concerns can be auto-fixed and opened as a normal
 * PR (`auto`), or must be flagged for human review (`needs-human`). Trivial
 * findings (style/correctness, deprecated args, missing tags, formatting) open
 * as normal; high-severity SECURITY findings escalate by default, as does a
 * `high` blast radius regardless of finding severity (§2.6 overrides upward).
 *
 * `threshold` is the minimum severity at which a *security* concern escalates
 * (default `high`, so critical/high security → human; medium/low → auto). The
 * decision is deterministic and computed from the `Concern` model's existing
 * `severity` + `category` — no model self-assessment.
 */
export function classifyAutonomy(
  concerns: Pick<Concern, "severity" | "category">[],
  threshold: Severity = "high",
  blastTier?: BlastTier,
): AutonomyDecision {
  const reasons: string[] = [];
  const minRank = SEVERITY_RANK[threshold];
  const escalating = concerns.filter(
    (c) => c.category === "security" && SEVERITY_RANK[c.severity] >= minRank,
  );
  if (escalating.length > 0) {
    const top = escalating.reduce((max, c) =>
      SEVERITY_RANK[c.severity] > SEVERITY_RANK[max.severity] ? c : max,
    );
    reasons.push(
      `${escalating.length} security concern(s) at/above the ${threshold} autonomy threshold (highest: ${top.severity})`,
    );
  }
  if (blastTier === "high") {
    reasons.push(
      "high blast radius — the fix touches more than 10 resources or spans more than one module",
    );
  }
  return { autonomy: reasons.length > 0 ? "needs-human" : "auto", reasons };
}

// --- inline suggested changes (§5.18) --------------------------------------

export interface SuggestionDecision {
  /** true ⇒ post a GitHub one-click `suggestion` instead of opening a full PR. */
  suggest: boolean;
  reason: string;
}

/**
 * §5.18 — decide whether a fix is small/low-risk enough to post as a GitHub
 * one-click **suggested change** (a ` ```suggestion ` block on the existing PR)
 * rather than opening a whole `remediate/*` branch + PR. Much lower friction for
 * trivial fixes. Only when ALL hold: there IS an existing PR context (a comment
 * trigger on a PR); the group is `low`/`info` severity; the fix is a single hunk
 * in a single file; and the blast radius (when known) is `low`. Anything bigger
 * keeps full-PR mode.
 */
export function shouldSuggestInline(opts: {
  hasPrContext: boolean;
  severity: Severity;
  fileCount: number;
  hunkCount: number;
  blastTier?: BlastTier | undefined;
}): SuggestionDecision {
  if (!opts.hasPrContext)
    return { suggest: false, reason: "no existing PR to attach a suggestion to" };
  if (opts.severity !== "low" && opts.severity !== "info") {
    return {
      suggest: false,
      reason: `severity ${opts.severity} warrants a reviewable PR, not a one-click suggestion`,
    };
  }
  if (opts.fileCount > 1 || opts.hunkCount > 1) {
    return { suggest: false, reason: "multi-hunk / multi-file fix — open a full PR" };
  }
  if (opts.blastTier === "high" || opts.blastTier === "medium") {
    return { suggest: false, reason: `blast radius ${opts.blastTier} — open a full PR` };
  }
  return {
    suggest: true,
    reason: "single-hunk low-risk fix on an existing PR — post as a one-click suggestion",
  };
}

// --- confidence labeling (§5.19) -------------------------------------------

export type Confidence = "high" | "medium" | "low";

export interface ConfidenceSignals {
  /** §1.1 — every targeted concern id was cleared by the re-scan. */
  verified: boolean;
  /** §1.4 — count of NEW concern ids the fix introduced (0 is good). */
  regressionCount: number;
  /** §1.3 — second plan matched the first. undefined when plan didn't run. */
  idempotent?: boolean | undefined;
  /** §2.6 — blast tier. undefined when plan didn't run. */
  blastTier?: BlastTier | undefined;
  /** §4.16 — cost direction. undefined when infracost didn't run. */
  costDirection?: CostDelta["direction"] | undefined;
}

export interface ConfidenceResult {
  level: Confidence;
  reasons: string[];
}

/**
 * Derive a fix's confidence DETERMINISTICALLY from the verification evidence
 * already gathered — never a model self-assessment, which keeps it honest.
 *
 * - A fix that didn't verify (§1.1) or introduced a regression (§1.4) is `low`:
 *   the proof failed, full stop.
 * - Otherwise it starts `high` and is capped to `medium` by any weaker signal:
 *   a non-deterministic plan (§1.3 `idempotent: false`), a `high` blast radius
 *   (§2.6), a cost increase (§4.16), or a signal that was *skipped* (plan /
 *   infracost didn't run, so we have less proof — `high` requires the full
 *   stack). A skipped signal lowers confidence but does not, by itself, make a
 *   verified, regression-free fix `low`.
 */
export function computeConfidence(signals: ConfidenceSignals): ConfidenceResult {
  const reasons: string[] = [];
  if (!signals.verified) {
    return {
      level: "low",
      reasons: ["the re-scan did not confirm every targeted concern was resolved (§1.1)"],
    };
  }
  if (signals.regressionCount > 0) {
    return {
      level: "low",
      reasons: [`the fix introduced ${signals.regressionCount} new concern(s) (§1.4 regression)`],
    };
  }
  reasons.push(
    "re-scan verified every targeted concern resolved (§1.1) with no regressions (§1.4)",
  );

  let level: Confidence = "high";
  const capMedium = (reason: string) => {
    if (level === "high") level = "medium";
    reasons.push(reason);
  };
  if (signals.idempotent === false)
    capMedium("plan is non-deterministic (§1.3) — a perpetual-diff smell");
  if (signals.blastTier === "high") capMedium("high blast radius (§2.6) — review carefully");
  if (signals.costDirection === "increase") capMedium("the fix increases monthly cost (§4.16)");
  if (signals.idempotent === undefined || signals.blastTier === undefined) {
    capMedium(
      "no terraform plan evidence (no cloud credentials) — idempotency and blast radius unproven",
    );
  }
  if (signals.costDirection === undefined) {
    capMedium("no cost evidence (infracost did not run)");
  }
  return { level, reasons };
}

// --- honest refusal (§29) --------------------------------------------------

export interface RefusalDecision {
  /** true ⇒ this concern needs a human decision; prefer a structured non-fix
   * (an issue) over guessing a fix that could break the stack. */
  refuse: boolean;
  reason?: string;
}

// concern signatures whose correct fix needs information only a human has —
// auto-"fixing" them risks a narrow policy that breaks the stack or a wrong
// value. Matched against the rule id + evidence text (lower-cased).
const HUMAN_DECISION_SIGNATURES: { test: RegExp; reason: string }[] = [
  {
    test: /least[\s_-]?privilege|wildcard|iam.*("\*"|\*\s*action|action.*\*)|policy.*allows? all/i,
    reason:
      "narrowing an IAM policy needs the exact action/resource set the workload uses — a human decision",
  },
  {
    test: /\bkms\b.*\bpolicy\b|key[\s_-]?policy|cmk.*polic/i,
    reason: "a KMS/CMK key policy needs the real principals and grants — a human decision",
  },
  {
    test: /allowed?[\s_-]?cidr|restrict.*cidr|specify.*cidr|known.*ip|real.*source/i,
    reason: "tightening an ingress CIDR needs the real allowed source — a human decision",
  },
];

/**
 * §29 — advisory check: would auto-fixing this concern require a judgement only
 * a human can make? If so, the Remediate flow should post a STRUCTURED refusal
 * (an issue describing the concern, why it won't auto-fix, and what a human
 * should do) rather than guess a fix that could break the stack. Deterministic
 * and conservative — it only flags the well-known human-decision classes.
 */
export function classifyRefusal(concern: Pick<Concern, "rule_id" | "evidence">): RefusalDecision {
  const text = `${concern.rule_id} ${concern.evidence}`.toLowerCase();
  for (const sig of HUMAN_DECISION_SIGNATURES) {
    if (sig.test.test(text)) return { refuse: true, reason: sig.reason };
  }
  return { refuse: false };
}

/**
 * §29 — format a structured non-fix for a concern Terramend won't auto-fix. The
 * output is a Markdown issue body: what's wrong, why it isn't auto-fixed, and
 * the concrete next step for a human. Pure (string in → string out).
 */
export function buildRefusalReport(input: {
  concern: Pick<Concern, "rule_id" | "evidence" | "location">;
  whyNoAutoFix: string;
  humanAction: string;
}): string {
  const { concern, whyNoAutoFix, humanAction } = input;
  const loc = `${concern.location.file}${concern.location.line ? `:${concern.location.line}` : ""}`;
  return [
    `### Terramend won't auto-fix \`${concern.rule_id}\` (needs a human decision)`,
    "",
    `**Where:** \`${loc}\``,
    "",
    `**What's wrong:** ${concern.evidence}`,
    "",
    `**Why it isn't auto-fixed:** ${whyNoAutoFix}`,
    "",
    `**What a human should do:** ${humanAction}`,
    "",
    "_Terramend opens a PR only when it can prove the fix is correct; for this concern it can't, so it's surfaced here instead of guessing._",
  ].join("\n");
}

// --- fix once, prevent forever (§21) ---------------------------------------

export interface PreventiveControl {
  /** the mechanism that stops this class of concern recurring. */
  mechanism: string;
  /** a copy-pasteable config/CI snippet. */
  snippet: string;
  note: string;
}

/**
 * §21 — alongside the patch, suggest the guardrail that stops the concern
 * RECURRING: a CI gate keyed on the producing scanner. Deterministic by source
 * (the scanner is the right enforcement point), parameterised by the rule id.
 * Returns null for sources with no natural preventive gate.
 */
export function preventiveControlFor(
  concern: Pick<Concern, "source" | "rule_id">,
): PreventiveControl | null {
  // strip only the leading `<source>:` namespace (not every colon) so a rule
  // name that itself contains a colon survives intact.
  const prefix = `${concern.source}:`;
  const bareRule = concern.rule_id.startsWith(prefix)
    ? concern.rule_id.slice(prefix.length)
    : concern.rule_id;
  switch (concern.source) {
    case "checkov":
      return {
        mechanism: "Checkov hard-fail in CI",
        snippet: `# .checkov.yaml\nhard-fail-on:\n  - ${bareRule}`,
        note: `Add ${bareRule} to a Checkov hard-fail list so a PR that reintroduces it fails CI.`,
      };
    case "trivy":
      return {
        mechanism: "Trivy config scan gate in CI",
        snippet: `# CI step\ntrivy config --exit-code 1 --severity HIGH,CRITICAL .`,
        note: `Gate PRs on \`trivy config\` so ${bareRule} (and peers) can't be reintroduced.`,
      };
    case "tflint":
      return {
        mechanism: "tflint rule enforced in CI",
        snippet: `# .tflint.hcl\nrule "${bareRule}" {\n  enabled = true\n}`,
        note: `Enable ${bareRule} in \`.tflint.hcl\` and run \`tflint\` in CI.`,
      };
    case "terraform-fmt":
      return {
        mechanism: "terraform fmt check in CI",
        snippet: `# CI step\nterraform fmt -check -recursive`,
        note: "Gate PRs on `terraform fmt -check` so formatting can't drift.",
      };
    case "terraform-validate":
      return {
        mechanism: "terraform validate in CI",
        snippet: `# CI step\nterraform validate`,
        note: "Run `terraform validate` in CI so this correctness error can't return.",
      };
    default:
      return null;
  }
}

// --- cross-tool co-location (§30) ------------------------------------------

export interface LocationCluster {
  file: string;
  line: number | null;
  /** the concern ids at this exact location (likely the same underlying defect). */
  concern_ids: string[];
  /** the distinct scanners that flagged this location. */
  sources: string[];
}

/**
 * §30 — surface concerns that DIFFERENT scanners flagged at the same `file:line`
 * — almost always the same underlying defect (trivy ∩ checkov overlap heavily on
 * e.g. S3 encryption). Reported so the agent writes ONE canonical fix + ONE
 * explanation for the cluster rather than treating each as separate work. This
 * is purely advisory: it NEVER removes a concern from the verification set (a
 * missing id must still provably clear), so it can't drop a real finding. Only
 * clusters spanning more than one scanner are returned.
 */
export function clusterByLocation(concerns: Concern[]): LocationCluster[] {
  const byLoc = new Map<string, Concern[]>();
  for (const c of concerns) {
    if (c.location.line == null) continue; // a null line isn't a precise co-location
    const key = `${c.location.file}|${c.location.line}`;
    const arr = byLoc.get(key) ?? [];
    arr.push(c);
    byLoc.set(key, arr);
  }
  const clusters: LocationCluster[] = [];
  for (const cs of byLoc.values()) {
    const sources = [...new Set(cs.map((c) => c.source))].sort();
    if (sources.length < 2) continue; // single-scanner location isn't cross-tool overlap
    clusters.push({
      file: cs[0].location.file,
      line: cs[0].location.line,
      concern_ids: cs.map((c) => c.id).sort(),
      sources,
    });
  }
  return clusters.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
}
