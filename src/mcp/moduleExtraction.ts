/**
 * Modularization-as-remediation (M2, the hepcare pattern) — DETECTION.
 *
 * Finds clusters of raw resources that look like they should be a module call,
 * and matches each cluster against the modules the repo already trusts: the
 * operator's `module_catalogue` and the repo's own local ("house") modules.
 * The agent turns a candidate into a refactor PR; `terraform_plan`'s
 * `refactor_safe` gate (pure `moved {}` plan) is what makes that PR provably a
 * no-op on live infrastructure.
 *
 * Everything here is pure parsing + set arithmetic over files already on disk —
 * no subprocess, no network — mirroring the modules.ts design.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import type { LocalToolContext } from "#app/mcp/localContext";
import {
  collectModuleGraph,
  collectModuleInterface,
  isInLocalModule,
  type ModuleCatalogueEntry,
  type ModuleSourceKind,
  parseModuleCatalogue,
  walkTfFiles,
} from "#app/mcp/modules";
import { execute, tool, toolOk } from "#app/mcp/shared";
import { log } from "#app/utils/cli";

// --- resource parsing (pure) -------------------------------------------------

export interface ParsedResource {
  type: string;
  name: string;
}

/** parse every `resource "<type>" "<name>" {` header in some HCL. Headers are
 * enough here — clustering and signature matching only need type + name. */
export function parseResourceBlocks(hcl: string): ParsedResource[] {
  const out: ParsedResource[] = [];
  const re = /(?:^|\n)\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex-exec iteration
  while ((m = re.exec(hcl)) !== null) {
    const resourceType = m[1];
    const name = m[2];
    if (resourceType !== undefined && name !== undefined) {
      out.push({ type: resourceType, name });
    }
  }
  return out;
}

// --- clustering (pure) ---------------------------------------------------------

/** a cluster below this size isn't worth a module refactor PR. */
const MIN_CLUSTER_SIZE = 3;

export interface ExtractionCluster {
  /** the file the resources live in (clusters never span files — one file is
   * the unit a reviewer can hold in their head, and the unit `moved {}` blocks
   * keep reviewable). */
  file: string;
  /** the shared resource-NAME prefix that bound the cluster, or null for a
   * whole-file cluster. */
  name_prefix: string | null;
  resources: ParsedResource[];
  /** distinct resource types, sorted — the cluster's signature. */
  resource_types: string[];
}

function distinctTypes(resources: ParsedResource[]): string[] {
  return [...new Set(resources.map((r) => r.type))].sort();
}

/** the leading token of a resource name (`web_server` → `web`, `db-main` → `db`). */
function namePrefix(name: string): string {
  const token = name.split(/[_-]/, 1)[0] ?? name;
  return token.toLowerCase();
}

/**
 * Cluster one file's resources into extraction candidates:
 *   - groups sharing a name prefix with ≥ MIN_CLUSTER_SIZE members, else
 *   - the whole file when it holds ≥ MIN_CLUSTER_SIZE+1 resources of ≥2 types
 *     (a single-type pile is usually `count`/`for_each` material, not a module).
 * Prefix clusters that would equal the whole-file cluster collapse into one.
 */
export function clusterResources(file: string, resources: ParsedResource[]): ExtractionCluster[] {
  if (resources.length < MIN_CLUSTER_SIZE) return [];

  const byPrefix = new Map<string, ParsedResource[]>();
  for (const r of resources) {
    const prefix = namePrefix(r.name);
    const list = byPrefix.get(prefix) ?? [];
    list.push(r);
    byPrefix.set(prefix, list);
  }
  const clusters: ExtractionCluster[] = [];
  for (const [prefix, members] of [...byPrefix.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (members.length < MIN_CLUSTER_SIZE) continue;
    clusters.push({
      file,
      name_prefix: members.length === resources.length ? null : prefix,
      resources: members,
      resource_types: distinctTypes(members),
    });
  }
  // whole-file fallback: cohesive multi-type file none of whose prefixes qualified.
  if (clusters.length === 0) {
    const types = distinctTypes(resources);
    if (resources.length > MIN_CLUSTER_SIZE && types.length >= 2) {
      clusters.push({ file, name_prefix: null, resources, resource_types: types });
    }
  }
  return clusters;
}

// --- candidate matching (pure) ------------------------------------------------

export interface CandidateModule {
  name: string;
  source: string;
  version: string | null;
  kind: ModuleSourceKind;
  /** how the match was made: a house module's actual resource types, or a
   * catalogue module's name matching the cluster's service keywords. */
  match: "resource_signature" | "name_keyword";
  /** fraction of the cluster's resource types the candidate covers (signature
   * matches) or whose service keyword hits the candidate's name (keyword). */
  overlap: number;
  /** house modules only — what the call site must wire up. */
  required_variables?: string[];
}

/** minimum signature/keyword overlap for a candidate to be worth reporting. */
const MIN_OVERLAP = 0.5;

/** provider prefixes carry no service meaning for keyword matching. */
const PROVIDER_PREFIXES = new Set(["aws", "azurerm", "google", "azuread", "kubernetes", "helm"]);

/** service keywords of a resource type: `aws_s3_bucket` → ["s3", "bucket"]. */
export function serviceKeywords(resourceType: string): string[] {
  return resourceType
    .split("_")
    .filter((tok) => tok.length > 1 && !PROVIDER_PREFIXES.has(tok))
    .map((tok) => tok.toLowerCase());
}

export interface HouseModuleSignature {
  dir: string;
  resourceTypes: string[];
  requiredVariables: string[];
}

/** fraction of cluster types present in the module's own resource-type set. */
function signatureOverlap(clusterTypes: string[], moduleTypes: string[]): number {
  if (clusterTypes.length === 0) return 0;
  const moduleSet = new Set(moduleTypes);
  const hit = clusterTypes.filter((t) => moduleSet.has(t)).length;
  return hit / clusterTypes.length;
}

/** fraction of cluster types with ≥1 service keyword in the candidate's name/source. */
function keywordOverlap(clusterTypes: string[], haystack: string): number {
  if (clusterTypes.length === 0) return 0;
  const target = haystack.toLowerCase();
  const hit = clusterTypes.filter((t) =>
    serviceKeywords(t).some((kw) => target.includes(kw)),
  ).length;
  return hit / clusterTypes.length;
}

export function matchCluster(
  cluster: ExtractionCluster,
  houseModules: HouseModuleSignature[],
  catalogue: ModuleCatalogueEntry[],
): CandidateModule[] {
  const out: CandidateModule[] = [];
  for (const house of houseModules) {
    const overlap = signatureOverlap(cluster.resource_types, house.resourceTypes);
    if (overlap < MIN_OVERLAP) continue;
    out.push({
      name: house.dir.split("/").filter(Boolean).pop() ?? house.dir,
      source: `./${house.dir}`,
      version: null,
      kind: "local",
      match: "resource_signature",
      overlap: Number(overlap.toFixed(2)),
      required_variables: house.requiredVariables,
    });
  }
  for (const entry of catalogue) {
    // local catalogue entries are house modules — already covered by signature.
    if (entry.kind === "local") continue;
    const overlap = keywordOverlap(cluster.resource_types, `${entry.name} ${entry.source}`);
    if (overlap < MIN_OVERLAP) continue;
    out.push({
      name: entry.name,
      source: entry.source,
      version: entry.version,
      kind: entry.kind,
      match: "name_keyword",
      overlap: Number(overlap.toFixed(2)),
    });
  }
  // strongest candidates first; signature beats keyword at equal overlap.
  return out.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    if (a.match !== b.match) return a.match === "resource_signature" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// --- workspace scan (I/O composition) ------------------------------------------

export interface ExtractionCandidate {
  cluster: ExtractionCluster;
  candidates: CandidateModule[];
}

/** non-recursive resource-type signature of a local module dir. */
function houseModuleSignature(cwd: string, dir: string): HouseModuleSignature {
  let text = "";
  try {
    for (const f of readdirSync(join(cwd, dir))) {
      if (!f.endsWith(".tf")) continue;
      try {
        text += `${readFileSync(join(cwd, dir, f), "utf8")}\n`;
      } catch {
        /* skip unreadable file */
      }
    }
  } catch {
    /* missing dir → empty signature */
  }
  return {
    dir,
    resourceTypes: distinctTypes(parseResourceBlocks(text)),
    requiredVariables: collectModuleInterface(cwd, dir)
      .variables.filter((v) => v.required)
      .map((v) => v.name),
  };
}

const MAX_CANDIDATES = 20;

export function findExtractionCandidates(
  cwd: string,
  rawCatalogue: string | undefined,
): ExtractionCandidate[] {
  const graph = collectModuleGraph(cwd);
  const houseModules = graph.localModuleDirs.map((d) => houseModuleSignature(cwd, d.dir));
  const catalogue = parseModuleCatalogue(rawCatalogue);

  const out: ExtractionCandidate[] = [];
  for (const file of walkTfFiles(cwd)) {
    // resources already inside a module dir ARE the module — never re-extract.
    if (isInLocalModule(file, graph)) continue;
    let text: string;
    try {
      text = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue;
    }
    for (const cluster of clusterResources(file, parseResourceBlocks(text))) {
      out.push({ cluster, candidates: matchCluster(cluster, houseModules, catalogue) });
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}

// --- the tool -------------------------------------------------------------------

export const ModuleExtractionCandidatesParams = type({});

export function ModuleExtractionCandidatesTool(ctx: LocalToolContext) {
  return tool({
    name: "module_extraction_candidates",
    description:
      "Find clusters of RAW resources that should likely be a module call (M2 modularization-as-" +
      "remediation). Deterministically clusters each root file's resources by shared name prefix " +
      "(falling back to a cohesive whole file), then matches every cluster against the repo's house " +
      "modules (by their REAL resource-type signature, with `required_variables` so you wire the actual " +
      "interface) and the operator's `module_catalogue` (by service keyword). Files already inside a " +
      "local module dir are never re-extracted. Refactor contract: ONE PR per cluster on branch " +
      "`remediate/modularize-<group>`; replace the raw resources with the candidate module call; add a " +
      "`moved {}` block per resource (old address → module address) so state is preserved; the PR may " +
      "proceed ONLY when terraform_validate passes AND terraform_plan reports `refactor_safe: true` " +
      "(a pure-move plan — zero add/change/destroy). A missing required variable is a PR question for " +
      "the reviewer, never a guessed value.",
    parameters: ModuleExtractionCandidatesParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const candidates = findExtractionCandidates(cwd, ctx.payload.moduleCatalogue);
      const matched = candidates.filter((c) => c.candidates.length > 0);
      log.info(
        `» module_extraction_candidates: ${candidates.length} cluster(s), ${matched.length} with a module match`,
      );
      return toolOk({
        cluster_count: candidates.length,
        matched_count: matched.length,
        candidates,
        note:
          candidates.length === 0
            ? "no extraction-worthy resource clusters found (root files with ≥3 related raw resources)"
            : "verify any refactor with terraform_validate + terraform_plan (refactor_safe must be true)",
      });
    }),
  });
}
