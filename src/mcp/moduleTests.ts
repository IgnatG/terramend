import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import type { LocalToolContext } from "#app/mcp/localContext";
import { collectModuleInterface } from "#app/mcp/modules";
import { resolveWithinCwd } from "#app/mcp/pathSafety";
import { execute, tool, toolOk } from "#app/mcp/shared";
import { log } from "#app/utils/cli";

/**
 * §28 (remediation slice) — keep a reusable module's EXISTING tests/examples
 * consistent with a fix. `scaffold_terratest` covers the GENERATION direction
 * (new module → new plan-only tests). This is the inverse: when Remediate fixes
 * an existing local/house module and the fix changes the module's public
 * interface (adds a required `variable`, renames or removes one, tightens a
 * type), the module's `examples/` fixtures and `terraform test` / Terratest
 * files that CALL it can silently go stale — a missing required variable breaks
 * `terraform test`/`plan`, and a reference to a removed variable is an error.
 *
 * This module finds those test/example assets for a module dir and computes the
 * DRIFT between what each asset passes and the module's CURRENT interface, so the
 * agent updates exactly the assets that need it (and only those) after a fix —
 * never weakening an assertion to go green. The parsing is pure + unit-tested;
 * the collector just reads the conventional locations (no full-repo walk).
 */

export type ModuleTestAssetKind = "example" | "native-test" | "go-test";

export interface ModuleTestAsset {
  /** repo-relative path: a dir for examples, a file for native/go tests. */
  path: string;
  kind: ModuleTestAssetKind;
  /** variable names the asset passes to the module (best-effort for go tests). */
  set_variables: string[];
}

export interface ModuleTestDrift {
  path: string;
  kind: ModuleTestAssetKind;
  /** required module variables the asset does NOT set (would break plan/test). */
  missing_required: string[];
  /** variables the asset sets that are NOT in the module interface — the fix
   * renamed or removed them, so the reference is now stale/an error. */
  unknown_set: string[];
}

export interface ModuleTestReport {
  module_dir: string;
  /** the module's CURRENT interface, the truth the assets must match. */
  required_variables: string[];
  variable_names: string[];
  assets: ModuleTestAsset[];
  drift: ModuleTestDrift[];
}

// module-block meta-arguments that are not module variables — excluded when
// reading which variables an example's `module` block sets.
const MODULE_META_ARGS = new Set([
  "source",
  "version",
  "providers",
  "count",
  "for_each",
  "depends_on",
  "lifecycle",
]);

/** collapse every nested `{…}` span (to a fixpoint) so an attribute name INSIDE
 * an object value or a nested block isn't read as a top-level attribute. Mirrors
 * the helper in modules.ts (kept local to avoid widening that module's surface). */
function stripNestedBraces(s: string): string {
  let prev: string;
  let cur = s;
  do {
    prev = cur;
    cur = cur.replace(/\{[^{}]*\}/g, " ");
  } while (cur !== prev);
  return cur;
}

/**
 * The TOP-LEVEL attribute names assigned (`name = …`) directly in an HCL block
 * body — nested-block / object-field keys are excluded by collapsing `{…}` spans
 * first. Pure. Used for both a `module` block's arguments and a `variables {}`
 * block's entries. `==`/`>=`/`!=` etc. are excluded via the `=(?!=)` guard and
 * by requiring the name to start a line.
 */
export function topLevelAttributeNames(body: string): string[] {
  const flat = stripNestedBraces(body);
  const names: string[] = [];
  const re = /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=(?!=)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex-exec iteration
  while ((m = re.exec(flat)) !== null) names.push(m[1]!);
  return names;
}

/** brace-match the body of every `<header>{` occurrence. `headerRe` must end its
 * match at the `{` of the block. Returns each block's inner body. Pure. */
function eachBlockBody(hcl: string, headerRe: RegExp): string[] {
  const out: string[] = [];
  // exec advances headerRe.lastIndex to just past the `{`; the capture groups are
  // unused here (we only need the brace position), so we don't bind the match.
  while (headerRe.exec(hcl) !== null) {
    const braceStart = headerRe.lastIndex - 1;
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
    out.push(hcl.slice(braceStart + 1, end));
    headerRe.lastIndex = end + 1;
  }
  return out;
}

/** the `source = "…"` of a module block body (for matching an example back to a
 * module dir), or null. */
function moduleBlockSource(body: string): string | null {
  return body.match(/(?:^|\n)\s*source\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

/**
 * Variables an example sets on the module(s) whose `source` satisfies
 * `sourceMatches` — the union of the matching `module` blocks' top-level
 * arguments (minus meta-args like `source`/`version`/`count`). Pure. Returns []
 * when no module block in the HCL targets the module.
 */
export function parseExampleModuleVariables(
  hcl: string,
  sourceMatches: (source: string) => boolean,
): string[] {
  const set = new Set<string>();
  for (const body of eachBlockBody(hcl, /module\s+"[^"]+"\s*\{/g)) {
    const source = moduleBlockSource(body);
    if (!source || !sourceMatches(source)) continue;
    for (const name of topLevelAttributeNames(body)) {
      if (!MODULE_META_ARGS.has(name)) set.add(name);
    }
  }
  return [...set];
}

/**
 * Variables a Terraform-native test (`*.tftest.hcl`) sets — the union of every
 * `variables { … }` block's top-level entries (the top-level block plus any
 * inside `run "…" { … }`). When the test lives in the module's own dir it tests
 * the module in place, so these are the module's variables. Pure.
 */
export function parseNativeTestVariables(hcl: string): string[] {
  const set = new Set<string>();
  for (const body of eachBlockBody(hcl, /(?:^|\n)\s*variables\s*\{/g)) {
    for (const name of topLevelAttributeNames(body)) set.add(name);
  }
  return [...set];
}

/**
 * Variable keys a Go Terratest sets — the `"<key>":` entries inside a
 * `Vars: map[string]interface{}{ … }` (or `map[string]any{ … }`) literal.
 * Best-effort (Go isn't parsed structurally); advisory only. Pure.
 */
export function parseGoTestVariables(go: string): string[] {
  const set = new Set<string>();
  const varsBlock = go.match(/Vars\s*:\s*map\[string\](?:interface\{\}|any)\s*\{/);
  if (!varsBlock || varsBlock.index === undefined) return [];
  const start = go.indexOf("{", varsBlock.index + varsBlock[0].length - 1);
  if (start === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < go.length; i++) {
    if (go[i] === "{") depth++;
    else if (go[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  const body = go.slice(start + 1, end);
  // only KEYS that begin a map entry: a quoted string followed by ':'. A commented
  // line ('// "x": nil') still counts as a referenced variable — that's the TODO
  // placeholder the scaffold writes, and it should track the interface too.
  const re = /"([A-Za-z_][A-Za-z0-9_-]*)"\s*:/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex-exec iteration
  while ((m = re.exec(body)) !== null) set.add(m[1]!);
  return [...set];
}

/**
 * Drift between what an asset passes and the module's CURRENT interface:
 * `missing_required` (required vars the asset never sets) and `unknown_set`
 * (vars the asset sets that the module no longer declares). Pure.
 */
export function computeInterfaceDrift(input: {
  setVariables: string[];
  requiredVariables: string[];
  variableNames: string[];
}): { missing_required: string[]; unknown_set: string[] } {
  const set = new Set(input.setVariables);
  const declared = new Set(input.variableNames);
  const missing_required = input.requiredVariables.filter((v) => !set.has(v));
  const unknown_set = input.setVariables.filter((v) => !declared.has(v));
  return { missing_required, unknown_set };
}

/** normalize a POSIX path, resolving `.`/`..` segments (local copy of the
 * modules.ts helper, kept private to avoid widening that module's API). */
function normalizeRel(path: string): string {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** resolve a module-block `source` (relative to the dir that DECLARES it) to a
 * repo-relative dir, for matching against the module under test. */
function resolveSourceDir(fromDir: string, source: string): string {
  const raw = source.replace(/\\/g, "/");
  return normalizeRel(fromDir ? `${fromDir}/${raw}` : raw);
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listFiles(absDir: string, suffix: string): string[] {
  try {
    return readdirSync(absDir)
      .filter((f) => f.endsWith(suffix))
      .sort();
  } catch {
    return [];
  }
}

function listSubdirs(absDir: string): string[] {
  try {
    return readdirSync(absDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function readAllTf(cwd: string, relDir: string): string {
  let text = "";
  for (const f of listFiles(join(cwd, relDir), ".tf")) {
    try {
      text += `${readFileSync(join(cwd, relDir, f), "utf8")}\n`;
    } catch {
      /* skip unreadable */
    }
  }
  return text;
}

/**
 * Find a module's existing test/example assets in the conventional locations and
 * record which of the module's variables each one passes. Reads only the module's
 * own `examples/`/`tests/`/`test/` dirs and the repo-root `examples/` (no
 * full-tree walk). `moduleDir` is repo-relative POSIX. Side-effecting (reads fs).
 */
export function discoverModuleTestAssets(cwd: string, moduleDir: string): ModuleTestAsset[] {
  const md = normalizeRel(moduleDir);
  const assets: ModuleTestAsset[] = [];
  const matchesModule = (source: string, fromDir: string): boolean =>
    resolveSourceDir(fromDir, source) === md;

  // examples: each subdir of `<moduleDir>/examples` or the repo-root `examples`
  // whose `module` block sources resolve back to this module dir.
  for (const examplesRoot of [`${md}/examples`, "examples"]) {
    if (!isDir(join(cwd, examplesRoot))) continue;
    for (const sub of listSubdirs(join(cwd, examplesRoot))) {
      const exDir = `${examplesRoot}/${sub}`;
      const hcl = readAllTf(cwd, exDir);
      if (!hcl) continue;
      const vars = parseExampleModuleVariables(hcl, (s) => matchesModule(s, exDir));
      // only count it as THIS module's example when a module block actually
      // targets it (an `examples/` tree can hold fixtures for sibling modules).
      const targets = eachBlockBody(hcl, /module\s+"[^"]+"\s*\{/g).some((b) => {
        const src = moduleBlockSource(b);
        return src !== null && matchesModule(src, exDir);
      });
      if (targets) assets.push({ path: exDir, kind: "example", set_variables: vars });
    }
  }

  // native tests: `*.tftest.hcl` in the module's own dir or its `tests/` dir —
  // these run the module in place, so their `variables {}` set its variables.
  for (const testDir of [`${md}/tests`, md]) {
    if (!isDir(join(cwd, testDir))) continue;
    for (const f of listFiles(join(cwd, testDir), ".tftest.hcl")) {
      const rel = `${testDir}/${f}`;
      let hcl: string;
      try {
        hcl = readFileSync(join(cwd, rel), "utf8");
      } catch {
        continue;
      }
      assets.push({ path: rel, kind: "native-test", set_variables: parseNativeTestVariables(hcl) });
    }
  }

  // go Terratest co-located with the module (`<moduleDir>/test` or `/tests`).
  for (const goDir of [`${md}/test`, `${md}/tests`]) {
    if (!isDir(join(cwd, goDir))) continue;
    for (const f of listFiles(join(cwd, goDir), "_test.go")) {
      const rel = `${goDir}/${f}`;
      let go: string;
      try {
        go = readFileSync(join(cwd, rel), "utf8");
      } catch {
        continue;
      }
      assets.push({ path: rel, kind: "go-test", set_variables: parseGoTestVariables(go) });
    }
  }

  return assets;
}

/**
 * Build the module's test/example consistency report: its current interface, the
 * discovered assets, and the per-asset drift against that interface. Side-effecting
 * (reads fs). The agent reads `drift` to know which assets to update after a fix.
 */
export function analyzeModuleTests(cwd: string, moduleDir: string): ModuleTestReport {
  const iface = collectModuleInterface(cwd, moduleDir);
  const requiredVariables = iface.variables.filter((v) => v.required).map((v) => v.name);
  const variableNames = iface.variables.map((v) => v.name);
  const assets = discoverModuleTestAssets(cwd, moduleDir);

  const drift: ModuleTestDrift[] = [];
  for (const a of assets) {
    const d = computeInterfaceDrift({
      setVariables: a.set_variables,
      requiredVariables,
      variableNames,
    });
    if (d.missing_required.length > 0 || d.unknown_set.length > 0) {
      drift.push({ path: a.path, kind: a.kind, ...d });
    }
  }

  return {
    module_dir: normalizeRel(moduleDir),
    required_variables: requiredVariables,
    variable_names: variableNames,
    assets,
    drift,
  };
}

export const TerraformModuleTestsParams = type({
  module_dir: type.string.describe(
    "the reusable module's repo-relative dir (e.g. 'modules/vpc') — typically a `local_module_dir` from terraform_module_graph that you just fixed.",
  ),
});

export function TerraformModuleTestsTool(ctx: LocalToolContext) {
  return tool({
    name: "terraform_module_tests",
    description:
      "§28 — after FIXING a reusable module, check its EXISTING `examples/` fixtures and `terraform test` " +
      "(`*.tftest.hcl`) / Go Terratest files for consistency with the module's CURRENT interface. Returns " +
      "the module's `required_variables` + `variable_names`, the discovered test/example `assets` (with the " +
      "variables each one passes to the module), and `drift` — per asset, the `missing_required` variables it " +
      "fails to set (a fix that added a required `variable` breaks these) and the `unknown_set` variables it " +
      "passes that the module no longer declares (the fix renamed/removed them). Update exactly the drifting " +
      "assets to match the new interface; NEVER weaken or delete an assertion just to make a test pass. " +
      "Complements `scaffold_terratest` (which GENERATES tests for a new module). Read-only — it reports what " +
      "to change; you edit the files with your own tools. Returns empty `assets` when the module ships none.",
    parameters: TerraformModuleTestsParams,
    execute: execute(async ({ module_dir }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      // SECURITY: confine the agent-supplied dir to the workspace so it can't be
      // used to read `*.tf`/test files from outside the repo (e.g. '../../etc').
      resolveWithinCwd(cwd, module_dir);
      const report = analyzeModuleTests(cwd, module_dir);
      log.info(
        `» terraform_module_tests(${report.module_dir}): ${report.assets.length} asset(s), ` +
          `${report.drift.length} drifting`,
      );
      return toolOk({
        module_dir: report.module_dir,
        required_variables: report.required_variables,
        variable_names: report.variable_names,
        has_assets: report.assets.length > 0,
        assets: report.assets,
        drift: report.drift,
        note:
          report.assets.length === 0
            ? "This module ships no examples/ or tests — nothing to keep consistent (consider scaffold_terratest if generating coverage is in scope)."
            : report.drift.length === 0
              ? "All examples/tests still match the module interface — no update needed."
              : "Update the drifting assets to match the new interface; never weaken an assertion to go green.",
      });
    }),
  });
}
