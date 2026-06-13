/**
 * Tool-licence classification (§5 dependency posture; §1.5 "non-permissive-tool
 * confirmation gate").
 *
 * Terramend ORCHESTRATES external tools — it never bundles or redistributes
 * their binaries (§5 "be an orchestrator, not a redistributor"). This module
 * makes the licence of every selectable tool explicit so the engine can DEFAULT
 * to the permissively-licensed tools and treat a non-permissive one (tflint's
 * embedded BUSL Terraform fork, HashiCorp's terraform-mcp-server) as an
 * *informed, named opt-in* rather than something whose output is consumed
 * silently. Pure data + pure predicates — the gate that consumes it lives in
 * [[toolSelection]].
 */

/** every external tool the engine can be configured to run. */
export type ToolId =
  | "terraform"
  | "tflint"
  | "trivy"
  | "checkov"
  | "infracost"
  | "gitleaks"
  | "conftest"
  | "terratest"
  | "terraform_mcp";

/**
 * Coarse licence family the gate reasons about:
 *   - `permissive`     — MIT / Apache-2.0 / BSD / ISC: default-enabled.
 *   - `copyleft`       — MPL / (L)GPL / AGPL: gated (explicit opt-in).
 *   - `source-available` — BUSL / SSPL / Elastic: gated (explicit opt-in).
 */
export type LicenseClass = "permissive" | "copyleft" | "source-available";

export interface ToolLicense {
  id: ToolId;
  /** display name for logs / PR notes. */
  name: string;
  /** human-facing SPDX-ish identifier (shown, never parsed). */
  license: string;
  class: LicenseClass;
  /**
   * The core Terraform CLI is the SUBSTRATE the engine cannot run without and
   * which the operator installs themselves — invoking it is never
   * redistribution. It is licence-classified for honesty (Terraform moved to
   * BUSL-1.1 at v1.6) but EXEMPT from the opt-in gate, so a Terraform fixer
   * always has Terraform.
   */
  required?: boolean;
}

/**
 * The single source of truth for what each tool is licensed under. Verified
 * against the §5 "third-party dependency posture" note (June 2026). Keep in sync
 * when a tool's licence changes (e.g. a vendor relicensing event).
 */
export const TOOL_LICENSES: Readonly<Record<ToolId, ToolLicense>> = {
  terraform: {
    id: "terraform",
    name: "Terraform CLI",
    license: "BUSL-1.1",
    class: "source-available",
    required: true,
  },
  // tflint is MPL-2.0, but it embeds a BUSL Terraform fork — §5 flags it as the
  // canonical "never bundle/redistribute; invoke as an external process" case.
  tflint: { id: "tflint", name: "TFLint", license: "MPL-2.0", class: "copyleft" },
  trivy: { id: "trivy", name: "Trivy", license: "Apache-2.0", class: "permissive" },
  checkov: { id: "checkov", name: "Checkov", license: "Apache-2.0", class: "permissive" },
  infracost: { id: "infracost", name: "Infracost CLI", license: "Apache-2.0", class: "permissive" },
  gitleaks: { id: "gitleaks", name: "gitleaks", license: "MIT", class: "permissive" },
  conftest: { id: "conftest", name: "Conftest (OPA)", license: "Apache-2.0", class: "permissive" },
  terratest: { id: "terratest", name: "Terratest", license: "Apache-2.0", class: "permissive" },
  // HashiCorp's terraform-mcp-server, run as a Docker image — a redistribution-
  // sensitive HashiCorp surface, so it is gated like tflint.
  terraform_mcp: {
    id: "terraform_mcp",
    name: "terraform-mcp-server",
    license: "MPL-2.0",
    class: "copyleft",
  },
} as const;

export const ALL_TOOL_IDS = Object.keys(TOOL_LICENSES) as ToolId[];

/** a permissively-licensed tool can be enabled by default; anything else needs
 * an explicit, licence-named opt-in. */
export function isPermissive(c: LicenseClass): boolean {
  return c === "permissive";
}

/**
 * A tool whose output must NOT be consumed without an explicit, licence-named
 * opt-in: non-permissive AND not the required substrate. This is the predicate
 * the confirmation gate is built on.
 */
export function isLicenseGated(id: ToolId): boolean {
  const t = TOOL_LICENSES[id];
  return !t.required && !isPermissive(t.class);
}

/** every tool currently behind the licence gate (for docs / reporting). */
export const LICENSE_GATED_TOOLS: ToolId[] = ALL_TOOL_IDS.filter(isLicenseGated);
