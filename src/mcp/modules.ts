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

/** derive a stable module name from a source when none was given (last path
 * segment for a local/git source, the module name for a registry ref). */
function deriveName(source: string): string {
  // registry `namespace/name/provider` → `name`; path → last segment.
  const cleaned = source.replace(/\.git$/, "").replace(/\/+$/, "");
  const registry = cleaned.match(/^(?:[^/]+\/)?([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
  if (registry) return registry[2];
  const seg = cleaned.split(/[/]/).filter(Boolean).pop() ?? source;
  return seg.replace(/[^A-Za-z0-9_-]/g, "_");
}

export type ModuleSourceKind = "local" | "registry" | "git" | "remote" | "unknown";

/**
 * Classify a Terraform module `source` string. Mirrors Terraform's own source
 * resolution: a `./`/`../`/absolute path is LOCAL; a `git::`/`github.com`/`.git`
 * /`bitbucket.org` source is GIT; an `s3::`/`gcs::`/`http(s)` archive is REMOTE;
 * a bare `namespace/name/provider` (optionally host-prefixed) is a REGISTRY ref.
 */
export function classifyModuleSource(source: string): ModuleSourceKind {
  const s = source.trim();
  if (!s) return "unknown";
  if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s)) {
    return "local";
  }
  if (s.startsWith("git::") || s.startsWith("git@") || /(?:^|\/)github\.com\//.test(s) || /\.git(?:$|[?#])/.test(s) || s.includes("bitbucket.org") || s.startsWith("hg::")) {
    return "git";
  }
  if (/^(?:s3|gcs|http|https|mercurial|oci)[:]/.test(s) || s.startsWith("https://") || s.startsWith("http://")) {
    return "remote";
  }
  // host-prefixed or bare registry shorthand: [host/]namespace/name/provider
  if (/^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(s)) {
    return "registry";
  }
  return "unknown";
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
    const finalName = name ?? deriveName(source);
    const dedupeKey = `${finalName}|${source}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ name: finalName, source, version, kind: classifyModuleSource(source) });
  }
  return out;
}

// --- module call-graph (§4.14) ---------------------------------------------

export interface ModuleBlock {
  /** the local name in `module "<name>" { … }`. */
  name: string;
  source: string;
  version: string | null;
  kind: ModuleSourceKind;
  /** the file the `module` block was declared in (repo-relative). */
  declaredIn: string;
}

/**
 * Parse every `module "<name>" { … }` block in some HCL into its name, source,
 * and version. Brace-matched so nested blocks (e.g. a `providers = { … }` map
 * inside the module block) don't confuse it. `declaredIn` is filled by the
 * caller; here it's left as "".
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
    const version = body.match(/(?:^|\n)\s*version\s*=\s*"([^"]+)"/)?.[1] ?? null;
    if (source) {
      out.push({ name, source, version, kind: classifyModuleSource(source), declaredIn: "" });
    }
    re.lastIndex = end + 1;
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

/** read the root module's `*.tf` files and build the module call-graph. */
export function collectModuleGraph(cwd: string): ModuleGraph {
  const modules: ModuleBlock[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(cwd).filter((f) => f.endsWith(".tf"));
  } catch {
    return { modules: [], localModuleDirs: [], externalCount: 0 };
  }
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
  // group local module dirs → caller files.
  const byDir = new Map<string, Set<string>>();
  let externalCount = 0;
  for (const mod of modules) {
    if (mod.kind === "local") {
      const dir = mod.source.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
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
      "List the operator-approved module catalogue (the `module_catalogue` input). PREFER one of these " +
      "modules — a public registry module (e.g. `terraform-aws-modules/vpc/aws`) or one of the org's own " +
      "house modules at a local path — over hand-rolling raw resources when one cleanly fits the fix or " +
      "generation, using its exact variable names and pinning its `version`. Returns an empty list when no " +
      "catalogue is configured (then fall back to well-formed raw resources / a well-maintained public " +
      "registry module).",
    parameters: ListModulesParams,
    execute: execute(async () => {
      const entries = parseModuleCatalogue(ctx.payload.moduleCatalogue);
      log.info(`» list_modules: ${entries.length} catalogue module(s)`);
      return {
        configured: entries.length > 0,
        modules: entries,
        note:
          entries.length > 0
            ? "Prefer these modules (use the exact variable names; pin the version). They are operator-approved."
            : "No module catalogue configured. Prefer a well-maintained public registry module (pinned) or well-formed raw resources.",
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
        modules: graph.modules.map((m) => ({ name: m.name, source: m.source, version: m.version, kind: m.kind, declared_in: m.declaredIn })),
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
