import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { walkTfFiles } from "#app/mcp/modules";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool } from "#app/mcp/shared";
import { log } from "#app/utils/cli";

/**
 * Multi-root awareness. A repo can hold SEVERAL Terraform root modules — the
 * dirs you'd run `terraform init/plan/apply` in — not one. hepcare, for example,
 * has `terraform/` AND `terraform/core/`, plus a child module under
 * `terraform/modules/`. The scanners run recursively, but plan/validate assume a
 * single `cwd`; this surfaces the roots so a run can act per-root.
 *
 * Heuristic (validated against real repos): a ROOT is a dir whose `*.tf`
 * declares a PROVIDER CONFIGURATION (`provider "<name>" { … }`) or a BACKEND
 * (`backend "<type>" { … }`). A CHILD MODULE never configures a provider or a
 * backend (it only declares `required_providers`), so this cleanly separates the
 * two. Pure parsing + a single fs walk; no subprocess.
 */

export interface TerraformRoot {
  /** repo-relative dir (POSIX); "" for the top-level. */
  dir: string;
  hasBackend: boolean;
  hasProviderConfig: boolean;
  tfFileCount: number;
}

// a provider CONFIGURATION block — `provider "aws" {`. Distinct from a
// `required_providers` block (which child modules also have). The negative
// lookbehind avoids matching `required_providers`.
const PROVIDER_CONFIG = /(?:^|\n)\s*provider\s+"[^"]+"\s*\{/;
const BACKEND_BLOCK = /(?:^|\n)\s*backend\s+"[^"]+"\s*\{/;

/** detect whether some concatenated HCL marks a root module. */
export function isRootModuleHcl(hcl: string): { hasBackend: boolean; hasProviderConfig: boolean } {
  return {
    hasBackend: BACKEND_BLOCK.test(hcl),
    hasProviderConfig: PROVIDER_CONFIG.test(hcl),
  };
}

/** the directory of a repo-relative file path ("" for a top-level file). */
function dirOf(file: string): string {
  const i = file.lastIndexOf("/");
  return i === -1 ? "" : file.slice(0, i);
}

/**
 * Discover the Terraform root modules under `cwd`. Walks `*.tf` recursively
 * (skipping cache/VCS dirs via walkTfFiles), groups by directory, and keeps the
 * dirs that configure a provider or a backend. Sorted by dir. An empty result
 * means no obvious root was found — the caller falls back to scanning `cwd`
 * itself as a single root.
 */
export function discoverTerraformRoots(cwd: string): TerraformRoot[] {
  const byDir = new Map<string, { files: string[]; hcl: string }>();
  for (const f of walkTfFiles(cwd)) {
    const dir = dirOf(f);
    const entry = byDir.get(dir) ?? { files: [], hcl: "" };
    entry.files.push(f);
    try {
      entry.hcl += `${readFileSync(join(cwd, f), "utf8")}\n`;
    } catch {
      /* skip unreadable */
    }
    byDir.set(dir, entry);
  }
  const roots: TerraformRoot[] = [];
  for (const [dir, entry] of byDir) {
    const { hasBackend, hasProviderConfig } = isRootModuleHcl(entry.hcl);
    if (hasBackend || hasProviderConfig) {
      roots.push({ dir, hasBackend, hasProviderConfig, tfFileCount: entry.files.length });
    }
  }
  return roots.sort((a, b) => a.dir.localeCompare(b.dir));
}

// --- §22 environment / region fan-out --------------------------------------

// tokens that mark an environment twin when they appear as a whole path segment
// or a `<token>.tfvars` filename. Lowercased; matched exactly against a segment.
const ENV_TOKENS = new Set([
  "dev",
  "develop",
  "development",
  "stg",
  "stage",
  "staging",
  "prod",
  "prd",
  "production",
  "test",
  "testing",
  "qa",
  "uat",
  "sandbox",
  "sbx",
  "preprod",
  "pre-prod",
  "preproduction",
  "demo",
  "nonprod",
  "non-prod",
]);

// AWS-style region segment, e.g. `eu-west-2`, `eu-west-1` — the other common
// fan-out axis (the same stack replicated per region).
const REGION_RE = /^[a-z]{2}-[a-z]+-\d$/;

export interface EnvironmentTwinGroup {
  /** the shared path shape with the env/region segment replaced by `{env}`. */
  pattern: string;
  /** the matched twins: each a dir + the environment/region token it carries. */
  members: { dir: string; environment: string }[];
}

/**
 * Detect environment/region TWINS among a set of repo-relative paths (root dirs
 * and/or `*.tfvars` files): parallel stacks that differ only by an environment
 * (`dev`/`staging`/`prod`/…) or region (`eu-west-2`) segment. A fix applied to
 * one should usually be offered for its twins too (§22 — backport / fan-out).
 *
 * For each path, finds the LAST segment that is an env token or a region (a
 * `<env>.tfvars` file counts via its basename), replaces it with `{env}` to form
 * a pattern, and groups by that pattern. Only groups with ≥2 DISTINCT
 * environments are returned (a single match isn't a twin set). Pure +
 * deterministic (sorted).
 */
export function detectEnvironmentTwins(paths: string[]): EnvironmentTwinGroup[] {
  const byPattern = new Map<string, Map<string, string>>(); // pattern → env → dir
  for (const raw of paths) {
    const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const segments = path.split("/").filter(Boolean);
    // a `<env>.tfvars` filename: treat the basename (sans .tfvars) as a segment.
    const last = segments[segments.length - 1] ?? "";
    if (last.endsWith(".tfvars")) {
      segments[segments.length - 1] = last.slice(0, -".tfvars".length);
    }
    // find the LAST env/region segment (so `infra/prod/network` keys on `prod`).
    let idx = -1;
    let token = "";
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!.toLowerCase();
      if (ENV_TOKENS.has(seg) || REGION_RE.test(seg)) {
        idx = i;
        token = seg;
        break;
      }
    }
    if (idx === -1) continue;
    const patternSegs = [...segments];
    patternSegs[idx] = "{env}";
    const pattern = patternSegs.join("/") + (last.endsWith(".tfvars") ? ".tfvars" : "");
    const map = byPattern.get(pattern) ?? new Map<string, string>();
    if (!map.has(token)) map.set(token, path);
    byPattern.set(pattern, map);
  }
  const groups: EnvironmentTwinGroup[] = [];
  for (const [pattern, envMap] of byPattern) {
    if (envMap.size < 2) continue;
    const members = [...envMap.entries()]
      .map(([environment, dir]) => ({ dir, environment }))
      .sort((a, b) => a.environment.localeCompare(b.environment));
    groups.push({ pattern, members });
  }
  return groups.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

export const TerraformRootsParams = type({});

export function TerraformRootsTool(ctx: ToolContext) {
  return tool({
    name: "terraform_roots",
    description:
      "Discover the Terraform ROOT modules in the repo — the dirs you'd run `terraform init/plan/apply` in " +
      "(they configure a `provider` or a `backend`), as opposed to child modules under `modules/`. A repo " +
      "can have several (e.g. `terraform/` and `terraform/core/`). `terraform_scan` already scans the whole " +
      "tree, but `terraform_plan`/`terraform_validate` act on one dir — run them once PER ROOT (set the " +
      "`cwd` accordingly) when there is more than one, so each root's real-world effect is checked. Returns " +
      "an empty list when no root is detected (then treat the scan `cwd` as the single root).",
    parameters: TerraformRootsParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const roots = discoverTerraformRoots(cwd);
      // §22 — parallel per-environment/region stacks among the roots; a fix to
      // one twin should usually be offered for the others.
      const twins = detectEnvironmentTwins(roots.map((r) => r.dir).filter(Boolean));
      log.info(
        `» terraform_roots: ${roots.length} root(s) [${roots.map((r) => r.dir || ".").join(", ")}]` +
          (twins.length ? `, ${twins.length} env-twin group(s)` : ""),
      );
      return {
        ok: true,
        root_count: roots.length,
        roots: roots.map((r) => ({
          dir: r.dir || ".",
          has_backend: r.hasBackend,
          has_provider_config: r.hasProviderConfig,
          tf_file_count: r.tfFileCount,
        })),
        // §22 — environment/region twin groups (≥2 stacks differing only by an
        // env/region segment). Empty when there are none.
        environment_twins: twins,
        note:
          roots.length > 1
            ? "Multiple roots — terraform_plan/terraform_validate run per root automatically. " +
              (twins.length
                ? "Detected environment twins: a fix to one stack should usually be offered for its twins (§22)."
                : "")
            : "Single root (or none detected) — the scan cwd is the root.",
      };
    }),
  });
}
