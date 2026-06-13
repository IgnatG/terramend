/**
 * Unified tool-selection config (§1.5 "unified tool-selection config") + the
 * non-permissive-tool confirmation gate (§1.5, built on [[toolLicensing]]).
 *
 * One declarative `tools_enabled` list replaces the previous mix of per-flag
 * inputs and silent presence-detection: an operator names the scanners/engines
 * they want, prefixing `-` to turn one off. The same list is how a non-permissive
 * tool (tflint, terraform-mcp-server) is opted into — naming it is the explicit,
 * licence-aware acknowledgement the gate requires.
 *
 * Resolution precedence, per tool (highest first):
 *   1. the required substrate (`terraform`)  → ON  (exempt; never disablable)
 *   2. an explicit `-tool` in the list       → OFF (always wins over the rest)
 *   3. an explicit `tool` / `+tool`          → ON  (this is the licence opt-in)
 *   4. `all` base                            → ON  (operator accepts every tool)
 *   5. `none` base                           → only the explicitly/flag-enabled
 *   6. default base:
 *        - licence-gated tool  → ON only if its dedicated flag is set, else OFF
 *        - flag-opt-in tool    → ON only if its dedicated flag is set, else OFF
 *        - permissive tool     → ON
 *
 * The dedicated booleans (`gitleaks`, `terratest`, `terraform_mcp`) still work
 * and count as an opt-in, so existing workflows keep running unchanged. Pure.
 */

import { isLicenseGated, isPermissive, TOOL_LICENSES, type ToolId } from "#app/utils/toolLicensing";

/** the parsed `tools_enabled` input: a base posture + per-tool overrides. */
export interface ToolDirective {
  /** `all` (enable everything) / `none` (enable nothing) / undefined (defaults). */
  base?: "all" | "none" | undefined;
  /** explicit per-tool overrides: true = enable, false = disable. */
  explicit: Map<ToolId, boolean>;
  /** tokens that matched no known tool — surfaced as a warning, never fatal. */
  unknown: string[];
}

/** the dedicated booleans that pre-date the unified list. */
export interface ToolSelectionFlags {
  toolsEnabled?: ToolDirective | undefined;
  gitleaks?: boolean;
  terratest?: boolean;
  terraformMcp?: boolean;
}

/**
 * Permissive tools that still default OFF — not for licence reasons but because
 * each is an extra/heavier engine (or writes extra files) the operator opts into
 * via its dedicated input. Listing keeps their long-standing behaviour intact
 * while the unified list can also enable/disable them.
 */
const FLAG_OPT_IN: ReadonlySet<ToolId> = new Set<ToolId>(["gitleaks", "terratest"]);

/** map a token to a canonical tool id (case-insensitive; common spellings). */
const TOKEN_ALIASES: Readonly<Record<string, ToolId>> = {
  terraform: "terraform",
  tf: "terraform",
  "terraform-fmt": "terraform",
  "terraform-validate": "terraform",
  tflint: "tflint",
  trivy: "trivy",
  checkov: "checkov",
  infracost: "infracost",
  cost: "infracost",
  gitleaks: "gitleaks",
  conftest: "conftest",
  opa: "conftest",
  policy: "conftest",
  terratest: "terratest",
  terraform_mcp: "terraform_mcp",
  "terraform-mcp": "terraform_mcp",
  "terraform-mcp-server": "terraform_mcp",
} as const;

/**
 * Parse the `tools_enabled` input (comma- or newline-separated). Recognises the
 * `all` / `none` bases and `tool` / `+tool` / `-tool` (also `!tool`) overrides.
 * Returns undefined for an empty input so "unset" stays distinguishable from an
 * explicit list (the consumer then applies the licence-aware defaults).
 */
export function parseToolSelection(raw: string | undefined): ToolDirective | undefined {
  if (!raw?.trim()) return undefined;
  const explicit = new Map<ToolId, boolean>();
  const unknown: string[] = [];
  let base: "all" | "none" | undefined;

  for (const token of raw.split(/[\n,]/)) {
    const tok = token.trim();
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (lower === "all" || lower === "*") {
      base = "all";
      continue;
    }
    if (lower === "none") {
      base = "none";
      continue;
    }
    let enable = true;
    let name = lower;
    if (name.startsWith("-") || name.startsWith("!")) {
      enable = false;
      name = name.slice(1).trim();
    } else if (name.startsWith("+")) {
      name = name.slice(1).trim();
    }
    const id = TOKEN_ALIASES[name];
    if (!id) {
      unknown.push(tok);
      continue;
    }
    explicit.set(id, enable);
  }
  return { base, explicit, unknown };
}

function flagFor(id: ToolId, flags: ToolSelectionFlags): boolean {
  switch (id) {
    case "gitleaks":
      return !!flags.gitleaks;
    case "terratest":
      return !!flags.terratest;
    case "terraform_mcp":
      return !!flags.terraformMcp;
    default:
      return false;
  }
}

interface Verdict {
  on: boolean;
  /** why a tool is OFF (for reporting); undefined when ON. */
  reason?: string;
}

function decide(id: ToolId, flags: ToolSelectionFlags): Verdict {
  const dir = flags.toolsEnabled;
  const explicit = dir?.explicit.get(id);

  // 1. the required substrate is the engine's reason to exist — never gated,
  // never disablable (a Terraform fixer always has Terraform).
  if (TOOL_LICENSES[id].required) return { on: true };
  // 2. an explicit disable always wins.
  if (explicit === false) return { on: false, reason: "disabled via tools_enabled" };
  // 3. an explicit enable is the licence-aware opt-in.
  if (explicit === true) return { on: true };
  // 4 / 5. an `all` / `none` base.
  if (dir?.base === "all") return { on: true };
  if (dir?.base === "none") {
    return flagFor(id, flags)
      ? { on: true }
      : { on: false, reason: "not in the tools_enabled allow-list" };
  }
  // 6. licence-aware defaults.
  if (isLicenseGated(id)) {
    if (flagFor(id, flags)) return { on: true };
    const { license, name } = TOOL_LICENSES[id];
    return {
      on: false,
      reason: `licence-gated (${name}, ${license}) — enable explicitly by naming "${id}" in tools_enabled`,
    };
  }
  if (FLAG_OPT_IN.has(id)) {
    return flagFor(id, flags)
      ? { on: true }
      : { on: false, reason: `opt-in — set the ${id} input or name "${id}" in tools_enabled` };
  }
  // permissive default-on (subject to the tool's own runtime presence checks).
  return { on: true };
}

/** the resolved selection for a run — a deterministic verdict per tool. */
export interface ResolvedToolSelection {
  enabled(id: ToolId): boolean;
  /** the reason a tool is OFF (for the scan report / logs); undefined when ON. */
  offReason(id: ToolId): string | undefined;
  /** licence-gated tools that are OFF because they weren't opted into. */
  gated: ToolId[];
  /** tools explicitly turned off via `tools_enabled`. */
  disabled: ToolId[];
  /** unrecognised `tools_enabled` tokens (warn, never fatal). */
  unknownTokens: string[];
}

/**
 * Resolve the per-tool selection from the run's payload (the parsed
 * `tools_enabled` directive + the dedicated booleans). Pure; safe to call from
 * any consumer (the scan tool, the secret guardrail, the terraform-mcp resolver,
 * the plan tool) so they all agree on which tools may run this run.
 */
export function resolveToolSelection(flags: ToolSelectionFlags): ResolvedToolSelection {
  const verdicts = new Map<ToolId, Verdict>();
  const gated: ToolId[] = [];
  const disabled: ToolId[] = [];
  for (const id of Object.keys(TOOL_LICENSES) as ToolId[]) {
    const verdict = decide(id, flags);
    verdicts.set(id, verdict);
    if (verdict.on) continue;
    if (flags.toolsEnabled?.explicit.get(id) === false) disabled.push(id);
    else if (isLicenseGated(id)) gated.push(id);
  }
  return {
    enabled: (id) => verdicts.get(id)?.on ?? false,
    offReason: (id) => verdicts.get(id)?.reason,
    gated,
    disabled,
    unknownTokens: flags.toolsEnabled?.unknown ?? [],
  };
}

/** map a `terraform_scan` scanner source to the tool id it belongs to (null for
 * the `reviewer` pseudo-source, which the gate never governs). */
export function scannerToolId(source: string): ToolId | null {
  switch (source) {
    case "terraform-fmt":
    case "terraform-validate":
      return "terraform";
    case "tflint":
      return "tflint";
    case "trivy":
      return "trivy";
    case "checkov":
      return "checkov";
    default:
      return null;
  }
}

export type { ToolId };
// re-exported so callers need only this module for the common path.
export { isPermissive, TOOL_LICENSES };
