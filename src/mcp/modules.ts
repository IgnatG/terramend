import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { log } from "#app/utils/cli";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool } from "#app/mcp/shared";

/**
 * Terraform module support (§4.14 + module catalogue). Two related capabilities:
 *
 *  - **Module catalogue** — an operator-curated list of approved modules (a
 *    registry module like `terraform-aws-modules/vpc/aws`, or one of the org's
 *    own/house modules at a local path) that a fix/generation should PREFER over
 *    hand-rolling raw resources. Surfaced by `list_modules`.
 *  - **Module-source-aware fixes** — parse the repo's `module "x" { source = … }`
 *    blocks into a call-graph so a concern inside a *local* module is fixed at
 *    its SOURCE once (not patched at every call site), while a concern that would
 *    require editing a *registry/remote* module is flagged as out-of-repo.
 *    Surfaced by `terraform_module_graph`.
 *
 * The parsing is pure (no subprocess) and unit-tested; the tools just read files.
 */

// --- module catalogue ------------------------------------------------------

export interface ModuleCatalogueEntry {
  /** the local name to use in a `module "<name>"` block. */
  name: string;
  /** the `source` value, e.g. `terraform-aws-modules/vpc/aws` or `./modules/vpc`. */
  source: string;
  /** optional version constraint for a registry module. */
  version: string | null;
  /** classification of the source (registry / local / git / remote). */
  kind: ModuleSourceKind;
}

/** a version-looking token: `~> 5.0`, `>= 1.2`, `1.0.0`, `v2`, `< 4`. */
function looksLikeVersion(token: string): boolean {
  return /^[v~^]?[<>=]*\s*\d/.test(token) || /^[<>=]/.test(token);
}

/** derive a stable module name from a source when none was given. The most
 * meaningful name is the `//subdir`'s last segment when present
 * (`…/modules.git//aws/kms` → `kms`, `terraform-aws-modules/cloudwatch/aws//modules/log-group`
 * → `log-group`); else the registry module name; else the last path segment. */
function deriveName(source: string): string {
  const parsed = splitModuleSource(source);
  if (parsed.subdir) {
    const seg = parsed.subdir.split("/").filter(Boolean).pop();
    if (seg) return seg.replace(/[^A-Za-z0-9_-]/g, "_");
  }
  const cleaned = parsed.base.replace(/\.git$/, "").replace(/\/+$/, "");
  const registry = cleaned.match(/^(?:[^/]+\/)?([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
  if (registry) return registry[2];
  const seg = cleaned.split(/[/]/).filter(Boolean).pop() ?? source;
  return seg.replace(/[^A-Za-z0-9_-]/g, "_");
}

export type ModuleSourceKind = "local" | "registry" | "git" | "remote" | "unknown";

export interface ParsedModuleSource {
  /** the full original source string. */
  raw: string;
  /** the source with the `//subdir` selector and `?query` stripped. */
  base: string;
  /** the `//subdir` path within the module repo/package, or null. */
  subdir: string | null;
  /** the `?ref=` revision (git tag/branch/commit), or null. This is how git
   * modules PIN a version — Terraform has no `version` attribute for them. */
  ref: string | null;
  kind: ModuleSourceKind;
}

/**
 * Split a Terraform module `source` into its base, `//subdir` selector, and
 * `?ref=` revision — the three parts Terraform's go-getter syntax composes
 * (`git::https://host/repo.git//subdir?ref=v1`,
 * `terraform-aws-modules/cloudwatch/aws//modules/log-group`). The `//` separator
 * is the one NOT part of a `://` scheme. Pure; underpins classification + the
 * version a git module is pinned at.
 */
export function splitModuleSource(raw: string): ParsedModuleSource {
  let rest = raw.trim();

  // `?query` → pull out ref=.
  let ref: string | null = null;
  const q = rest.indexOf("?");
  if (q >= 0) {
    const query = rest.slice(q + 1);
    rest = rest.slice(0, q);
    const refMatch = query.match(/(?:^|&)ref=([^&]+)/);
    if (refMatch) {
      try {
        ref = decodeURIComponent(refMatch[1]);
      } catch {
        ref = refMatch[1];
      }
    }
  }

  // `//subdir` — the first `//` that isn't the `://` of a scheme.
  let subdir: string | null = null;
  const sep = rest.match(/(?<!:)\/\//);
  if (sep && sep.index !== undefined) {
    subdir = rest.slice(sep.index + 2) || null;
    rest = rest.slice(0, sep.index);
  }

  return { raw, base: rest, subdir, ref, kind: classifyBase(rest) };
}

/** classify a source's BASE (no subdir/query). */
function classifyBase(base: string): ModuleSourceKind {
  const s = base.trim();
  if (!s) return "unknown";
  if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s)) {
    return "local";
  }
  if (
    s.startsWith("git::") ||
    s.startsWith("git@") ||
    /(?:^|\/)github\.com\//.test(s) ||
    /\.git$/.test(s) ||
    s.includes("bitbucket.org") ||
    s.startsWith("hg::")
  ) {
    return "git";
  }
  if (/^(?:s3|gcs|http|https|mercurial|oci)[:]/.test(s)) {
    return "remote";
  }
  // host-prefixed or bare registry shorthand: [host/]namespace/name/provider
  if (/^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(s)) {
    return "registry";
  }
  return "unknown";
}

/**
 * Classify a Terraform module `source` string (the full value, including any
 * `//subdir` / `?ref=`). Mirrors Terraform's own source resolution: a
 * `./`/`../`/absolute path is LOCAL; a `git::`/`github.com`/`.git`/`bitbucket.org`
 * source is GIT; an `s3::`/`gcs::`/`http(s)` archive is REMOTE; a bare
 * `namespace/name/provider` (optionally host-prefixed, optionally with a
 * `//submodule` path) is a REGISTRY ref.
 */
export function classifyModuleSource(source: string): ModuleSourceKind {
  return splitModuleSource(source).kind;
}

/**
 * Parse the operator's `module_catalogue` input into structured entries. Accepts
 * newline- and/or comma-separated entries, each:
 *   `[name=]<source>[ <version>]`
 * e.g. `vpc=terraform-aws-modules/vpc/aws ~> 5.0`, `terraform-aws-modules/s3-bucket/aws`,
 * `./modules/networking`. Name is optional (derived from the source when absent);
 * version applies to registry sources.
 */
export function parseModuleCatalogue(raw: string | undefined): ModuleCatalogueEntry[] {
  if (!raw) return [];
  const out: ModuleCatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[\n,]+/)) {
    const entry = piece.trim();
    if (!entry) continue;
    // optional `name=` prefix: the part before `=` must be a bare identifier
    // (no `/`, so a registry source's slashes aren't mistaken for a name split).
    let body = entry;
    let name: string | null = null;
    const eq = entry.indexOf("=");
    if (eq > 0) {
      const lhs = entry.slice(0, eq).trim();
      if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(lhs)) {
        name = lhs;
        body = entry.slice(eq + 1).trim();
      }
    }
    // split source and optional trailing version constraint on whitespace.
    const parts = body.split(/\s+/);
    let source = parts[0] ?? "";
    let version: string | null = null;
    if (parts.length > 1 && looksLikeVersion(parts.slice(1).join(" "))) {
      version = parts.slice(1).join(" ");
    } else if (parts.length > 1) {
      source = parts.join(" ");
    }
    if (!source) continue;
    const parsed = splitModuleSource(source);
    // a git module pins its version via `?ref=` (no `version` attribute), so
    // fall back to the ref when no explicit version token was given.
    const effectiveVersion = version ?? parsed.ref;
    const finalName = name ?? deriveName(source);
    const dedupeKey = `${finalName}|${source}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ name: finalName, source, version: effectiveVersion, kind: parsed.kind });
  }
  return out;
}

// --- module call-graph (§4.14) ---------------------------------------------

export interface ModuleBlock {
  /** the local name in `module "<name>" { … }`. */
  name: string;
  source: string;
  /** the pinned version — the `version` attribute (registry) or the git `?ref=`
   * (git), whichever is present; null when unpinned. */
  version: string | null;
  /** the `//subdir` selector within the module package, or null. */
  subdir: string | null;
  kind: ModuleSourceKind;
  /** the file the `module` block was declared in (repo-relative). */
  declaredIn: string;
}

/**
 * Parse every `module "<name>" { … }` block in some HCL into its name, source,
 * pinned version, and subdir. Brace-matched so nested blocks (e.g. a
 * `providers = { … }` map inside the module block) don't confuse it. The version
 * comes from the `version` attribute (registry modules) OR the source's `?ref=`
 * (git modules), so a git-pinned module isn't reported as unpinned. `declaredIn`
 * is filled by the caller; here it's "".
 */
export function parseModuleBlocks(hcl: string): ModuleBlock[] {
  const out: ModuleBlock[] = [];
  const re = /module\s+"([^"]+)"\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hcl)) !== null) {
    const name = m[1];
    const braceStart = re.lastIndex - 1;
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < hcl.length; i++) {
      if (hcl[i] === "{") depth++;
      else if (hcl[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    const body = hcl.slice(braceStart + 1, end);
    const source = body.match(/(?:^|\n)\s*source\s*=\s*"([^"]+)"/)?.[1] ?? "";
    const versionAttr = body.match(/(?:^|\n)\s*version\s*=\s*"([^"]+)"/)?.[1] ?? null;
    re.lastIndex = end + 1;
    if (!source) continue;
    const parsed = splitModuleSource(source);
    out.push({
      name,
      source,
      version: versionAttr ?? parsed.ref,
      subdir: parsed.subdir,
      kind: parsed.kind,
      declaredIn: "",
    });
  }
  return out;
}

export interface ModuleGraph {
  /** every `module` block found, with its classified source. */
  modules: ModuleBlock[];
  /** local module source dirs (repo-relative), each with the caller files that
   * reference it — fix a concern in one of these dirs ONCE at the source. */
  localModuleDirs: { dir: string; callers: string[] }[];
  /** count of registry/git/remote module references — concerns that live inside
   * one of these are NOT editable in this repo (open an issue instead). */
  externalCount: number;
}

// directories never worth descending into when walking for `.tf` (caches, VCS,
// venvs, deps). Keeps the recursive walk fast and noise-free.
const SKIP_DIRS = new Set([
  ".git",
  ".terraform",
  ".terragrunt-cache",
  ".venv",
  "venv",
  "node_modules",
  ".idea",
  ".vscode",
]);

/**
 * Recursively list `*.tf` files under `cwd`, repo-relative (POSIX), skipping
 * cache/VCS/dep dirs. Bounded by depth and a file cap so a huge monorepo can't
 * stall the walk. Real Terraform repos (e.g. hepcare) keep their root config in
 * a subdir (`terraform/`) with house modules in `terraform/modules/` and even a
 * second root (`terraform/core/`) — a single-level read misses all of that, so
 * we walk the tree.
 */
export function walkTfFiles(cwd: string, maxDepth = 8, cap = 2000): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string, depth: number): void => {
    if (depth > maxDepth || out.length >= cap) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        visit(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".tf")) {
        out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  visit(cwd, "", 0);
  return out;
}

/** normalize a POSIX path, resolving `.`/`..` segments. */
function normalizeRel(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Walk `cwd` recursively and build the module call-graph across every Terraform
 * file (root + subdir roots + nested modules). A local module's dir is resolved
 * RELATIVE TO THE DECLARING FILE (`./modules/x` in `core/main.tf` → `core/modules/x`),
 * not to `cwd`, so the graph is correct for multi-root repos.
 */
export function collectModuleGraph(cwd: string): ModuleGraph {
  const modules: ModuleBlock[] = [];
  const files = walkTfFiles(cwd);
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(cwd, f), "utf8");
    } catch {
      continue;
    }
    for (const block of parseModuleBlocks(text)) {
      modules.push({ ...block, declaredIn: f });
    }
  }
  // group local module dirs → caller files. Resolve the source against the
  // declaring file's directory so relative paths from a subdir root land right.
  const byDir = new Map<string, Set<string>>();
  let externalCount = 0;
  for (const mod of modules) {
    if (mod.kind === "local") {
      const callerDir = mod.declaredIn.includes("/")
        ? mod.declaredIn.slice(0, mod.declaredIn.lastIndexOf("/"))
        : "";
      const raw = mod.source.replace(/\\/g, "/");
      const dir = normalizeRel(callerDir ? `${callerDir}/${raw}` : raw);
      const set = byDir.get(dir) ?? new Set<string>();
      set.add(mod.declaredIn);
      byDir.set(dir, set);
    } else if (mod.kind !== "unknown") {
      externalCount++;
    }
  }
  const localModuleDirs = [...byDir.entries()]
    .map(([dir, callers]) => ({ dir, callers: [...callers].sort() }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
  return { modules, localModuleDirs, externalCount };
}

/** true when `file` sits under one of the graph's local module dirs — i.e. a
 * concern there should be fixed at the module SOURCE (it propagates to callers). */
export function isInLocalModule(file: string, graph: ModuleGraph): { dir: string; callers: string[] } | null {
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const entry of graph.localModuleDirs) {
    if (f === entry.dir || f.startsWith(`${entry.dir}/`)) return entry;
  }
  return null;
}

// --- the tools -------------------------------------------------------------

export const ListModulesParams = type({});

export function ListModulesTool(ctx: ToolContext) {
  return tool({
    name: "list_modules",
    description:
      "List the modules to PREFER over hand-rolling raw resources. Combines the operator-approved " +
      "`module_catalogue` input (registry modules like `terraform-aws-modules/vpc/aws` or house modules at " +
      "a local path) with `discovered_house_modules` — local modules already used in THIS repo (e.g. " +
      "`modules/cloudwatch_logs`), auto-detected from the call-graph so an existing house module is reused " +
      "with its real interface rather than re-implemented. Use a module's exact variable names and pin its " +
      "`version` (a git module's pin is its `?ref=`). When nothing is configured or discovered, fall back to " +
      "a well-maintained public registry module (pinned) or well-formed raw resources.",
    parameters: ListModulesParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const entries = parseModuleCatalogue(ctx.payload.moduleCatalogue);
      // auto-discover house modules already used in this repo (the convention
      // hepcare-style repos follow: `modules/<name>` referenced from the root).
      const graph = collectModuleGraph(cwd);
      const discovered = graph.localModuleDirs.map((d) => ({
        name: d.dir.split("/").pop() ?? d.dir,
        path: d.dir,
        callers: d.callers,
        exists: moduleDirExists(cwd, d.dir),
      }));
      log.info(
        `» list_modules: ${entries.length} catalogue module(s), ${discovered.length} discovered house module(s)`
      );
      return {
        configured: entries.length > 0,
        modules: entries,
        discovered_house_modules: discovered,
        note:
          entries.length > 0 || discovered.length > 0
            ? "Prefer these modules (exact variable names; pin the version). Reuse a discovered house module with its real interface rather than re-implementing it."
            : "No catalogue or house modules. Prefer a well-maintained public registry module (pinned) or well-formed raw resources.",
      };
    }),
  });
}

export const TerraformModuleGraphParams = type({});

export function TerraformModuleGraphTool(ctx: ToolContext) {
  return tool({
    name: "terraform_module_graph",
    description:
      "Build the repo's module call-graph (§4.14) so a fix lands in the right place. Parses every " +
      "`module \"x\" { source = … }` block and classifies each source as local / registry / git / remote. " +
      "Returns `local_module_dirs` (each with the caller files that use it) — a concern INSIDE one of these " +
      "dirs should be fixed ONCE at the module source (the fix propagates to every caller), not patched at " +
      "each call site. A concern whose fix would require editing a registry/git/remote module is NOT " +
      "editable in this repo — open an issue naming the upstream module + version instead of attempting it.",
    parameters: TerraformModuleGraphParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const graph = collectModuleGraph(cwd);
      log.info(
        `» terraform_module_graph: ${graph.modules.length} module block(s), ` +
          `${graph.localModuleDirs.length} local dir(s), ${graph.externalCount} external`
      );
      return {
        modules: graph.modules.map((m) => ({
          name: m.name,
          source: m.source,
          version: m.version,
          subdir: m.subdir,
          kind: m.kind,
          declared_in: m.declaredIn,
        })),
        local_module_dirs: graph.localModuleDirs,
        external_module_count: graph.externalCount,
      };
    }),
  });
}

/** best-effort existence check used by tests/tools — exported for reuse. */
export function moduleDirExists(cwd: string, dir: string): boolean {
  try {
    const full = join(cwd, dir);
    return existsSync(full) && statSync(full).isDirectory();
  } catch {
    return false;
  }
}
