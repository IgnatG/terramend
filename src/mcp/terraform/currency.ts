/**
 * Version currency (§P1 provider currency / M3 module upgrades).
 *
 * Answers one question the scanners can't: "is a NEWER version available?"
 * tflint checks that versions are *pinned*; nothing we run checks that they're
 * *current*. This module compares the workspace's pinned provider requirements
 * and registry-module pins against the Terraform Registry's published versions.
 *
 * Deliberately NOT a scanner source: results are advisory intelligence the
 * Remediate mode turns into `chore(deps)` upgrade PRs, not `Concern`s — the
 * finding baseline stays scanner-owned (see docs/workplan/04-implementation-plan.md).
 *
 * Degrades green everywhere: a per-source lookup failure is reported on that
 * row (`lookup: "error" | "not_found" | "unsupported_source"`), and only a
 * fully-unreachable registry (every lookup failed) becomes a tool-level skip.
 */

import semver from "semver";
import { collectModuleGraph, splitModuleSource } from "#app/mcp/modules";
import { collectProviderRequirements } from "#app/mcp/terraform/scanners";

export const DEFAULT_REGISTRY_BASE_URL = "https://registry.terraform.io";
const FETCH_TIMEOUT_MS = 5_000;

// --- constraint parsing (pure) ----------------------------------------------

/** one comparator of a Terraform constraint: `~> 5.0`, `>= 1.2`, `5.1.0`. */
const COMPARATOR_RE = /^(~>|>=|<=|!=|=|>|<)?\s*v?(\d+(?:\.\d+){0,2})$/;

/** pad a 1-3 part version to full semver: `5` → `5.0.0`, `5.1` → `5.1.0`. */
function padVersion(version: string): string {
  const parts = version.split(".");
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
}

/**
 * Convert ONE Terraform version constraint string (comma-separated comparators,
 * AND semantics) into an npm semver range, or null when any comparator is
 * unparseable. `~>` is Terraform's pessimistic operator: the RIGHTMOST given
 * component may float (`~> 5.0` → `>=5.0.0 <6.0.0`, `~> 5.1.2` → `>=5.1.2 <5.2.0`,
 * `~> 5` → `>=5.0.0 <6.0.0`). `!=` comparators have no single-range npm
 * equivalent and are skipped — acceptable here because the result only ranks
 * candidate versions, it never selects what gets installed.
 */
export function terraformConstraintToRange(constraint: string): string | null {
  const parts = constraint
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const ranges: string[] = [];
  for (const part of parts) {
    const m = part.match(COMPARATOR_RE);
    if (!m) return null;
    const op = m[1] ?? "=";
    const raw = m[2];
    if (raw === undefined) return null;
    if (op === "!=") continue; // see docstring — skipped, never fatal
    const full = padVersion(raw);
    if (op === "~>") {
      const given = raw.split(".").length;
      // bump the component LEFT of the floating one: `~> 5.1.2` floats patch
      // (< 5.2.0); `~> 5.0` and `~> 5` float minor/major-rightmost (< 6.0.0).
      const upper =
        given >= 3
          ? `${semver.major(full)}.${semver.minor(full) + 1}.0`
          : `${semver.major(full) + 1}.0.0`;
      ranges.push(`>=${full} <${upper}`);
    } else if (op === "=") {
      ranges.push(full);
    } else {
      ranges.push(`${op}${full}`);
    }
  }
  return ranges.length > 0 ? ranges.join(" ") : null;
}

// --- currency classification (pure) -----------------------------------------

export interface CurrencyVerdict {
  /** newest stable version the registry publishes (null: nothing published). */
  latest: string | null;
  /** newest published version the written constraint admits (null: no
   * constraint, unparseable constraint, or nothing satisfies). */
  newestSatisfying: string | null;
  /** true when the registry has a stable version the constraint does NOT admit
   * — i.e. an upgrade PR is available. Always false without a constraint. */
  outdated: boolean;
  /** how many MAJORs the constraint's best version trails the latest by —
   * >0 signals an interface-risk upgrade that must be `needs-human`. */
  majorsBehind: number;
}

/** drop non-semver tokens and prereleases; registries publish plain versions
 * but git refs (`v1.2.0-rc1`, branch names) also land here via module pins.
 * Valid-but-prerelease versions must be dropped BEFORE any coercion — coercing
 * `7.0.0-beta1` would strip the suffix and misreport a beta as stable. */
function stableVersions(available: string[]): string[] {
  const out: string[] = [];
  for (const raw of available) {
    const exact = semver.valid(raw);
    if (exact !== null) {
      if (semver.prerelease(exact) === null) out.push(exact);
      continue;
    }
    const coerced = semver.coerce(raw);
    if (coerced !== null) out.push(coerced.version);
  }
  return out;
}

export function classifyCurrency(params: {
  constraint: string | null;
  available: string[];
}): CurrencyVerdict {
  const versions = stableVersions(params.available);
  const latest = versions.length > 0 ? (versions.sort(semver.rcompare)[0] ?? null) : null;
  if (latest === null) {
    return { latest: null, newestSatisfying: null, outdated: false, majorsBehind: 0 };
  }
  if (params.constraint === null) {
    return { latest, newestSatisfying: null, outdated: false, majorsBehind: 0 };
  }
  const range = terraformConstraintToRange(params.constraint);
  if (range === null) {
    return { latest, newestSatisfying: null, outdated: false, majorsBehind: 0 };
  }
  const newestSatisfying = semver.maxSatisfying(versions, range);
  const outdated = newestSatisfying === null || semver.lt(newestSatisfying, latest);
  const majorsBehind = newestSatisfying
    ? Math.max(0, semver.major(latest) - semver.major(newestSatisfying))
    : Math.max(0, semver.major(latest));
  return { latest, newestSatisfying, outdated, majorsBehind };
}

// --- registry lookups (I/O) --------------------------------------------------

export type LookupStatus = "ok" | "not_found" | "error" | "unsupported_source";

/** strip a leading default-registry host; reject other hosts (private/TFE
 * registries use different auth + paths — out of scope for the public check). */
function normalizeRegistryPath(base: string, expectedSegments: number): string | null {
  const segments = base.split("/").filter(Boolean);
  if (segments.length === expectedSegments + 1 && segments[0]?.includes(".")) {
    if (segments[0] !== "registry.terraform.io") return null;
    segments.shift();
  }
  return segments.length === expectedSegments ? segments.join("/") : null;
}

async function fetchVersionList(
  url: string,
  extract: (body: unknown) => string[] | null,
): Promise<{ status: LookupStatus; versions: string[] }> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return { status: "error", versions: [] };
  }
  if (response.status === 404) return { status: "not_found", versions: [] };
  if (!response.ok) return { status: "error", versions: [] };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "error", versions: [] };
  }
  const versions = extract(body);
  if (versions === null) return { status: "error", versions: [] };
  return { status: "ok", versions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** pull `[{version}, …]` out of a `{ …, versions: [...] }` payload. */
function extractVersionsArray(container: unknown): string[] | null {
  if (!isRecord(container) || !Array.isArray(container.versions)) return null;
  const out: string[] = [];
  for (const entry of container.versions) {
    if (isRecord(entry) && typeof entry.version === "string") out.push(entry.version);
  }
  return out;
}

/** GET /v1/providers/{namespace}/{type}/versions — provider release list. */
export async function fetchProviderVersions(
  source: string,
  opts: { baseUrl?: string } = {},
): Promise<{ status: LookupStatus; versions: string[] }> {
  const path = normalizeRegistryPath(source, 2);
  if (path === null) return { status: "unsupported_source", versions: [] };
  const base = opts.baseUrl ?? DEFAULT_REGISTRY_BASE_URL;
  return fetchVersionList(`${base}/v1/providers/${path}/versions`, extractVersionsArray);
}

/** GET /v1/modules/{namespace}/{name}/{provider}/versions — registry-module
 * release list (the response nests per-module records; the first is the
 * requested module, the rest are dependency records we don't want). */
export async function fetchModuleVersions(
  sourceBase: string,
  opts: { baseUrl?: string } = {},
): Promise<{ status: LookupStatus; versions: string[] }> {
  const path = normalizeRegistryPath(sourceBase, 3);
  if (path === null) return { status: "unsupported_source", versions: [] };
  const base = opts.baseUrl ?? DEFAULT_REGISTRY_BASE_URL;
  return fetchVersionList(`${base}/v1/modules/${path}/versions`, (body) => {
    if (!isRecord(body) || !Array.isArray(body.modules)) return null;
    return extractVersionsArray(body.modules[0]);
  });
}

// --- workspace report (orchestration) ----------------------------------------

export interface ProviderCurrencyRow {
  name: string;
  source: string;
  constraint: string | null;
  latest: string | null;
  newest_satisfying: string | null;
  outdated: boolean;
  majors_behind: number;
  lookup: LookupStatus;
}

export interface ModuleCurrencyRow {
  name: string;
  source: string;
  version: string | null;
  latest: string | null;
  newest_satisfying: string | null;
  outdated: boolean;
  /** registry module with no `version` attribute — pin it (to `latest`). */
  unpinned: boolean;
  lookup: LookupStatus;
  declared_in: string;
}

export interface CurrencyReport {
  providers: ProviderCurrencyRow[];
  modules: ModuleCurrencyRow[];
  outdated_count: number;
  unpinned_count: number;
  lookups_attempted: number;
  lookups_failed: number;
}

/** bare `aws` in a legacy required_providers block means `hashicorp/aws`. */
function providerSource(name: string, source: string | null): string {
  return source ?? `hashicorp/${name}`;
}

export async function checkVersionCurrency(
  cwd: string,
  opts: { baseUrl?: string } = {},
): Promise<CurrencyReport> {
  const providerReqs = collectProviderRequirements(cwd);
  const registryModules = collectModuleGraph(cwd).modules.filter((m) => m.kind === "registry");

  // one lookup per distinct source — a workspace redeclaring `hashicorp/aws`
  // in every root must not turn into N identical registry calls.
  const providerLookups = new Map<string, Promise<{ status: LookupStatus; versions: string[] }>>();
  for (const req of providerReqs) {
    const source = providerSource(req.name, req.source);
    if (!providerLookups.has(source)) {
      providerLookups.set(source, fetchProviderVersions(source, opts));
    }
  }
  const moduleLookups = new Map<string, Promise<{ status: LookupStatus; versions: string[] }>>();
  for (const mod of registryModules) {
    const base = splitModuleSource(mod.source).base;
    if (!moduleLookups.has(base)) {
      moduleLookups.set(base, fetchModuleVersions(base, opts));
    }
  }
  // resolve every lookup up front so the row loops below read settled results
  // (and so a missing map entry can degrade to an error row, not a crash).
  const noLookup = { status: "error" as LookupStatus, versions: [] as string[] };
  const providerResults = new Map(
    await Promise.all([...providerLookups].map(async ([source, p]) => [source, await p] as const)),
  );
  const moduleResults = new Map(
    await Promise.all([...moduleLookups].map(async ([base, p]) => [base, await p] as const)),
  );

  const providers: ProviderCurrencyRow[] = [];
  for (const req of providerReqs) {
    const source = providerSource(req.name, req.source);
    const result = providerResults.get(source) ?? noLookup;
    const verdict = classifyCurrency({ constraint: req.version, available: result.versions });
    providers.push({
      name: req.name,
      source,
      constraint: req.version,
      latest: verdict.latest,
      newest_satisfying: verdict.newestSatisfying,
      outdated: result.status === "ok" && verdict.outdated,
      majors_behind: result.status === "ok" ? verdict.majorsBehind : 0,
      lookup: result.status,
    });
  }

  const modules: ModuleCurrencyRow[] = [];
  for (const mod of registryModules) {
    const base = splitModuleSource(mod.source).base;
    const result = moduleResults.get(base) ?? noLookup;
    const verdict = classifyCurrency({ constraint: mod.version, available: result.versions });
    modules.push({
      name: mod.name,
      source: mod.source,
      version: mod.version,
      latest: verdict.latest,
      newest_satisfying: verdict.newestSatisfying,
      outdated: result.status === "ok" && verdict.outdated,
      unpinned: mod.version === null,
      lookup: result.status,
      declared_in: mod.declaredIn,
    });
  }

  const failed = [...providers, ...modules].filter(
    (row) => row.lookup === "error" || row.lookup === "not_found",
  ).length;
  return {
    providers,
    modules,
    outdated_count: [...providers, ...modules].filter((r) => r.outdated).length,
    unpinned_count: modules.filter((m) => m.unpinned).length,
    lookups_attempted: providers.length + modules.length,
    lookups_failed: failed,
  };
}
