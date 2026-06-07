import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { log } from "#app/utils/cli";
import { walkTfFiles } from "#app/mcp/modules";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool } from "#app/mcp/shared";

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
      log.info(`» terraform_roots: ${roots.length} root(s) [${roots.map((r) => r.dir || ".").join(", ")}]`);
      return {
        ok: true,
        root_count: roots.length,
        roots: roots.map((r) => ({
          dir: r.dir || ".",
          has_backend: r.hasBackend,
          has_provider_config: r.hasProviderConfig,
          tf_file_count: r.tfFileCount,
        })),
        note:
          roots.length > 1
            ? "Multiple roots — run terraform_plan/terraform_validate once per root (set cwd to each dir)."
            : "Single root (or none detected) — the scan cwd is the root.",
      };
    }),
  });
}
