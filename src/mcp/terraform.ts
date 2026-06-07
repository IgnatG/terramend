import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type } from "arktype";
import { log } from "#app/utils/cli";
import { resolveEnv } from "#app/utils/secrets";
import { walkTfFiles } from "#app/mcp/modules";
import { loadProvidersSchema, unknownArgsForResource } from "#app/mcp/providerSchema";
import { discoverTerraformRoots } from "#app/mcp/roots";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool, toolOk, toolSkip } from "#app/mcp/shared";

/**
 * A degrade-green skip result carrying the structured §3.5 envelope
 * (`ok: false` + machine `code` + human `detail`) PLUS the legacy alias the tool
 * returned before it converged on the envelope — `ran`/`found` and
 * `skipped_reason`/`reason` — so existing prompt + test contracts keep working.
 * Additive, never breaking. `extra` folds in any tool-specific fields (e.g.
 * read_findings' empty `concerns`/`groups`).
 */
function skipResult(
  code: string,
  detail: string,
  opts: { key?: "ran" | "found"; reasonKey?: "skipped_reason" | "reason"; extra?: Record<string, any> } = {}
): Record<string, any> {
  const key = opts.key ?? "ran";
  const reasonKey = opts.reasonKey ?? "skipped_reason";
  return { ...toolSkip(code, detail), [key]: false, [reasonKey]: detail, ...(opts.extra ?? {}) };
}

/**
 * Internal "concern" model — the Remediator's ground truth for "what is not
 * best practice". Produced by `terraform_scan` from the fork's own deterministic
 * Terraform check tools (fmt / validate / tflint / trivy / checkov).
 *
 * This is a deliberate SUBSET of the reviewer's `findings.schema.json` v1.0
 * (../terraform-reviewer/schemas/findings.schema.json). The reviewer's findings
 * add `lens` / `standard` / `control_id` / `state` on top. Keeping the shape a
 * subset means a future reviewer integration (read_findings) can emit the same
 * Concern[] with no change to the modes or the rest of the tools — only the
 * SOURCE of concerns swaps.
 */
export interface Concern {
  /** stable content id: sha1(source|rule_id|file|line). idempotency key for branch/PR naming. */
  id: string;
  /** producing tool. `reviewer` marks a concern loaded from a terraform-reviewer
   * findings.json whose original tool isn't one Terramend re-runs (tfsec / infracost
   * / llm) — its provenance lives in `rule_id`. */
  source: "terraform-fmt" | "terraform-validate" | "tflint" | "trivy" | "checkov" | "reviewer";
  /** original namespaced rule, e.g. "trivy:AVD-AWS-0088" */
  rule_id: string;
  severity: Severity;
  category: "security" | "style" | "correctness" | "cost";
  /** the scanner message — what is wrong */
  evidence: string;
  location: { file: string; line: number | null };
  remediation_hint: string | null;
}

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type Severity = (typeof SEVERITIES)[number];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function concernId(source: string, ruleId: string, file: string, line: number | null): string {
  return createHash("sha1")
    .update(`${source}|${ruleId}|${file}|${line ?? ""}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Normalize a scanner-reported path to a repo-relative POSIX path. Each scanner
 * reports the file differently — tflint gives `main.tf` (relative), trivy a
 * scan-dir-relative `Target`, terraform an absolute path (`/repo/main.tf` or
 * `D:\repo\main.tf`), checkov a leading-slash path (`/main.tf`). Left
 * unnormalized, these leak into `location.file` AND the
 * content-derived `concernId`, making the id (and the `remediate/<id>` branch)
 * machine-dependent and breaking the ✗→✓ re-scan id match across environments.
 * So normalize BEFORE building any Concern.
 */
function toRepoRelative(raw: string | undefined, cwd: string): string {
  if (!raw) return "(unknown)";
  const posix = raw.replace(/\\/g, "/");
  const cwdPosix = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  let rel = posix;
  if (cwdPosix && posix.toLowerCase().startsWith(`${cwdPosix.toLowerCase()}/`)) {
    rel = posix.slice(cwdPosix.length + 1);
  }
  // strip any leading "./" or "/" (checkov reports paths relative to its -d root
  // with a leading separator).
  rel = rel.replace(/^(?:\.\/|\/)+/, "");
  return rel || "(unknown)";
}

type RunResult = { status: number; stdout: string; stderr: string; missing: boolean };

/**
 * Run a scanner without throwing. Terraform tools exit non-zero when they FIND
 * issues, so a non-zero status is normal, not an error. `missing` is set when
 * the binary isn't on PATH (ENOENT) — the scanner then degrades to "skipped"
 * rather than failing the run (plan §9.2: a tool being absent must not block).
 *
 * `extraEnv` opts a specific command back into a needed credential: the scanners
 * run with a restricted env that strips every `*_KEY`/secret, but infracost
 * legitimately needs its `INFRACOST_API_KEY`. resolveEnv(object) merges the
 * restricted base with the explicit vars, so only the named keys get through.
 */
function run(cmd: string, args: string[], cwd: string, extraEnv?: Record<string, string>): RunResult {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    // restricted env: keeps PATH/HOME, strips secrets so a scanner (or a tflint
    // plugin) can't exfiltrate credentials. `extraEnv` re-admits only the named vars.
    env: resolveEnv(extraEnv ?? "restricted") as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    return { status: -1, stdout: "", stderr: result.error.message, missing };
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing: false,
  };
}

type ScannerOutcome = {
  source: Concern["source"];
  ran: boolean;
  skipped_reason?: string;
  concerns: Concern[];
};

function skipped(source: Concern["source"], reason: string): ScannerOutcome {
  return { source, ran: false, skipped_reason: reason, concerns: [] };
}

// dirs already `terraform init`-ed this process, so repeated scans don't re-init.
const initedDirs = new Set<string>();

/**
 * Run `terraform init -backend=false` once per dir so `terraform validate` has
 * provider schemas to check against (Bug 3 / gap B). Without init, validate only
 * emits "missing required provider" — which VALIDATE_NOISE drops — so it was
 * effectively inert. `-backend=false` avoids needing real backend credentials;
 * `-input=false` keeps it non-interactive. Network-dependent and best-effort: if
 * it fails (offline, private module, etc.) validate still runs, just shallow.
 */
function ensureTerraformInit(cwd: string): void {
  if (initedDirs.has(cwd)) return;
  const r = run("terraform", ["init", "-backend=false", "-input=false", "-no-color"], cwd);
  // mark done even on non-zero: a failed init won't succeed on retry within the
  // same run, and we don't want to re-run it for every scanner call.
  initedDirs.add(cwd);
  if (r.status !== 0 && !r.missing) {
    log.info(`» terraform init (for validate) did not complete cleanly — validate may be shallow`);
  }
}

// --- terraform fmt -------------------------------------------------------

function scanFmt(cwd: string): ScannerOutcome {
  const r = run("terraform", ["fmt", "-check", "-recursive", "-list=true"], cwd);
  if (r.missing) return skipped("terraform-fmt", "terraform not installed");
  // exit 0 = all formatted; exit 3 = files need formatting (lists them on stdout);
  // other non-zero = real error (e.g. parse failure) — surface nothing, validate covers it.
  if (r.status === 0) return { source: "terraform-fmt", ran: true, concerns: [] };
  return { source: "terraform-fmt", ran: true, concerns: parseFmtOutput(r.stdout, cwd) };
}

/** `terraform fmt -check -list=true` prints one unformatted file path per line. */
export function parseFmtOutput(stdout: string, cwd = ""): Concern[] {
  const files = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return files.map<Concern>((raw) => {
    const file = toRepoRelative(raw, cwd);
    return {
      id: concernId("terraform-fmt", "unformatted", file, null),
      source: "terraform-fmt",
      rule_id: "terraform-fmt:unformatted",
      severity: "low",
      category: "style",
      evidence: "File does not match `terraform fmt` canonical style.",
      location: { file, line: null },
      remediation_hint: "Run `terraform fmt` to apply canonical formatting.",
    };
  });
}

// --- terraform validate ---------------------------------------------------

// diagnostics that are environmental (the dir isn't initialized, or a provider
// plugin failed to install/launch) rather than a real best-practice issue.
// dropped so a scan can't emit false positives from toolchain hiccups — e.g.
// after `terraform init` (Bug 3), a crashed provider plugin surfaces as
// "Failed to load plugin schemas", which is noise, not a defect in the HCL.
const VALIDATE_NOISE = [
  "terraform init",
  "missing required provider",
  "module not installed",
  "module is not yet installed",
  "required plugins are not installed",
  "uninitialized",
  "failed to load plugin",
  "plugin did not respond",
  "could not load plugin",
];

// --- root resolution (multi-root awareness) --------------------------------

export interface ResolvedRoot {
  /** absolute dir the per-root command (init/plan/validate) runs in. */
  absDir: string;
  /** that root's path relative to the scan `cwd` ("" when the root IS cwd) —
   * prepended to per-root concern files so they stay cwd-relative. */
  relDir: string;
}

/**
 * The Terraform root modules to operate on under `cwd`. A repo can hold several
 * roots (hepcare: `terraform/` + `terraform/core/`); `terraform validate` /
 * `plan` are per-root, so they must run in EACH. Falls back to `cwd` itself as a
 * single root when none is detected — so a normal single-root repo behaves
 * exactly as before (no rebasing, one iteration).
 */
export function resolveRoots(cwd: string): ResolvedRoot[] {
  const discovered = discoverTerraformRoots(cwd);
  if (discovered.length === 0) return [{ absDir: cwd, relDir: "" }];
  return discovered.map((r) => ({ absDir: r.dir ? join(cwd, r.dir) : cwd, relDir: r.dir }));
}

/**
 * Re-base a concern produced by a per-root command (its file is relative to the
 * root dir) onto the scan `cwd` by prefixing the root's `relDir`, and recompute
 * the content id so it stays consistent with the cwd-relative scanners (✗→✓).
 * A no-op when `relDir` is "" (the root IS cwd).
 */
export function rebaseConcern(c: Concern, relDir: string): Concern {
  if (!relDir) return c;
  const file = `${relDir}/${c.location.file}`.replace(/\/+/g, "/");
  const prefix = `${c.source}:`;
  const bareRule = c.rule_id.startsWith(prefix) ? c.rule_id.slice(prefix.length) : c.rule_id;
  return {
    ...c,
    location: { ...c.location, file },
    id: concernId(c.source, bareRule, file, c.location.line),
  };
}

/** run `terraform validate` in one root and return concerns re-based onto cwd. */
function scanValidateRoot(root: ResolvedRoot): ScannerOutcome {
  ensureTerraformInit(root.absDir);
  const r = run("terraform", ["validate", "-json"], root.absDir);
  if (r.missing) return skipped("terraform-validate", "terraform not installed");
  try {
    const concerns = parseValidateOutput(r.stdout, root.absDir).map((c) => rebaseConcern(c, root.relDir));
    return { source: "terraform-validate", ran: true, concerns };
  } catch {
    return skipped("terraform-validate", "could not parse `terraform validate -json` output");
  }
}

/**
 * Run `terraform validate` across EVERY root and aggregate. `validate` is the
 * one scanner that's per-root (fmt/tflint/trivy/checkov are recursive over the
 * whole tree), so a multi-root repo only catches subdir-root validate errors
 * when we visit each root.
 */
function scanValidate(cwd: string): ScannerOutcome {
  const roots = resolveRoots(cwd);
  const concerns: Concern[] = [];
  let anyRan = false;
  let sawMissing = false;
  for (const root of roots) {
    const outcome = scanValidateRoot(root);
    if (outcome.ran) {
      anyRan = true;
      concerns.push(...outcome.concerns);
    } else if (outcome.skipped_reason?.includes("not installed")) {
      sawMissing = true;
    }
  }
  if (!anyRan) {
    return sawMissing
      ? skipped("terraform-validate", "terraform not installed")
      : skipped("terraform-validate", "could not parse `terraform validate -json` output");
  }
  return { source: "terraform-validate", ran: true, concerns: dedupe(concerns) };
}

/** parse `terraform validate -json`; keeps real errors, drops uninitialized-dir noise. */
export function parseValidateOutput(stdout: string, cwd = ""): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as { diagnostics?: ValidateDiagnostic[] };
  const diags = (parsed.diagnostics ?? []).filter((d) => d.severity === "error");
  const concerns: Concern[] = [];
  for (const d of diags) {
    const text = `${d.summary ?? ""} ${d.detail ?? ""}`.toLowerCase();
    if (VALIDATE_NOISE.some((n) => text.includes(n))) continue;
    const file = toRepoRelative(d.range?.filename, cwd);
    const line = d.range?.start?.line ?? null;
    concerns.push({
      id: concernId("terraform-validate", d.summary ?? "error", file, line),
      source: "terraform-validate",
      rule_id: `terraform-validate:${d.summary ?? "error"}`,
      severity: "high",
      category: "correctness",
      evidence: [d.summary, d.detail].filter(Boolean).join(" — "),
      location: { file, line },
      remediation_hint: null,
    });
  }
  return concerns;
}

interface ValidateDiagnostic {
  severity?: string;
  summary?: string;
  detail?: string;
  range?: { filename?: string; start?: { line?: number } };
}

// --- provider-version awareness (§4.15) ------------------------------------

export interface ProviderRequirement {
  /** local name, e.g. `aws`. */
  name: string;
  /** registry source, e.g. `hashicorp/aws`, or null (legacy string form). */
  source: string | null;
  /** raw version constraint, e.g. `~> 5.0`, or null when unconstrained. */
  version: string | null;
  /** the pinned MAJOR (the lower-bound major of the constraint) — the number a
   * fix must target, since argument schemas differ across provider majors. */
  major: number | null;
}

/** the lower-bound major version from a constraint string (`~> 5.0` → 5,
 * `>= 3.1, < 4.0` → 3, `5` → 5). null when no number is present. */
function majorOf(version: string | null): number | null {
  if (!version) return null;
  const m = version.match(/(\d+)\s*\.\s*\d+/) ?? version.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Parse every `required_providers { … }` block in some HCL text into the pinned
 * provider requirements. Handles the modern object form
 * (`aws = { source = "hashicorp/aws", version = "~> 5.0" }`) and the legacy
 * string form (`aws = "~> 5.0"`). A repo's "correct" fix depends on the provider
 * MAJOR — argument names and valid blocks differ across AWS/Azure majors — so
 * surfacing the pinned major lets a fix target the right schema instead of
 * breaking `plan`. Brace-matched (not a fragile single regex) so nested objects
 * don't confuse it. First declaration of a name wins (dedup across files).
 */
export function parseRequiredProviders(hcl: string): ProviderRequirement[] {
  const out: ProviderRequirement[] = [];
  const seen = new Set<string>();
  let searchFrom = 0;
  for (;;) {
    const idx = hcl.indexOf("required_providers", searchFrom);
    if (idx === -1) break;
    const braceStart = hcl.indexOf("{", idx);
    if (braceStart === -1) break;
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
    searchFrom = end + 1;

    // object form: name = { source = "…", version = "…" }
    const objRe = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = objRe.exec(body)) !== null) {
      const name = m[1];
      const inner = m[2];
      if (seen.has(name)) continue;
      seen.add(name);
      const source = inner.match(/source\s*=\s*"([^"]+)"/)?.[1] ?? null;
      const version = inner.match(/version\s*=\s*"([^"]+)"/)?.[1] ?? null;
      out.push({ name, source, version, major: majorOf(version) });
    }
    // legacy string form: name = "version" — run on the body with object blocks
    // stripped so an object's inner `source =`/`version =` lines aren't matched.
    const bodyNoObjects = body.replace(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*\{[^}]*\}/g, "");
    const strRe = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]+)"/g;
    while ((m = strRe.exec(bodyNoObjects)) !== null) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source: null, version: m[2], major: majorOf(m[2]) });
    }
  }
  return out;
}

/** read the repo's `*.tf` files (recursively — root + subdir roots + nested
 * modules) and parse their pinned provider requirements (best-effort; an
 * unreadable tree yields none). First declaration of a provider wins. */
export function collectProviderRequirements(cwd: string): ProviderRequirement[] {
  let text = "";
  for (const f of walkTfFiles(cwd)) {
    try {
      text += `${readFileSync(join(cwd, f), "utf8")}\n`;
    } catch {
      /* skip unreadable file */
    }
  }
  return parseRequiredProviders(text);
}

// --- §4.15-next: argument-vs-schema validation ------------------------------

/** the top-level arguments of a single `resource` block. */
export interface ResourceArguments {
  resourceType: string;
  /** the resource's local name (`resource "aws_s3_bucket" "<name>"`). */
  name: string;
  /** top-level attribute + nested-block names (meta-arguments excluded). */
  args: string[];
}

// Terraform meta-arguments are valid on EVERY resource and never appear in a
// provider's schema — exclude them so they're not flagged as unknown. `dynamic`
// is handled specially (its quoted label is the real block name).
const RESOURCE_META_ARGUMENTS: ReadonlySet<string> = new Set([
  "count",
  "for_each",
  "provider",
  "depends_on",
  "lifecycle",
  "provisioner",
  "connection",
]);

/**
 * Parse every `resource "<type>" "<name>" { … }` block's TOP-LEVEL argument
 * names (attributes assigned with `=` and nested block labels) from some HCL.
 * Conservative by design — it skips `"…"` strings and `#`/`//` line comments so
 * an interpolation's braces or a commented line can't corrupt the brace depth or
 * fabricate an argument, and only reports depth-0 names. A `dynamic "x"` block
 * contributes `x` (the generated block type). Used to cross-check written
 * arguments against the installed provider schema; pure.
 */
export function parseResourceArguments(hcl: string): ResourceArguments[] {
  const out: ResourceArguments[] = [];
  const re = /(?:^|\n)\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hcl)) !== null) {
    const resourceType = m[1];
    const name = m[2];
    const braceStart = hcl.indexOf("{", m.index);
    if (braceStart === -1) break;
    const body = matchBraceBody(hcl, braceStart);
    if (!body) break;
    re.lastIndex = body.end + 1;
    out.push({ resourceType, name, args: topLevelArgNames(body.text) });
  }
  return out;
}

/**
 * If position `i` begins a heredoc (`<<EOF` / `<<-EOF` / `<<~EOF`), return the
 * index of the last char of its closing-delimiter line (so the scanner resumes
 * after it); else null. Heredoc bodies are arbitrary text — they may contain
 * unbalanced `{`/`}` and `key = value` lines — so they MUST be skipped wholesale
 * or they corrupt brace depth and fabricate arguments.
 */
function skipHeredoc(s: string, i: number): number | null {
  const m = /^<<[-~]?([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i, i + 80));
  if (!m) return null;
  const delim = m[1];
  const openNl = s.indexOf("\n", i);
  if (openNl === -1) return s.length - 1; // unterminated — consume the rest
  // the closing delimiter sits alone on its own line (optionally indented).
  const closeRe = new RegExp(`\\n[ \\t]*${delim}[ \\t]*(?=\\n|$)`);
  const after = s.slice(openNl);
  const cm = closeRe.exec(after);
  if (!cm) return s.length - 1;
  return openNl + cm.index + cm[0].length - 1;
}

/** brace-match from an opening `{` at `open`; returns the inner text + end index
 * (the matching `}`), string/comment/heredoc-aware so interpolation braces, a
 * commented `}`, or a heredoc body don't fool it. */
function matchBraceBody(hcl: string, open: string | number): { text: string; end: number } | null {
  const start = typeof open === "number" ? open : -1;
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < hcl.length; i++) {
    const ch = hcl[i];
    // skip a double-quoted string (with escapes) so `${…}` braces don't count.
    if (ch === '"') {
      i++;
      while (i < hcl.length && hcl[i] !== '"') {
        if (hcl[i] === "\\") i++;
        i++;
      }
      continue;
    }
    // skip a heredoc body (may hold unbalanced braces).
    if (ch === "<" && hcl[i + 1] === "<") {
      const end = skipHeredoc(hcl, i);
      if (end !== null) {
        i = end;
        continue;
      }
    }
    // skip a `#` or `//` line comment.
    if (ch === "#" || (ch === "/" && hcl[i + 1] === "/")) {
      const nl = hcl.indexOf("\n", i);
      if (nl === -1) return null;
      i = nl;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { text: hcl.slice(start + 1, i), end: i };
    }
  }
  return null;
}

/** extract the depth-0 argument names from a resource block body (string- and
 * comment-aware), excluding meta-arguments. */
function topLevelArgNames(body: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  let atStmtStart = true;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') {
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") i++;
        i++;
      }
      atStmtStart = false;
      continue;
    }
    // skip a heredoc body (arbitrary text — may hold `key = value` lines that
    // would otherwise be misread as arguments).
    if (ch === "<" && body[i + 1] === "<") {
      const end = skipHeredoc(body, i);
      if (end !== null) {
        i = end;
        atStmtStart = true;
        continue;
      }
    }
    if (ch === "#" || (ch === "/" && body[i + 1] === "/")) {
      const nl = body.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      atStmtStart = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      atStmtStart = false;
      continue;
    }
    if (ch === "}") {
      depth--;
      atStmtStart = false;
      continue;
    }
    if (ch === "\n") {
      atStmtStart = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") continue;
    // a non-space char that starts a statement at depth 0 → read an identifier.
    if (depth === 0 && atStmtStart && /[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < body.length && /[A-Za-z0-9_-]/.test(body[j])) j++;
      const ident = body.slice(i, j);
      // skip whitespace after the identifier to classify it.
      let k = j;
      while (k < body.length && (body[k] === " " || body[k] === "\t")) k++;
      const next = body[k];
      if (next === "=" && body[k + 1] !== "=") {
        // attribute assignment: `name = …`
        if (!RESOURCE_META_ARGUMENTS.has(ident)) names.add(ident);
      } else if (next === "{") {
        // nested block: `name { … }`
        if (!RESOURCE_META_ARGUMENTS.has(ident)) names.add(ident);
      } else if (next === '"') {
        // labeled block: `dynamic "x" {` → the generated block is `x`;
        // other labeled blocks (`provisioner "remote-exec"`) are meta.
        if (ident === "dynamic") {
          const labelEnd = body.indexOf('"', k + 1);
          if (labelEnd !== -1) names.add(body.slice(k + 1, labelEnd));
        }
      }
      i = j - 1;
      atStmtStart = false;
      continue;
    }
    atStmtStart = false;
  }
  return [...names];
}

export interface UnknownArgument {
  resource_type: string;
  /** the resource's local name. */
  name: string;
  /** repo-relative file the resource is declared in. */
  file: string;
  /** the argument names not present in the installed provider's schema. */
  unknown: string[];
}

/**
 * §4.15-next — cross-check every resource's written arguments against the
 * INSTALLED provider's schema, so an argument that's invalid for the pinned
 * provider major (a "correct" fix for the wrong version) is caught at validate
 * time, not as a later `plan` failure. Degrades green: returns
 * `{ checked: false }` when the schema is unavailable (terraform not installed /
 * dir not init-ed). A resource type absent from the schema is skipped (can't
 * judge), never flagged.
 */
export function checkArgumentsAgainstSchema(cwd: string): {
  checked: boolean;
  unknown_arguments: UnknownArgument[];
} {
  const schema = loadProvidersSchema(cwd);
  if (!schema) return { checked: false, unknown_arguments: [] };
  const out: UnknownArgument[] = [];
  for (const f of walkTfFiles(cwd)) {
    let text: string;
    try {
      text = readFileSync(join(cwd, f), "utf8");
    } catch {
      continue;
    }
    for (const block of parseResourceArguments(text)) {
      const verdict = unknownArgsForResource(schema, block.resourceType, block.args);
      if (!verdict.unknownResourceType && verdict.unknown.length > 0) {
        out.push({
          resource_type: block.resourceType,
          name: block.name,
          file: f,
          unknown: verdict.unknown,
        });
      }
    }
  }
  return { checked: true, unknown_arguments: out };
}

// --- tflint ---------------------------------------------------------------

function tflintSeverity(s: string | undefined): Severity {
  switch ((s ?? "").toLowerCase()) {
    case "error":
      return "high";
    case "warning":
      return "medium";
    default:
      return "low";
  }
}

// dirs we've already attempted `tflint --init` in, so repeated scans don't re-init.
const tflintInitedDirs = new Set<string>();

/**
 * Install tflint's provider ruleset plugins via `tflint --init` when the dir has
 * a `.tflint.hcl` declaring them. Core `tflint --recursive` runs only the
 * built-in rules; the high-value provider rules (deprecated args, invalid
 * instance types, missing-tag policies, etc.) live in the aws/azurerm/google
 * plugins, which must be installed first. Opt-in by design — we only init when
 * the repo ships a `.tflint.hcl`, so we don't force AWS rules onto an Azure/GCP
 * repo. Best-effort and network-dependent: a failed init just leaves tflint
 * running its core rules, exactly as before.
 */
function ensureTflintInit(cwd: string): void {
  if (tflintInitedDirs.has(cwd)) return;
  // mark first: a failed init won't succeed on retry within the same run, and
  // we don't want to re-attempt the network fetch on every scanner call.
  tflintInitedDirs.add(cwd);
  if (!existsSync(join(cwd, ".tflint.hcl"))) return;
  const r = run("tflint", ["--init"], cwd);
  if (r.status !== 0 && !r.missing) {
    log.info("» tflint --init did not complete cleanly — provider ruleset plugins may be unavailable");
  }
}

function scanTflint(cwd: string): ScannerOutcome {
  ensureTflintInit(cwd);
  const r = run("tflint", ["--format", "json", "--recursive"], cwd);
  if (r.missing) return skipped("tflint", "tflint not installed");
  try {
    return { source: "tflint", ran: true, concerns: parseTflintOutput(r.stdout, cwd) };
  } catch {
    return skipped("tflint", "could not parse tflint json output");
  }
}

/** parse `tflint --format json` output into concerns. */
export function parseTflintOutput(stdout: string, cwd = ""): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as { issues?: TflintIssue[] };
  return (parsed.issues ?? []).map<Concern>((issue) => {
    const rule = issue.rule?.name ?? "issue";
    const file = toRepoRelative(issue.range?.filename, cwd);
    const line = issue.range?.start?.line ?? null;
    return {
      id: concernId("tflint", rule, file, line),
      source: "tflint",
      rule_id: `tflint:${rule}`,
      severity: tflintSeverity(issue.rule?.severity),
      category: "style",
      evidence: issue.message ?? rule,
      location: { file, line },
      remediation_hint: issue.rule?.link ?? null,
    };
  });
}

interface TflintIssue {
  rule?: { name?: string; severity?: string; link?: string };
  message?: string;
  range?: { filename?: string; start?: { line?: number } };
}

// --- trivy ----------------------------------------------------------------

function lowerSeverity(s: string | undefined): Severity {
  const v = (s ?? "").toLowerCase();
  return (SEVERITIES as readonly string[]).includes(v) ? (v as Severity) : "medium";
}

// tfsec was archived by Aqua and folded into Trivy; `trivy config` is its
// maintained successor with a larger ruleset (the AVD-* checks). `--quiet`
// keeps Trivy's progress chatter off stdout so the JSON parses cleanly.
function scanTrivy(cwd: string): ScannerOutcome {
  const r = run("trivy", ["config", "--format", "json", "--quiet", "."], cwd);
  if (r.missing) return skipped("trivy", "trivy not installed");
  try {
    return { source: "trivy", ran: true, concerns: parseTrivyOutput(r.stdout, cwd) };
  } catch {
    return skipped("trivy", "could not parse trivy json output");
  }
}

/**
 * Parse `trivy config --format json` output into concerns. Trivy nests
 * misconfigurations under `Results[].Misconfigurations[]`, keyed to the result's
 * `Target` file. `trivy config` reports only failures by default, but we
 * defensively drop any `Status: "PASS"` entry so an `--include-non-failures`
 * run can't leak passing checks into the concern set.
 */
export function parseTrivyOutput(stdout: string, cwd = ""): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as { Results?: TrivyResult[] | null };
  const concerns: Concern[] = [];
  for (const result of parsed.Results ?? []) {
    const file = toRepoRelative(result.Target, cwd);
    for (const m of result.Misconfigurations ?? []) {
      if (m.Status === "PASS") continue;
      const rule = m.AVDID || m.ID || "issue";
      const start = m.CauseMetadata?.StartLine;
      const line = typeof start === "number" && start > 0 ? start : null;
      concerns.push({
        id: concernId("trivy", rule, file, line),
        source: "trivy",
        rule_id: `trivy:${rule}`,
        severity: lowerSeverity(m.Severity),
        category: "security",
        evidence: m.Message || m.Description || m.Title || rule,
        location: { file, line },
        remediation_hint: m.Resolution || m.References?.[0] || null,
      });
    }
  }
  return concerns;
}

interface TrivyMisconfiguration {
  ID?: string;
  AVDID?: string;
  Title?: string;
  Description?: string;
  Message?: string;
  Resolution?: string;
  Severity?: string;
  References?: string[];
  Status?: string;
  CauseMetadata?: { StartLine?: number; EndLine?: number };
}

interface TrivyResult {
  Target?: string;
  Class?: string;
  Type?: string;
  Misconfigurations?: TrivyMisconfiguration[];
}

// --- checkov --------------------------------------------------------------

function scanCheckov(cwd: string): ScannerOutcome {
  // `--framework terraform` keeps checkov to Terraform only. By default checkov
  // also scans github_actions / dockerfile / secrets / kubernetes / etc., which
  // surfaces concerns in files Terramend can never remediate (the path guardrail
  // blocks anything outside *.tf/*.tfvars) — pure noise. Terramend is
  // Terraform-only, so we scope the scanner to match.
  const r = run("checkov", ["-d", ".", "--framework", "terraform", "-o", "json", "--compact", "--quiet"], cwd);
  if (r.missing) return skipped("checkov", "checkov not installed");
  try {
    return { source: "checkov", ran: true, concerns: parseCheckovOutput(r.stdout, cwd) };
  } catch {
    return skipped("checkov", "could not parse checkov json output");
  }
}

/** parse `checkov -o json` output (object for one framework, array for several). */
export function parseCheckovOutput(stdout: string, cwd = ""): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as CheckovOutput | CheckovOutput[];
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  const concerns: Concern[] = [];
  for (const block of blocks) {
    for (const check of block.results?.failed_checks ?? []) {
      const file = toRepoRelative(check.file_path, cwd);
      // checkov emits 0 for "no specific line"; normalize to null (matching the
      // trivy parser and the reviewer's findings.json) so the content id is
      // stable and a reviewer-loaded checkov concern re-verifies ✗→✓.
      const startLine = check.file_line_range?.[0];
      const line = typeof startLine === "number" && startLine > 0 ? startLine : null;
      const rule = check.check_id ?? "issue";
      concerns.push({
        id: concernId("checkov", rule, file, line),
        source: "checkov",
        rule_id: `checkov:${rule}`,
        severity: lowerSeverity(check.severity ?? undefined),
        category: "security",
        evidence: check.check_name ?? rule,
        location: { file, line },
        remediation_hint: check.guideline ?? null,
      });
    }
  }
  return concerns;
}

interface CheckovOutput {
  results?: {
    failed_checks?: {
      check_id?: string;
      check_name?: string;
      severity?: string | null;
      file_path?: string;
      file_line_range?: number[];
      guideline?: string;
    }[];
  };
}

// --- the tools ------------------------------------------------------------

/** true when a path is a Terraform source file Terramend may remediate. */
function isTerraformFile(file: string): boolean {
  const f = file.toLowerCase();
  return f.endsWith(".tf") || f.endsWith(".tfvars");
}

/**
 * Terramend is Terraform-only. A concern in a non-`.tf`/`.tfvars` file can never
 * be remediated (the `allowed_paths` push guardrail blocks it) and is pure noise,
 * so any scanner that also inspects other IaC — checkov's github_actions, trivy's
 * dockerfile/kubernetes — gets filtered down to Terraform here. This is the
 * catch-all backstop; `scanCheckov` also scopes itself with `--framework terraform`.
 */
export function isTerraformConcern(c: Concern): boolean {
  return isTerraformFile(c.location.file);
}

function dedupe(concerns: Concern[]): Concern[] {
  const seen = new Set<string>();
  const out: Concern[] = [];
  for (const c of concerns) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function sortConcerns(concerns: Concern[]): Concern[] {
  return [...concerns].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    return a.id.localeCompare(b.id);
  });
}

/**
 * A scoped unit of work = all concerns in one file. Different scanners flag the
 * same underlying defect under different rule ids (trivy ∩ checkov overlap
 * heavily on e.g. S3 buckets), so per-concern PRs would spam many PRs for one
 * bad file. Remediate acts on ONE group per PR (branch `remediate/<group.id>`),
 * fixing every concern in the file together and proving them all cleared (✗→✓).
 */
export interface ConcernGroup {
  /** stable id — the remediation branch/PR key (`remediate/<id>`). Derived from
   * the file (by-file grouping) or the rule (by-rule grouping). */
  id: string;
  /** the group's primary file (by-file) or a human label like "3 files"
   * (by-rule); `files` carries the full list for by-rule groups. */
  file: string;
  /** §3.11 — every file the group spans. one entry for a by-file group; the
   * full set for a by-rule group (the agent must fix the rule in all of them). */
  files?: string[];
  /** how the group was formed — `file` (default) or `rule` (§3.11). */
  grouping?: "file" | "rule";
  /** highest severity among the group's concerns. */
  severity: Severity;
  concern_count: number;
  /** distinct rule ids in the group, for the PR body. */
  rule_ids: string[];
  /** the concern ids the re-scan must confirm are gone to call this ✓. */
  concern_ids: string[];
  /** §3.9 — `auto` (open a normal PR) or `needs-human` (escalate). attached by
   * the scan tool from the group's concerns, not by `groupConcerns` (which has
   * no autonomy threshold). undefined until the scan tool annotates it. */
  autonomy?: Autonomy;
  /** §3.9 — why the group was escalated (empty/absent for `auto`). */
  autonomy_reasons?: string[];
}

function groupId(file: string): string {
  return createHash("sha1").update(`group|${file}`).digest("hex").slice(0, 12);
}

function ruleGroupId(ruleId: string): string {
  return createHash("sha1").update(`rulegroup|${ruleId}`).digest("hex").slice(0, 12);
}

function maxSeverity(cs: Concern[]): Severity {
  return cs.reduce<Severity>(
    (max, c) => (SEVERITY_RANK[c.severity] > SEVERITY_RANK[max] ? c.severity : max),
    "info"
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
  threshold: Severity
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
  const batchable = groups.filter(isBatchable).map((g) => g.id).sort();
  const isolated = groups.filter((g) => !isBatchable(g)).map((g) => g.id).sort();
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
function docUrlsForGroup(g: ConcernGroup, all: Concern[]): Record<string, string> {
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

/** the repo's base ref for diff-scope, or null when one can't be determined. */
function resolveBaseRef(cwd: string): string | null {
  const head = run("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd);
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ["origin/main", "origin/master"]) {
    const verify = run("git", ["rev-parse", "--verify", "--quiet", ref], cwd);
    if (verify.status === 0 && verify.stdout.trim()) return ref;
  }
  return null;
}

/**
 * Terraform files changed on the current branch vs the base. Returns null when
 * the base can't be determined (caller then falls back to a full scan).
 */
function changedTerraformFiles(cwd: string): Set<string> | null {
  const base = resolveBaseRef(cwd);
  if (!base) return null;
  const mergeBase = run("git", ["merge-base", base, "HEAD"], cwd);
  const from = mergeBase.status === 0 && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : base;
  const diff = run("git", ["diff", "--name-only", from, "HEAD"], cwd);
  if (diff.status !== 0) return null;
  // `git diff` reports paths relative to the repo ROOT, but a concern's
  // `location.file` is relative to the scan `cwd` (toRepoRelative). When `cwd`
  // is a repo SUBDIRECTORY (the `cwd` action input resolved under
  // GITHUB_WORKSPACE) the two path spaces disagree — e.g. git says
  // `infra/main.tf` while the concern says `main.tf` — and the in-scope check
  // would silently drop every concern. Re-base the diff paths onto `cwd` by
  // stripping the cwd→root prefix and discarding anything outside it, so both
  // sides are cwd-relative.
  const prefixResult = run("git", ["rev-parse", "--show-prefix"], cwd);
  const prefix = prefixResult.status === 0 ? prefixResult.stdout.trim().replace(/\\/g, "/") : "";
  const files: string[] = [];
  for (const raw of diff.stdout.split("\n")) {
    let f = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!f) continue;
    if (prefix) {
      if (!f.startsWith(prefix)) continue; // changed file lives outside the scanned subdir
      f = f.slice(prefix.length);
    }
    if (f.endsWith(".tf") || f.endsWith(".tfvars")) files.push(f);
  }
  return new Set(files);
}

/** run every scanner once over `cwd`. shared by `terraform_scan` and the
 * deterministic remediation verifier so both see the identical toolchain. */
function runScanners(cwd: string): ScannerOutcome[] {
  return [scanFmt(cwd), scanValidate(cwd), scanTflint(cwd), scanTrivy(cwd), scanCheckov(cwd)];
}

export interface RemediationVerdict {
  /** true only when every original concern id is absent from the re-scan. */
  verified: boolean;
  /** original ids no longer present (the fix cleared them). */
  resolved: string[];
  /** original ids still present (the fix did NOT clear them). */
  remaining: string[];
}

/**
 * Deterministic ✗→✓ check: partition the group's original `concern_ids` into
 * those gone from a fresh scan (`resolved`) and those still present
 * (`remaining`). Concern ids are content hashes (`sha1(source|rule|file|line)`),
 * so a missing id means that exact concern is gone — the correct primitive for
 * "did the fix clear it", independent of severity/scope filtering. This is the
 * code-level replacement for the agent eyeballing a re-scan and self-reporting.
 */
export function computeRemediationVerdict(
  originalConcernIds: string[],
  currentConcernIds: Set<string>
): RemediationVerdict {
  const resolved: string[] = [];
  const remaining: string[] = [];
  for (const id of originalConcernIds) {
    if (currentConcernIds.has(id)) remaining.push(id);
    else resolved.push(id);
  }
  return { verified: remaining.length === 0, resolved, remaining };
}

/**
 * §1.4 Regression guard. The full re-scan (`terraform_verify_remediation`)
 * already sees the whole workspace, so a concern the fix *introduced* shows up
 * in the current scan. Regressions are exactly the content ids present after the
 * fix that were not in the pre-fix baseline — `current − baseline`. A non-empty
 * result means the fix traded one defect for another (e.g. an encryption block
 * that trips a different tflint rule) and must downgrade the PR to needs-human.
 *
 * Both id sets are computed the same way (the deduped union of every scanner's
 * concern ids, unfiltered by severity) so the diff is apples-to-apples — a
 * regression at ANY severity is caught, not just ones above the run threshold.
 * Returns sorted ids for a stable PR body.
 */
export function computeRegressions(
  baselineConcernIds: Iterable<string>,
  currentConcernIds: Iterable<string>
): string[] {
  const baseline = new Set(baselineConcernIds);
  const regressions = new Set<string>();
  for (const id of currentConcernIds) {
    if (!baseline.has(id)) regressions.add(id);
  }
  return [...regressions].sort();
}

// --- infracost (cost lens) ------------------------------------------------

export interface CostBreakdown {
  /** total estimated monthly cost, or null when no resources are priced. */
  totalMonthlyCost: number | null;
  currency: string;
}

/**
 * Parse `infracost breakdown --format json`. The top-level `totalMonthlyCost`
 * is a decimal string (absent / null when a project has no priced resources);
 * `currency` defaults to USD. A missing/unparseable cost becomes null so the
 * caller reports "unpriced" rather than a misleading $0.00.
 */
export function parseInfracostBreakdown(stdout: string): CostBreakdown {
  const parsed = JSON.parse(stdout || "{}") as {
    totalMonthlyCost?: string | number | null;
    currency?: string;
  };
  const raw = parsed.totalMonthlyCost;
  const num = typeof raw === "number" ? raw : raw != null ? Number.parseFloat(raw) : Number.NaN;
  return {
    totalMonthlyCost: Number.isFinite(num) ? num : null,
    currency: parsed.currency || "USD",
  };
}

export interface ResourceCost {
  name: string;
  monthlyCost: number;
}

/**
 * Parse the per-resource monthly costs from `infracost breakdown --format json`
 * (`projects[].breakdown.resources[]`), so a cost increase can be attributed to
 * the specific resources that drove it instead of just a total. Skips unpriced
 * (null/zero) resources; returns them sorted most-expensive first. Pure.
 */
export function parseInfracostResources(stdout: string): ResourceCost[] {
  let parsed: {
    projects?: { breakdown?: { resources?: { name?: string; monthlyCost?: string | number | null }[] } }[];
  };
  try {
    parsed = JSON.parse(stdout || "{}");
  } catch {
    return [];
  }
  const out: ResourceCost[] = [];
  for (const project of parsed.projects ?? []) {
    for (const r of project.breakdown?.resources ?? []) {
      const raw = r.monthlyCost;
      const cost = typeof raw === "number" ? raw : raw != null ? Number.parseFloat(raw) : Number.NaN;
      if (Number.isFinite(cost) && cost > 0 && r.name) {
        out.push({ name: r.name, monthlyCost: Math.round(cost * 100) / 100 });
      }
    }
  }
  return out.sort((a, b) => b.monthlyCost - a.monthlyCost);
}

export interface CostDelta {
  currency: string;
  baselineMonthly: number | null;
  currentMonthly: number | null;
  /** current − baseline, rounded to cents; null when either side is unknown. */
  deltaMonthly: number | null;
  direction: "increase" | "decrease" | "no-change" | "unknown";
}

/** Pure cost-delta computation: current (post-fix) vs the base-branch baseline. */
export function computeCostDelta(baseline: CostBreakdown | null, current: CostBreakdown): CostDelta {
  const currency = current.currency || baseline?.currency || "USD";
  const baselineMonthly = baseline?.totalMonthlyCost ?? null;
  const currentMonthly = current.totalMonthlyCost;
  if (baselineMonthly === null || currentMonthly === null) {
    return { currency, baselineMonthly, currentMonthly, deltaMonthly: null, direction: "unknown" };
  }
  const deltaMonthly = Math.round((currentMonthly - baselineMonthly) * 100) / 100;
  const direction = deltaMonthly > 0 ? "increase" : deltaMonthly < 0 ? "decrease" : "no-change";
  return { currency, baselineMonthly, currentMonthly, deltaMonthly, direction };
}

export interface CostEscalation {
  /** true when the monthly increase meets/exceeds the operator's threshold. */
  escalate: boolean;
  reason?: string;
}

/**
 * §4.16-next — decide whether a cost increase is large enough to escalate the PR
 * to human review (`needs-human`). Compares the monthly delta against the
 * operator's `cost_increase_block_usd` threshold. No threshold set, an unknown
 * delta, or a decrease/no-change ⇒ no escalation. Pure + deterministic so the
 * decision is auditable, not a model judgement.
 */
export function classifyCostEscalation(
  deltaMonthly: number | null,
  thresholdUsd: number | undefined
): CostEscalation {
  if (thresholdUsd === undefined || deltaMonthly === null || deltaMonthly <= 0) {
    return { escalate: false };
  }
  if (deltaMonthly >= thresholdUsd) {
    return {
      escalate: true,
      reason: `the fix raises monthly cost by ${deltaMonthly}, at or above the ${thresholdUsd} escalation threshold`,
    };
  }
  return { escalate: false };
}

function runInfracostBreakdown(scanCwd: string, key: string): RunResult {
  return run("infracost", ["breakdown", "--path", ".", "--format", "json", "--no-color"], scanCwd, {
    INFRACOST_API_KEY: key,
  });
}

/**
 * Cost of the base-branch version of the same Terraform, computed in a detached
 * git worktree so the current (fixed) checkout is never disturbed. Best-effort:
 * any failure (no base ref, worktree add fails, infracost errors) returns null
 * and the caller falls back to reporting current cost only.
 */
function infracostBaseline(cwd: string, key: string, tmpdir: string): CostBreakdown | null {
  const baseRef = resolveBaseRef(cwd);
  if (!baseRef) return null;
  const prefixResult = run("git", ["rev-parse", "--show-prefix"], cwd);
  const prefix = prefixResult.status === 0 ? prefixResult.stdout.trim() : "";
  const worktree = join(tmpdir, `infracost-base-${process.pid}`);
  // clear any stale worktree from an earlier call in this process before re-adding.
  run("git", ["worktree", "remove", "--force", worktree], cwd);
  const add = run("git", ["worktree", "add", "--detach", worktree, baseRef], cwd);
  if (add.status !== 0) return null;
  try {
    const scanCwd = prefix ? join(worktree, prefix) : worktree;
    const r = runInfracostBreakdown(scanCwd, key);
    if (r.missing || r.status !== 0) return null;
    return parseInfracostBreakdown(r.stdout);
  } catch {
    return null;
  } finally {
    run("git", ["worktree", "remove", "--force", worktree], cwd);
  }
}

export const TerraformScanParams = type({
  "scan_scope?": type("'full' | 'diff'").describe(
    "'full' (default) scans the whole workspace; 'diff' limits concerns to Terraform files changed vs the base branch."
  ),
  "severity_threshold?": type("'critical' | 'high' | 'medium' | 'low' | 'info'").describe(
    "minimum severity to report (default: low). 'info' includes everything."
  ),
  "group_by?": type("'file' | 'rule'").describe(
    "'file' (default) makes one group per file (smaller blast radius per PR). 'rule' groups a single rule's concerns across ALL files into one group — use for sweeping, low-risk rules (e.g. 'add tags everywhere') so they become one PR instead of many."
  ),
});

export function TerraformScanTool(ctx: ToolContext) {
  return tool({
    name: "terraform_scan",
    description:
      "Scan the Terraform in the workspace against best practices using the deterministic check tools " +
      "(terraform fmt, terraform validate, tflint, trivy, checkov). Returns a stable, severity-ranked " +
      "list of `concerns` — each is one best-practice issue with a content-derived `id`, the producing " +
      "`source`, `rule_id`, `severity`, the `location` (file + line), and a `remediation_hint`. Concerns " +
      "are also rolled up into `groups` (one per file): different scanners flag the same defect under " +
      "different rule ids, so remediate ONE group per PR (its `id` is the branch/PR key; its `concern_ids` " +
      "are what the ✗→✓ re-scan must confirm cleared) rather than one PR per concern. Scanners that aren't " +
      "installed are reported as skipped (they never fail the scan). Also returns `co_located` (concerns " +
      "different scanners flagged at the same file:line — fix as ONE canonical change, §30), " +
      "`refusal_candidates` (concerns whose fix needs a human decision — prefer a structured refusal over " +
      "guessing, §29), and `prevention` (a CI guardrail per rule that stops it recurring, §21).",
    parameters: TerraformScanParams,
    execute: execute(async ({ scan_scope, severity_threshold, group_by }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      // precedence: explicit tool arg > the run's configured severity_threshold > "low"
      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";
      const minRank = SEVERITY_RANK[threshold];
      const scope = scan_scope ?? ctx.payload.scanScope ?? "full";

      const outcomes = runScanners(cwd);

      // diff scope: keep only concerns in Terraform files changed vs the base.
      let scopeNote: string | undefined;
      let changed: Set<string> | null = null;
      if (scope === "diff") {
        changed = changedTerraformFiles(cwd);
        if (changed === null) {
          scopeNote = "diff scope requested but the base branch could not be determined — scanned full instead";
        }
      }
      const inScope = (c: Concern): boolean =>
        changed === null
          ? true
          : changed.has(c.location.file.replace(/\\/g, "/").replace(/^\.\//, ""));

      // §1.4 baseline: the full, severity-unfiltered concern-id set, captured
      // BEFORE any fix and computed identically to verify's `current` set so the
      // later regression diff (current − baseline) is apples-to-apples.
      ctx.toolState.baselineConcernIds = dedupe(outcomes.flatMap((o) => o.concerns)).map((c) => c.id);

      const all = sortConcerns(dedupe(outcomes.flatMap((o) => o.concerns)))
        .filter(isTerraformConcern)
        .filter(inScope)
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank);

      // §3.11 grouping mode: by-file (default, smaller per-PR blast radius) or
      // by-rule (one PR per rule across all files — for sweeping low-risk rules).
      const grouping = group_by ?? "file";
      const autonomyThreshold = (ctx.payload.autonomyThreshold as Severity | undefined) ?? "high";
      const groups = annotateGroups(
        grouping === "rule" ? groupConcernsByRule(all) : groupConcerns(all),
        all,
        autonomyThreshold
      );

      // §3.10 batching plan: which auto/low-risk groups can ride one PR vs which
      // must be isolated. Advisory — the agent acts on it under max_prs.
      const batchPlan = planBatches(groups);

      // §30 — concerns different scanners flagged at the same file:line (one
      // canonical fix). §29 — concerns whose fix needs a human decision (prefer
      // a structured refusal). §21 — the preventive control per distinct rule.
      const coLocated = clusterByLocation(all);
      const refusalCandidates = all
        .map((c) => ({ id: c.id, ...classifyRefusal(c) }))
        .filter((r) => r.refuse)
        .map((r) => ({ concern_id: r.id, reason: r.reason }));
      const prevention: Record<string, PreventiveControl> = {};
      for (const c of all) {
        if (prevention[c.rule_id]) continue;
        const control = preventiveControlFor(c);
        if (control) prevention[c.rule_id] = control;
      }

      const by_severity: Record<string, number> = {};
      for (const c of all) by_severity[c.severity] = (by_severity[c.severity] ?? 0) + 1;

      const ran = outcomes.filter((o) => o.ran).map((o) => o.source);
      const skippedScanners = outcomes
        .filter((o) => !o.ran)
        .map((o) => ({ source: o.source, reason: o.skipped_reason }));

      log.info(
        `» terraform_scan: ${all.length} concern(s) ≥ ${threshold} from [${ran.join(", ")}] ` +
          `(${groups.length} ${grouping}-group(s))` +
          (skippedScanners.length ? ` (skipped: ${skippedScanners.map((s) => s.source).join(", ")})` : "")
      );

      return toolOk({
        scanned_dir: cwd,
        scope: changed === null ? "full" : "diff",
        ...(scopeNote ? { scope_note: scopeNote } : {}),
        grouping,
        scanners_ran: ran,
        scanners_skipped: skippedScanners,
        summary: { total: all.length, groups: groups.length, by_severity },
        groups: groups.map((g) => ({ ...g, doc_urls: docUrlsForGroup(g, all) })),
        batch_plan: batchPlan,
        // §30 cross-tool co-location, §29 refusal candidates, §21 prevention.
        co_located: coLocated,
        refusal_candidates: refusalCandidates,
        prevention,
        concerns: all.map((c) => ({ ...c, doc_url: ruleDocUrl(c) })),
      });
    }),
  });
}

export const TerraformValidateParams = type({
  "paths?": type.string.array().describe(
    "optional list of file globs/paths to limit fmt+lint to; omit to check the whole workspace"
  ),
});

export function TerraformValidateTool(ctx: ToolContext) {
  return tool({
    name: "terraform_validate",
    description:
      "Fast pre-PR gate. Runs `terraform fmt -check`, `terraform validate` (per Terraform root — " +
      "multi-root aware, see `roots_validated`), and `tflint` over the " +
      "workspace and returns whether the Terraform is well-formed and idiomatic. Also reports `providers` " +
      "— the pinned provider requirements (name + source + version constraint + resolved `major`, §4.15): " +
      "honour the pinned major when writing a fix, because argument names and valid blocks differ across " +
      "provider majors, and a 'correct' fix for the wrong major just breaks `plan`. Call this AFTER " +
      "applying a fix and BEFORE opening a PR — never open a PR whose `terraform_validate` did not pass.",
    parameters: TerraformValidateParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      // `terraform validate` runs per-root (multi-root aware); fmt + tflint are
      // recursive over the whole tree.
      const checks = [scanFmt(cwd), scanValidate(cwd), scanTflint(cwd)];
      const remaining = sortConcerns(dedupe(checks.flatMap((c) => c.concerns)));
      const ran = checks.filter((c) => c.ran).map((c) => c.source);
      // §4.15 — surface the pinned provider majors so the fix targets the right
      // argument schema (deterministic, read straight from required_providers).
      const providers = collectProviderRequirements(cwd);
      const roots = resolveRoots(cwd).map((r) => r.relDir || ".");
      // §4.15-next — cross-check the arguments actually written in the workspace
      // against the INSTALLED provider's schema, so an argument that's invalid
      // for the pinned provider major (a "correct" fix for the wrong version) is
      // caught here, before the PR, instead of surfacing as a `plan` failure.
      // Deterministic and degrades green (omitted) when the schema isn't
      // available (terraform not installed / dir not init-ed).
      const schemaCheck = checkArgumentsAgainstSchema(cwd);
      return toolOk({
        // `passed` stays gated on fmt + validate + tflint only — those are
        // authoritative. The schema cross-check is a high-signal ADVISORY (a
        // conservative HCL parse), surfaced separately so a parser edge case can
        // never wrongly block a valid fix.
        passed: remaining.length === 0,
        checks_ran: ran,
        remaining_issues: remaining,
        providers,
        // §4.15-next — arguments written in the workspace that are NOT in the
        // installed provider's schema (would break `plan` on the pinned major).
        // `schema_checked` is false when the schema was unavailable (terraform
        // not installed / dir not init-ed) — then `unknown_arguments` is empty
        // and you should rely on `terraform_plan` to catch a bad argument.
        schema_checked: schemaCheck.checked,
        unknown_arguments: schemaCheck.unknown_arguments,
        // the Terraform roots `validate` covered (each was init+validate'd).
        roots_validated: roots,
      });
    }),
  });
}

export const TerraformVerifyRemediationParams = type({
  concern_ids: type.string.array().describe(
    "the `concern_ids` of the group being remediated (from the original terraform_scan). the tool re-runs the scanners and reports which are now resolved vs still present."
  ),
});

export function TerraformVerifyRemediationTool(ctx: ToolContext) {
  return tool({
    name: "terraform_verify_remediation",
    description:
      "Deterministic ✗→✓ proof for a remediation. Re-runs the scanners and partitions the given " +
      "`concern_ids` into `resolved` (gone from the re-scan) and `remaining` (still present), with a " +
      "`verified` flag that is true ONLY when every id is gone. Also reports `regressions` — NEW concern " +
      "ids the fix introduced that were not in the pre-fix scan (§1.4): when `has_regressions` is true the " +
      "PR must be labelled `needs-human` and the new concerns listed. Finally returns a deterministic " +
      "`confidence` (high/medium/low, §5.19) computed from the verification evidence (verified + no " +
      "regressions + plan idempotency + blast radius + cost direction) — render it as a PR label/badge. " +
      "Call this AFTER pushing the fix branch and build the PR's Validation section from its result — do " +
      "NOT eyeball a scan or self-report resolution. A concern may be listed as ✓ resolved only if it " +
      "appears in `resolved`.",
    parameters: TerraformVerifyRemediationParams,
    execute: execute(async ({ concern_ids }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const outcomes = runScanners(cwd);
      const currentIds = dedupe(outcomes.flatMap((o) => o.concerns)).map((c) => c.id);
      const current = new Set(currentIds);
      const verdict = computeRemediationVerdict(concern_ids, current);

      // §1.4 — concern ids the fix INTRODUCED (present now, absent from the
      // pre-fix baseline). Only computable when terraform_scan captured a
      // baseline this run; absent that, regressions are reported as unknown
      // rather than falsely empty.
      const baseline = ctx.toolState.baselineConcernIds;
      const regressions = baseline ? computeRegressions(baseline, currentIds) : [];
      const regressionsKnown = baseline !== undefined;

      // §5.19 — deterministic confidence from the evidence on hand.
      const confidence = computeConfidence({
        verified: verdict.verified,
        regressionCount: regressions.length,
        idempotent: ctx.toolState.lastIdempotent,
        blastTier: ctx.toolState.lastBlastTier,
        costDirection: ctx.toolState.lastCostDirection,
      });

      const ran = outcomes.filter((o) => o.ran).map((o) => o.source);
      log.info(
        `» terraform_verify_remediation: ${verdict.resolved.length}/${concern_ids.length} resolved` +
          ` (${verdict.remaining.length} still present` +
          (regressionsKnown ? `, ${regressions.length} regression(s)` : "") +
          `) — confidence: ${confidence.level} — from [${ran.join(", ")}]`
      );
      return toolOk({
        verified: verdict.verified,
        resolved_count: verdict.resolved.length,
        remaining_count: verdict.remaining.length,
        resolved: verdict.resolved,
        remaining: verdict.remaining,
        // §1.4 regression guard
        has_regressions: regressions.length > 0,
        regressions,
        ...(regressionsKnown
          ? {}
          : { regressions_note: "no pre-fix baseline captured (run terraform_scan first) — regressions not checked" }),
        // §5.19 confidence label
        confidence: confidence.level,
        confidence_reasons: confidence.reasons,
        scanners_ran: ran,
      });
    }),
  });
}

export const InfracostDiffParams = type({});

export function InfracostDiffTool(ctx: ToolContext) {
  return tool({
    name: "infracost_diff",
    description:
      "Estimate the monthly cost impact of the remediation. Runs Infracost on the current (fixed) " +
      "Terraform and, when the base branch is resolvable, on the base version too — returning the " +
      "monthly cost delta so a security fix that meaningfully raises spend can be flagged rather than " +
      "merged blindly. Auto-skips (never fails) when INFRACOST_API_KEY is unset or the infracost CLI " +
      "is absent — cost analysis is opt-in. Call it after the fix is committed and, when it returns " +
      "`ran: true`, fold a one-line cost note into the PR body.",
    parameters: InfracostDiffParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const key = process.env.INFRACOST_API_KEY || undefined;
      if (!key) {
        return skipResult("infracost_key_unset", "INFRACOST_API_KEY not set — cost analysis is opt-in");
      }
      const cur = runInfracostBreakdown(cwd, key);
      if (cur.missing) return skipResult("infracost_not_installed", "infracost not installed");
      if (cur.status !== 0) {
        return skipResult(
          "infracost_failed",
          `infracost breakdown failed: ${cur.stderr.trim().slice(0, 300) || "unknown error"}`
        );
      }
      let current: CostBreakdown;
      try {
        current = parseInfracostBreakdown(cur.stdout);
      } catch {
        return skipResult("infracost_parse_error", "could not parse infracost json output");
      }
      const baseline = infracostBaseline(cwd, key, ctx.tmpdir);
      const delta = computeCostDelta(baseline, current);
      // per-resource breakdown (top drivers) for a collapsed <details> in the PR.
      const topResources = parseInfracostResources(cur.stdout).slice(0, 10);
      // §5.19 — record the cost direction for the confidence label.
      ctx.toolState.lastCostDirection = delta.direction;
      // §4.16-next — escalate to human review when the increase crosses the
      // operator's threshold.
      const escalation = classifyCostEscalation(delta.deltaMonthly, ctx.payload.costIncreaseBlockUsd);
      log.info(
        `» infracost_diff: current ${delta.currentMonthly ?? "?"} ${delta.currency}/mo` +
          (delta.deltaMonthly !== null
            ? `, delta ${delta.deltaMonthly >= 0 ? "+" : ""}${delta.deltaMonthly}`
            : " (no baseline)") +
          (escalation.escalate ? " ⚠ COST ESCALATION (needs-human)" : "")
      );
      return toolOk({
        ran: true,
        currency: delta.currency,
        current_monthly_cost: delta.currentMonthly,
        baseline_monthly_cost: delta.baselineMonthly,
        monthly_delta: delta.deltaMonthly,
        direction: delta.direction,
        // §4.16-next — when true, label the PR needs-human (large spend increase).
        needs_human: escalation.escalate,
        ...(escalation.reason ? { cost_escalation_reason: escalation.reason } : {}),
        // per-resource cost drivers (top 10) for a collapsed <details> block.
        ...(topResources.length ? { top_resource_costs: topResources } : {}),
        ...(delta.deltaMonthly === null
          ? {
              note: "Baseline cost unavailable (no base ref or unpriced) — reporting current monthly cost only.",
            }
          : {}),
      });
    }),
  });
}

// --- reviewer findings (read_findings) ------------------------------------

/**
 * The subset of a terraform-reviewer (Assessor) `findings.json` finding that
 * Terramend consumes. The reviewer's contract is a deliberate SUPERSET of the
 * Concern model (same content-id formula, same severity enum) — see
 * ../terraform-reviewer/schemas/findings.schema.json. Extra fields
 * (lens/standard/control_id/confidence/state) are ignored except `state`.
 */
interface ReviewerFinding {
  category?: string;
  source?: string;
  rule_id?: string;
  /** verified (deterministic) | evidence (confirm manually) | human_only (out of scope). */
  state?: string;
  severity?: string;
  evidence?: string;
  location?: { file?: string; line?: number | null };
  remediation_hint?: string | null;
}

interface ReviewerFindingsReport {
  schema_version?: string;
  findings?: ReviewerFinding[] | null;
}

/**
 * Map a reviewer `source` to a Concern source. The scanners Terramend also runs
 * (checkov / tflint / trivy / terraform-fmt / terraform-validate) keep their
 * name, so re-running them reproduces the identical content id — those concerns
 * are ✗→✓ verifiable. Everything else (tfsec — whose rule ids differ from
 * trivy's — plus infracost, llm, …) collapses to `reviewer`: the original tool
 * stays visible in `rule_id`, but Terramend can't reproduce the id, so
 * `terraform_verify_remediation` will honestly report it unresolved.
 *
 * NB: trivy ✗→✓ verifiability assumes the reviewer's trivy `rule_id` equals
 * Terramend's (both `trivy:<AVDID>`). That holds today (the reviewer's SARIF
 * `ruleId` is the AVD id); if a future Trivy diverges SARIF ruleId from the
 * JSON AVDID, trivy-source findings would stop matching on re-scan.
 */
function mapReviewerSource(source: string | undefined): Concern["source"] {
  switch (source) {
    case "checkov":
    case "tflint":
    case "trivy":
    case "terraform-fmt":
    case "terraform-validate":
      return source;
    default:
      return "reviewer";
  }
}

function mapReviewerCategory(category: string | undefined): Concern["category"] {
  switch (category) {
    case "security":
      return "security";
    case "style":
      return "style";
    case "cost":
      return "cost";
    default:
      return "correctness";
  }
}

/**
 * Map a reviewer `findings.json` body into Concern[]. Drops `human_only`
 * findings (out of scope — not auto-remediable). Paths are normalized to
 * repo-relative POSIX (same as the scanners) so ids and grouping stay portable.
 */
export function parseReviewerFindings(json: string, cwd = ""): Concern[] {
  const parsed = JSON.parse(json || "{}") as ReviewerFindingsReport;
  const out: Concern[] = [];
  for (const f of parsed.findings ?? []) {
    if (f.state === "human_only") continue;
    const file = toRepoRelative(f.location?.file, cwd);
    // Skip findings that don't point at a Terraform file — they aren't per-file
    // remediable. In particular the reviewer's infracost/cost findings are keyed
    // to a project *directory* (not a `.tf`), so they land here; cost is surfaced
    // during remediation by `infracost_diff` (E1), not by editing a directory.
    if (!isTerraformFile(file)) continue;
    const line = f.location?.line ?? null;
    const source = mapReviewerSource(f.source);
    const ruleId = f.rule_id || "finding";
    // Terramend's own parsers store `rule_id` namespaced (`${source}:${rule}`)
    // but hash only the bare rule into the content id. Strip a matching
    // `${source}:` prefix so a checkov/tflint/trivy/fmt finding from the reviewer
    // reproduces the SAME id Terramend's own scan would — keeping it ✗→✓
    // verifiable. `reviewer`-source findings keep the full rule_id in the hash
    // (they aren't reproducible anyway). Both namespaced and bare inputs work.
    const bareRule =
      source !== "reviewer" && ruleId.startsWith(`${source}:`)
        ? ruleId.slice(source.length + 1)
        : ruleId;
    out.push({
      id: concernId(source, bareRule, file, line),
      source,
      rule_id: ruleId,
      severity: lowerSeverity(f.severity),
      category: mapReviewerCategory(f.category),
      evidence: f.evidence || ruleId,
      location: { file, line },
      remediation_hint: f.remediation_hint ?? null,
    });
  }
  return out;
}

// --- SARIF ingestion (read_findings) --------------------------------------

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: { startLine?: number };
  };
}
interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
  properties?: { "security-severity"?: string };
}
interface SarifRule {
  id?: string;
  helpUri?: string;
  shortDescription?: { text?: string };
}
interface SarifRun {
  tool?: { driver?: { name?: string; rules?: SarifRule[] } };
  results?: SarifResult[];
}
interface SarifReport {
  version?: string;
  $schema?: string;
  runs?: SarifRun[];
}

/** true when a parsed JSON object looks like a SARIF report (the standard
 * scanner-output format) rather than a terraform-reviewer findings.json. */
export function isSarif(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const o = parsed as Record<string, unknown>;
  const schema = typeof o.$schema === "string" ? o.$schema.toLowerCase() : "";
  return Array.isArray(o.runs) && (schema.includes("sarif") || typeof o.version === "string");
}

/** map a SARIF driver name to a Concern source (so a re-run reproduces the id
 * for the scanners Terramend also runs; everything else → `reviewer`). */
function mapSarifDriver(name: string | undefined): Concern["source"] {
  switch ((name ?? "").toLowerCase()) {
    case "trivy":
      return "trivy";
    case "checkov":
      return "checkov";
    case "tflint":
      return "tflint";
    default:
      return "reviewer";
  }
}

/** SARIF `level` → severity (a `security-severity` property refines it). */
function sarifSeverity(level: string | undefined, securitySeverity: string | undefined): Severity {
  const score = securitySeverity ? Number.parseFloat(securitySeverity) : Number.NaN;
  if (Number.isFinite(score)) {
    if (score >= 9) return "critical";
    if (score >= 7) return "high";
    if (score >= 4) return "medium";
    if (score > 0) return "low";
  }
  switch ((level ?? "").toLowerCase()) {
    case "error":
      return "high";
    case "warning":
      return "medium";
    case "note":
      return "low";
    default:
      return "info";
  }
}

/**
 * Parse a SARIF 2.1.0 report (the standard scanner-output format Trivy /
 * Checkov / tflint all emit) into Concern[]. The driver name picks the source so
 * a finding from a scanner Terramend re-runs reproduces the SAME content id
 * (✗→✓ verifiable); other tools collapse to `reviewer`. Rule docs come from the
 * matching `tool.driver.rules[].helpUri`. Non-Terraform files are dropped.
 */
export function parseSarifFindings(json: string, cwd = ""): Concern[] {
  let report: SarifReport;
  try {
    report = JSON.parse(json || "{}") as SarifReport;
  } catch {
    return [];
  }
  const out: Concern[] = [];
  for (const run of report.runs ?? []) {
    const source = mapSarifDriver(run.tool?.driver?.name);
    const ruleDocs = new Map<string, string>();
    for (const rule of run.tool?.driver?.rules ?? []) {
      if (rule.id && rule.helpUri) ruleDocs.set(rule.id, rule.helpUri);
    }
    for (const result of run.results ?? []) {
      const loc = result.locations?.[0]?.physicalLocation;
      const file = toRepoRelative(loc?.artifactLocation?.uri, cwd);
      if (!isTerraformFile(file)) continue;
      const start = loc?.region?.startLine;
      const line = typeof start === "number" && start > 0 ? start : null;
      const rawRule = result.ruleId || "finding";
      // strip a `${source}:` prefix if a tool already namespaced it, so the
      // content id matches Terramend's own scan of the same rule.
      const bareRule =
        source !== "reviewer" && rawRule.startsWith(`${source}:`)
          ? rawRule.slice(source.length + 1)
          : rawRule;
      const ruleId = source === "reviewer" ? rawRule : `${source}:${bareRule}`;
      out.push({
        id: concernId(source, bareRule, file, line),
        source,
        rule_id: ruleId,
        severity: sarifSeverity(result.level, result.properties?.["security-severity"]),
        category: source === "tflint" ? "style" : "security",
        evidence: result.message?.text || ruleId,
        location: { file, line },
        remediation_hint: ruleDocs.get(rawRule) ?? null,
      });
    }
  }
  return out;
}

/** dispatch a findings file to the right parser: SARIF (standard scanner
 * output) or a terraform-reviewer findings.json. */
export function parseFindingsFile(json: string, cwd = ""): Concern[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || "{}");
  } catch {
    return [];
  }
  return isSarif(parsed) ? parseSarifFindings(json, cwd) : parseReviewerFindings(json, cwd);
}

// --- SARIF emit (GitHub code-scanning) ------------------------------------

/** Concern severity → SARIF `level`. SARIF has only error/warning/note, so
 * critical+high collapse to `error`, medium → `warning`, low+info → `note`. The
 * finer grade survives in the `security-severity` property below. */
function severityToSarifLevel(s: Severity): "error" | "warning" | "note" {
  switch (s) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    default:
      return "note";
  }
}

/** Concern severity → the numeric `security-severity` GitHub reads to colour the
 * alert (0–10 CVSS-like scale). */
function securitySeverityScore(s: Severity): string {
  switch (s) {
    case "critical":
      return "9.5";
    case "high":
      return "8.0";
    case "medium":
      return "5.0";
    case "low":
      return "2.0";
    default:
      return "0.0";
  }
}

/**
 * Emit a set of concerns as a SARIF 2.1.0 report for GitHub code-scanning (the
 * inverse of `parseSarifFindings` — close the loop so a Terramend scan can
 * populate the repo's Security tab via `github/codeql-action/upload-sarif`). One
 * `run` with the `terramend` driver, a deduped `rules` array (each rule's
 * `helpUri` from `ruleDocUrl`), and one `result` per concern carrying its
 * `level`, `security-severity`, message, and `file:line`. Pure + deterministic
 * (rules sorted, stable partialFingerprints from the content id) so re-emitting
 * an unchanged scan yields a byte-identical report.
 */
export function buildSarifReport(concerns: Concern[]): SarifReport {
  // deduped rule metadata, keyed by the namespaced rule_id (the SARIF ruleId).
  const rulesById = new Map<string, SarifRule>();
  for (const c of concerns) {
    if (rulesById.has(c.rule_id)) continue;
    const helpUri = ruleDocUrl(c);
    rulesById.set(c.rule_id, {
      id: c.rule_id,
      ...(helpUri ? { helpUri } : {}),
      shortDescription: { text: c.evidence.slice(0, 200) },
    });
  }
  const rules = [...rulesById.values()].sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
  const results: SarifResult[] = concerns.map((c) => ({
    ruleId: c.rule_id,
    level: severityToSarifLevel(c.severity),
    message: { text: c.evidence },
    properties: { "security-severity": securitySeverityScore(c.severity) },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: c.location.file },
          ...(c.location.line ? { region: { startLine: c.location.line } } : {}),
        },
      },
    ],
  }));
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{ tool: { driver: { name: "terramend", rules } }, results }],
  };
}

export const TerraformEmitSarifParams = type({
  "output_path?": type.string.describe(
    "where to write the SARIF file (default: ./terramend.sarif in the workspace). Upload it with github/codeql-action/upload-sarif to populate the repo's Security tab."
  ),
  "severity_threshold?": type("'critical' | 'high' | 'medium' | 'low' | 'info'").describe(
    "minimum severity to include (default: the run's configured threshold, else low)."
  ),
});

export function TerraformEmitSarifTool(ctx: ToolContext) {
  return tool({
    name: "terraform_emit_sarif",
    description:
      "Emit the current best-practice scan as a SARIF 2.1.0 file for GitHub code-scanning (§3.5). Re-runs " +
      "the scanners and writes a SARIF report (default `terramend.sarif`) that a later workflow step uploads " +
      "with `github/codeql-action/upload-sarif`, surfacing every concern in the repo's Security tab with the " +
      "right severity + doc link. This is the EMIT side (the inverse of `read_findings`' SARIF INGEST) — use " +
      "it when the goal is to REPORT findings to code-scanning rather than open a remediation PR. Degrades " +
      "green: writes an empty-result report when the tree is clean.",
    parameters: TerraformEmitSarifParams,
    execute: execute(async ({ output_path, severity_threshold }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";
      const minRank = SEVERITY_RANK[threshold];
      const outcomes = runScanners(cwd);
      const concerns = sortConcerns(dedupe(outcomes.flatMap((o) => o.concerns)))
        .filter(isTerraformConcern)
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank);
      const report = buildSarifReport(concerns);
      const target = output_path
        ? isAbsolute(output_path)
          ? output_path
          : join(cwd, output_path)
        : join(cwd, "terramend.sarif");
      try {
        writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      } catch (e) {
        return skipResult(
          "sarif_write_failed",
          `could not write SARIF to ${target}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
      log.info(`» terraform_emit_sarif: ${concerns.length} result(s) → ${target}`);
      return toolOk({
        sarif_path: target,
        result_count: concerns.length,
        rule_count: report.runs?.[0]?.tool?.driver?.rules?.length ?? 0,
        note: "Upload with github/codeql-action/upload-sarif to populate the repo's Security tab.",
      });
    }),
  });
}

// --- terraform plan (the safety gate) -------------------------------------

export interface PlanSummary {
  /** resources to add / change / destroy, from the plan's change_summary. */
  add: number;
  change: number;
  destroy: number;
  /** every resource with a real action (create/update/delete/replace) — the set
   * that powers blast-radius (§2.6) and plan-stability (§1.3). */
  changed: { address: string; action: string }[];
  /** resources that would be deleted or replaced — the destructive set. */
  destructive: { address: string; action: string }[];
  hasDestroyOrReplace: boolean;
}

/**
 * Parse `terraform plan -json` (newline-delimited JSON). `change_summary` gives
 * the add/change/destroy totals; each `planned_change` with a real action is
 * collected into `changed`, and the delete/replace subset into `destructive`
 * (the high-risk set a reviewer must scrutinise). Non-mutating actions are
 * ignored, as are non-JSON / non-plan lines, so a noisy stream (provider logs,
 * diagnostics) parses cleanly.
 *
 * NB on the action enum: terraform's machine-readable UI (the `-json` stream)
 * spells no-op as `"noop"` — NOT `"no-op"` — and also emits `"move"` / `"import"`
 * / `"forget"` for state-only operations that don't mutate live infrastructure.
 * None of those should count toward `changed` (they'd inflate the blast radius
 * §2.6). We skip them explicitly; `"no-op"` is tolerated too in case a wrapper
 * or older format hyphenates it. See
 * https://developer.hashicorp.com/terraform/internals/machine-readable-ui.
 */
const NON_MUTATING_PLAN_ACTIONS: ReadonlySet<string> = new Set([
  "noop",
  "no-op",
  "read",
  "move",
  "import",
  "forget",
]);

export function parseTerraformPlanJson(stdout: string): PlanSummary {
  let add = 0;
  let change = 0;
  let destroy = 0;
  const changed: { address: string; action: string }[] = [];
  const destructive: { address: string; action: string }[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let msg: {
      type?: string;
      changes?: { add?: number; change?: number; remove?: number };
      change?: { action?: string; resource?: { addr?: string; resource?: string } };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (msg.type === "change_summary" && msg.changes) {
      add = Number(msg.changes.add) || 0;
      change = Number(msg.changes.change) || 0;
      destroy = Number(msg.changes.remove) || 0;
    } else if (msg.type === "planned_change" && msg.change) {
      const action = String(msg.change.action ?? "");
      if (!action || NON_MUTATING_PLAN_ACTIONS.has(action)) continue;
      const address = msg.change.resource?.addr || msg.change.resource?.resource || "(unknown)";
      changed.push({ address, action });
      // "delete", "replace", and the "*-then-delete" / "delete-then-*" forms.
      if (action.includes("delete") || action === "replace") {
        destructive.push({ address, action });
      }
    }
  }
  return { add, change, destroy, changed, destructive, hasDestroyOrReplace: destructive.length > 0 };
}

// --- stateful destroy/replace classification (safety gate §2.5) ------------

/**
 * Resource types that hold data/state — destroying or replacing one of these
 * means data loss, not just recreation. A remediation that would delete or
 * replace one is hard-blocked at push time unless the operator opts in via the
 * `allow_replace` input. Not exhaustive: it covers the common managed
 * datastores across AWS / Azure / GCP; extend as new ones come up.
 */
export const STATEFUL_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  // AWS
  "aws_db_instance",
  "aws_rds_cluster",
  "aws_rds_cluster_instance",
  "aws_s3_bucket",
  "aws_ebs_volume",
  "aws_efs_file_system",
  "aws_dynamodb_table",
  "aws_dynamodb_global_table",
  "aws_elasticache_cluster",
  "aws_elasticache_replication_group",
  "aws_redshift_cluster",
  "aws_docdb_cluster",
  "aws_neptune_cluster",
  "aws_opensearch_domain",
  "aws_elasticsearch_domain",
  // Azure
  "azurerm_sql_database",
  "azurerm_mssql_database",
  "azurerm_postgresql_database",
  "azurerm_postgresql_flexible_server",
  "azurerm_mysql_database",
  "azurerm_mysql_flexible_server",
  "azurerm_cosmosdb_account",
  "azurerm_cosmosdb_sql_database",
  "azurerm_storage_account",
  "azurerm_managed_disk",
  // GCP
  "google_sql_database_instance",
  "google_storage_bucket",
  "google_bigtable_instance",
  "google_bigquery_dataset",
  "google_spanner_database",
  "google_redis_instance",
  "google_filestore_instance",
  "google_compute_disk",
]);

/**
 * Extract the Terraform resource TYPE from a plan address, stripping any
 * `module.<name>.` prefixes and an instance index/key suffix:
 *   `module.db.aws_db_instance.main`               -> `aws_db_instance`
 *   `aws_s3_bucket.data["prod"]`                   -> `aws_s3_bucket`
 *   `module.a.module.b.google_storage_bucket.x[0]` -> `google_storage_bucket`
 * Returns "" when the address has no parseable `type.name` pair.
 */
export function resourceTypeOf(address: string): string {
  const withoutModules = address.replace(/^(?:module\.[^.]+\.)+/, "");
  const cleaned = withoutModules.replace(/\[[^\]]*\]$/, "");
  const segments = cleaned.split(".");
  return segments.length >= 2 ? segments[segments.length - 2] : "";
}

export interface DestroyClassification {
  /** destroy/replace of a data-bearing type — high-risk, blocked by default. */
  stateful: { address: string; action: string; type: string }[];
  /** destroy/replace of a recreatable type — recorded, not blocked. */
  ephemeral: { address: string; action: string; type: string }[];
}

/** partition a plan's destructive set into stateful (blocked) vs ephemeral. */
export function classifyDestructive(
  destructive: { address: string; action: string }[]
): DestroyClassification {
  const stateful: DestroyClassification["stateful"] = [];
  const ephemeral: DestroyClassification["ephemeral"] = [];
  for (const d of destructive) {
    const type = resourceTypeOf(d.address);
    (STATEFUL_RESOURCE_TYPES.has(type) ? stateful : ephemeral).push({ ...d, type });
  }
  return { stateful, ephemeral };
}

// --- blast-radius scoring (§2.6) -------------------------------------------

export type BlastTier = "low" | "medium" | "high";

export interface BlastRadius {
  tier: BlastTier;
  /** count of resources the plan would create/update/delete/replace. */
  resourceCount: number;
  /** distinct module addresses touched (root resources count as `root`). */
  modules: string[];
}

/**
 * Extract the module address from a resource address: the `module.X[.module.Y]`
 * call path, or `root` for a top-level resource. Strips instance index/key from
 * EVERY segment — a `count`/`for_each` MODULE carries its key on the module
 * segment (`module.net[0]`), so all instances of one module collapse to one
 * address (else a single-module fix would look cross-module). Removing keys
 * first also tolerates a `.` inside a `for_each` string key.
 *   `aws_s3_bucket.b`                  -> `root`
 *   `module.db.aws_db_instance.main`   -> `module.db`
 *   `module.net[0].aws_vpc.main`       -> `module.net`
 *   `module.a.module.b.google_x.y[0]`  -> `module.a.module.b`
 */
export function moduleAddressOf(address: string): string {
  const cleaned = address.replace(/\[[^\]]*\]/g, "");
  const segments = cleaned.split(".");
  // the resource is the final `type.name` pair; anything before is the module path.
  return segments.length <= 2 ? "root" : segments.slice(0, segments.length - 2).join(".");
}

/**
 * Score how much a fix touches, to route large changes through stricter review:
 * 1–2 resources = `low`, 3–10 = `medium`, more than 10 OR spanning more than one
 * module = `high`. A `high` blast radius should force human-in-the-loop
 * regardless of finding severity (feeds §3.9). 0 changes is `low` (nothing to do).
 */
export function computeBlastRadius(changed: { address: string }[]): BlastRadius {
  const resourceCount = changed.length;
  const modules = [...new Set(changed.map((c) => moduleAddressOf(c.address)))].sort();
  const crossModule = modules.length > 1;
  let tier: BlastTier;
  if (resourceCount > 10 || crossModule) tier = "high";
  else if (resourceCount >= 3) tier = "medium";
  else tier = "low";
  return { tier, resourceCount, modules };
}

// --- severity-driven autonomy (§3.9) ---------------------------------------

export type Autonomy = "auto" | "needs-human";

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
  blastTier?: BlastTier
): AutonomyDecision {
  const reasons: string[] = [];
  const minRank = SEVERITY_RANK[threshold];
  const escalating = concerns.filter(
    (c) => c.category === "security" && SEVERITY_RANK[c.severity] >= minRank
  );
  if (escalating.length > 0) {
    const top = escalating.reduce((max, c) =>
      SEVERITY_RANK[c.severity] > SEVERITY_RANK[max.severity] ? c : max
    );
    reasons.push(
      `${escalating.length} security concern(s) at/above the ${threshold} autonomy threshold (highest: ${top.severity})`
    );
  }
  if (blastTier === "high") {
    reasons.push("high blast radius — the fix touches more than 10 resources or spans more than one module");
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
  if (!opts.hasPrContext) return { suggest: false, reason: "no existing PR to attach a suggestion to" };
  if (opts.severity !== "low" && opts.severity !== "info") {
    return { suggest: false, reason: `severity ${opts.severity} warrants a reviewable PR, not a one-click suggestion` };
  }
  if (opts.fileCount > 1 || opts.hunkCount > 1) {
    return { suggest: false, reason: "multi-hunk / multi-file fix — open a full PR" };
  }
  if (opts.blastTier === "high" || opts.blastTier === "medium") {
    return { suggest: false, reason: `blast radius ${opts.blastTier} — open a full PR` };
  }
  return { suggest: true, reason: "single-hunk low-risk fix on an existing PR — post as a one-click suggestion" };
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
    return { level: "low", reasons: ["the re-scan did not confirm every targeted concern was resolved (§1.1)"] };
  }
  if (signals.regressionCount > 0) {
    return {
      level: "low",
      reasons: [`the fix introduced ${signals.regressionCount} new concern(s) (§1.4 regression)`],
    };
  }
  reasons.push("re-scan verified every targeted concern resolved (§1.1) with no regressions (§1.4)");

  let level: Confidence = "high";
  const capMedium = (reason: string) => {
    if (level === "high") level = "medium";
    reasons.push(reason);
  };
  if (signals.idempotent === false) capMedium("plan is non-deterministic (§1.3) — a perpetual-diff smell");
  if (signals.blastTier === "high") capMedium("high blast radius (§2.6) — review carefully");
  if (signals.costDirection === "increase") capMedium("the fix increases monthly cost (§4.16)");
  if (signals.idempotent === undefined || signals.blastTier === undefined) {
    capMedium("no terraform plan evidence (no cloud credentials) — idempotency and blast radius unproven");
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
    reason: "narrowing an IAM policy needs the exact action/resource set the workload uses — a human decision",
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
  concern: Pick<Concern, "source" | "rule_id">
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

// --- plan stability / idempotency (§1.3) -----------------------------------

export interface StabilityResult {
  /** true when a second plan produced the identical change set. */
  stable: boolean;
  reason?: string;
}

/** a normalized signature of a plan's change set (summary counts + sorted
 * address:action pairs) — two plans with the same signature are equivalent. */
function planSignature(s: PlanSummary): string {
  const set = s.changed
    .map((c) => `${c.address}:${c.action}`)
    .sort()
    .join(",");
  return `+${s.add}~${s.change}-${s.destroy}|${set}`;
}

/**
 * Compare two consecutive plans for stability. Terramend never `apply`s (it only
 * opens PRs), so a true "no perpetual diff after apply" cannot be proven here —
 * but a fix whose plan is non-deterministic (e.g. `timestamp()`, `uuid()`, an
 * unkeyed `random_*`, or a data source that varies run-to-run) yields a DIFFERENT
 * plan on the second run, and that is a real perpetual-diff smell we can catch
 * without applying. Stable ⇒ the two plans matched; unstable ⇒ report it.
 */
export function comparePlanStability(first: PlanSummary, second: PlanSummary): StabilityResult {
  if (planSignature(first) === planSignature(second)) return { stable: true };
  return {
    stable: false,
    reason:
      `the plan is not deterministic — a second \`terraform plan\` (same state, no apply) produced a ` +
      `different change set (first: +${first.add} ~${first.change} -${first.destroy}; ` +
      `second: +${second.add} ~${second.change} -${second.destroy}). This is a perpetual-diff smell, ` +
      `usually a non-deterministic value in the config (timestamp()/uuid()/unkeyed random_*/a varying data source).`,
  };
}

// --- multi-root plan aggregation -------------------------------------------

export interface RootPlan {
  /** display label for the root ("." for the top-level root). */
  dir: string;
  summary: PlanSummary;
  stable: boolean;
}

export interface AggregatedPlan {
  add: number;
  change: number;
  destroy: number;
  changed: { address: string; action: string }[];
  destructive: { address: string; action: string }[];
  hasDestroyOrReplace: boolean;
  idempotent: boolean;
}

/**
 * Aggregate per-root plan results into one view: SUM the add/change/destroy
 * counts, UNION the changed + destructive sets (so blast-radius and the
 * destroy-block see every root's effect), and treat the whole run as
 * non-idempotent if ANY root's plan was unstable. Pure. Single-root input passes
 * straight through (identical to the pre-multi-root behaviour).
 */
export function aggregatePlans(roots: RootPlan[]): AggregatedPlan {
  let add = 0;
  let change = 0;
  let destroy = 0;
  let idempotent = true;
  const changed: { address: string; action: string }[] = [];
  const destructive: { address: string; action: string }[] = [];
  for (const r of roots) {
    add += r.summary.add;
    change += r.summary.change;
    destroy += r.summary.destroy;
    changed.push(...r.summary.changed);
    destructive.push(...r.summary.destructive);
    if (!r.stable) idempotent = false;
  }
  return { add, change, destroy, changed, destructive, hasDestroyOrReplace: destructive.length > 0, idempotent };
}

const PLAN_JSON_ARGS = ["plan", "-input=false", "-no-color", "-lock=false", "-json"];

interface RootPlanOutcome {
  ran: boolean;
  skipReason?: string | undefined;
  summary?: PlanSummary | undefined;
  stable?: boolean | undefined;
  stabilityReason?: string | undefined;
  planText?: string | undefined;
}

/** init + plan (+ a stability re-plan + a human-readable plan) in a SINGLE root.
 * Used by terraform_plan once per discovered root. */
function planOneRoot(absDir: string, creds: Record<string, string>): RootPlanOutcome {
  const init = run("terraform", ["init", "-input=false", "-no-color"], absDir, creds);
  if (init.missing) return { ran: false, skipReason: "terraform not installed" };
  if (init.status !== 0) {
    return { ran: false, skipReason: `terraform init failed: ${init.stderr.trim().slice(0, 200) || "unknown error"}` };
  }
  const plan = run("terraform", PLAN_JSON_ARGS, absDir, creds);
  if (plan.status !== 0) {
    return { ran: false, skipReason: `terraform plan failed: ${plan.stderr.trim().slice(0, 200) || "unknown error"}` };
  }
  const summary = parseTerraformPlanJson(plan.stdout);
  const hasChanges = summary.add + summary.change + summary.destroy > 0 || summary.changed.length > 0;

  // §1.3 stability: re-plan once and compare (only when there's a change).
  let stable = true;
  let stabilityReason: string | undefined;
  if (hasChanges) {
    const plan2 = run("terraform", PLAN_JSON_ARGS, absDir, creds);
    if (plan2.status === 0) {
      const s = comparePlanStability(summary, parseTerraformPlanJson(plan2.stdout));
      stable = s.stable;
      stabilityReason = s.reason;
    }
  }
  // §1.2 human-readable plan for the PR <details> block (separate non-json run).
  let planText: string | undefined;
  if (hasChanges) {
    const readable = run("terraform", ["plan", "-input=false", "-no-color", "-lock=false"], absDir, creds);
    if (readable.status === 0 && readable.stdout.trim()) planText = readable.stdout.trim().slice(0, 12_000);
  }
  return { ran: true, summary, stable, stabilityReason, planText };
}

// env vars that signal a cloud provider credential is present — terraform plan
// needs live provider/backend access, so we only attempt it when one is set.
const CLOUD_CRED_SIGNALS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "ARM_CLIENT_ID",
  "ARM_USE_OIDC",
  "AZURE_CLIENT_ID",
  "GOOGLE_CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
] as const;

function hasCloudCredentials(): boolean {
  return CLOUD_CRED_SIGNALS.some((k) => !!process.env[k]);
}

// env vars terraform/providers legitimately consume, re-admitted past the
// secret-stripping `run()` env for the plan invocation. Terramend is BYOK
// across providers (Anthropic / OpenAI / Google Gemini / …), so NONE of those
// LLM keys may leak into the terraform subprocess. PREFIXES are only ones that
// can't collide with a provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
// `GEMINI_API_KEY` carry no cloud prefix; the bare `GOOGLE_` prefix is
// deliberately NOT used — it would re-admit `GOOGLE_GENERATIVE_AI_API_KEY`).
// GCP creds are matched by exact NAME / the safe `GOOGLE_CLOUD_` prefix instead.
const CLOUD_CRED_PREFIXES = ["AWS_", "ARM_", "AZURE_", "GCLOUD_", "GOOGLE_CLOUD_", "TF_VAR_", "TF_TOKEN_", "TF_CLI_"];
const CLOUD_CRED_NAMES = new Set([
  "GOOGLE_CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_KEYFILE_JSON",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "GOOGLE_PROJECT",
  "GOOGLE_REGION",
  "GOOGLE_ZONE",
  "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT",
]);

// LLM/model-provider credentials that collide with a cloud PREFIX above and so
// must be explicitly denied — otherwise a BYOK key would leak into the terraform
// subprocess. `AWS_BEARER_TOKEN_BEDROCK` (Amazon Bedrock) matches `AWS_`;
// `AZURE_OPENAI_*` matches `AZURE_`. NB `AWS_REGION` (also a Bedrock env var) is
// a legitimate cloud/terraform setting and is intentionally NOT denied. Keep in
// sync with the provider `envVars` in src/models.ts.
const LLM_CRED_DENY = new Set([
  "AWS_BEARER_TOKEN_BEDROCK",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
]);

export function collectCloudCredentials(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (LLM_CRED_DENY.has(k)) continue; // never leak a model-provider key, even if it matches a cloud prefix
    if (CLOUD_CRED_PREFIXES.some((p) => k.startsWith(p)) || CLOUD_CRED_NAMES.has(k)) env[k] = v;
  }
  return env;
}

export const TerraformPlanParams = type({});

export function TerraformPlanTool(ctx: ToolContext) {
  return tool({
    name: "terraform_plan",
    description:
      "Run `terraform plan` and report the planned change summary (resources to add / change / destroy), " +
      "any resource that would be DESTROYED or REPLACED, a blast-radius score (how much the fix touches), " +
      "and a plan-stability check (a second plan must match the first — a perpetual-diff smell otherwise). " +
      "Opt-in and degrades green — it auto-skips (returns `ran: false`, never fails the run) when no cloud " +
      "credentials are detected, terraform is not installed, or init/plan can't complete (plan needs live " +
      "provider/backend access). Call it after a fix to attach the real-world effect to the PR and surface " +
      "destructive changes for human review. **Multi-root aware:** it plans EVERY Terraform root in the repo " +
      "(`roots_planned`) and aggregates — counts summed, destructive/blast unioned — so you don't loop " +
      "yourself. Returns `plan_text` (the full human-readable plan(s), for a collapsed <details> block) and " +
      "`needs_human` (true when a high blast radius, a stateful destroy/replace, or a non-deterministic plan " +
      "means a human must review).",
    parameters: TerraformPlanParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      if (!hasCloudCredentials()) {
        return skipResult(
          "no_cloud_credentials",
          "no cloud credentials detected — terraform plan needs provider/backend access; skipped (add AWS/Azure/GCP creds or an OIDC role to enable it)"
        );
      }
      const creds = collectCloudCredentials();

      // multi-root: plan EACH root (hepcare: terraform/ + terraform/core/) and
      // aggregate. resolveRoots falls back to [cwd] for a single-root repo, so
      // behaviour there is identical to before.
      const roots = resolveRoots(cwd);
      const perRoot = roots.map((r) => ({ dir: r.relDir || ".", outcome: planOneRoot(r.absDir, creds) }));
      const ran = perRoot.filter((p) => p.outcome.ran);
      if (ran.length === 0) {
        // every root skipped — surface the first reason (e.g. not installed / init failed).
        const reason = perRoot[0]?.outcome.skipReason ?? "no terraform root could be planned";
        const code = reason.includes("not installed")
          ? "terraform_not_installed"
          : reason.includes("init failed")
            ? "terraform_init_failed"
            : "terraform_plan_failed";
        return skipResult(code, `terraform plan skipped — ${reason}`);
      }

      const rootPlans: RootPlan[] = ran.map((p) => ({ dir: p.dir, summary: p.outcome.summary!, stable: p.outcome.stable! }));
      const agg = aggregatePlans(rootPlans);
      const classified = classifyDestructive(agg.destructive);
      const blastRadius = computeBlastRadius(agg.changed);
      // record the UNION across roots so the push-time destroy-block guardrail
      // blocks if ANY root would destroy/replace a stateful resource.
      ctx.toolState.plannedDestroy = { stateful: classified.stateful, ephemeral: classified.ephemeral };
      // §5.19 — record the blast tier + idempotency for the confidence label.
      ctx.toolState.lastBlastTier = blastRadius.tier;
      ctx.toolState.lastIdempotent = agg.idempotent;

      // §1.2 — per-root human-readable plans, headed by root, for the PR <details>.
      const planTextParts = ran
        .filter((p) => p.outcome.planText)
        .map((p) => (ran.length > 1 ? `### Root: ${p.dir}\n${p.outcome.planText}` : p.outcome.planText));
      const planText = planTextParts.length ? planTextParts.join("\n\n").slice(0, 20_000) : undefined;
      const idempotencyWarning = ran.find((p) => !p.outcome.stable)?.outcome.stabilityReason;

      // §2.6 → §3.9 — deterministic escalation to human review.
      const escalationReasons: string[] = [];
      if (blastRadius.tier === "high") {
        escalationReasons.push(`high blast radius (${blastRadius.resourceCount} resources / ${blastRadius.modules.length} modules)`);
      }
      if (classified.stateful.length > 0) {
        escalationReasons.push(`${classified.stateful.length} stateful resource(s) would be destroyed/replaced`);
      }
      if (!agg.idempotent) escalationReasons.push("non-deterministic plan (perpetual-diff smell)");

      log.info(
        `» terraform_plan: +${agg.add} ~${agg.change} -${agg.destroy} across ${ran.length} root(s) ` +
          `[blast: ${blastRadius.tier}, ${blastRadius.resourceCount} res / ${blastRadius.modules.length} mod]` +
          (agg.hasDestroyOrReplace
            ? ` (DESTRUCTIVE: ${agg.destructive.length}, stateful: ${classified.stateful.length})`
            : "") +
          (agg.idempotent ? "" : " ⚠ UNSTABLE (non-deterministic plan)") +
          (escalationReasons.length ? " ⚠ needs-human" : "")
      );
      return toolOk({
        ran: true,
        roots_planned: ran.map((p) => p.dir),
        to_add: agg.add,
        to_change: agg.change,
        to_destroy: agg.destroy,
        has_destroy_or_replace: agg.hasDestroyOrReplace,
        destructive: agg.destructive,
        // data-bearing resources that would be lost — these block the push
        // unless allowed via `allow_replace`.
        stateful_destructive: classified.stateful,
        // §2.6 — how much this fix touches; `high` should force human review.
        blast_radius: blastRadius,
        // §1.3 — false when any root's second plan disagreed (perpetual-diff smell).
        idempotent: agg.idempotent,
        idempotency_warning: idempotencyWarning,
        // §2.6 → §3.9 — deterministic escalation to human review.
        needs_human: escalationReasons.length > 0,
        ...(escalationReasons.length ? { needs_human_reasons: escalationReasons } : {}),
        // §1.2 — full human-readable plan(s) for a collapsed <details> block.
        ...(planText ? { plan_text: planText } : {}),
        // roots where plan couldn't run (no backend creds for that root, etc.).
        ...(perRoot.some((p) => !p.outcome.ran)
          ? { roots_skipped: perRoot.filter((p) => !p.outcome.ran).map((p) => ({ dir: p.dir, reason: p.outcome.skipReason })) }
          : {}),
      });
    }),
  });
}

export const ReadFindingsParams = type({
  "path?": type.string.describe(
    "path to the Assessor's findings.json. Defaults to $TERRAMEND_FINDINGS_PATH, then ./findings.json in the workspace."
  ),
  "severity_threshold?": type("'critical' | 'high' | 'medium' | 'low' | 'info'").describe(
    "minimum severity to report (default: the run's configured threshold, else low)."
  ),
  "group_by?": type("'file' | 'rule'").describe(
    "'file' (default) makes one group per file; 'rule' groups a single rule across all files into one group (§3.11)."
  ),
});

export function ReadFindingsTool(ctx: ToolContext) {
  return tool({
    name: "read_findings",
    description:
      "Load best-practice concerns from a terraform-reviewer (Assessor) findings.json INSTEAD of running " +
      "the scanners. Returns the SAME { concerns, groups, summary } shape as terraform_scan, so Remediate " +
      "consumes it identically. `human_only` findings and non-Terraform files are dropped. Concerns from " +
      "checkov / tflint / terraform-fmt re-verify deterministically (✗→✓); findings exclusive to the reviewer " +
      "(tfsec / infracost / llm) carry source `reviewer` and can't be reproduced by Terramend's scanners, so " +
      "terraform_verify_remediation will report them unresolved — rely on terraform_validate + your explanation " +
      "for those. Returns `found: false` (never an error) when no findings.json is present.",
    parameters: ReadFindingsParams,
    execute: execute(async ({ path, severity_threshold, group_by }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const findingsPath = path || process.env.TERRAMEND_FINDINGS_PATH || join(cwd, "findings.json");
      let raw: string;
      try {
        raw = readFileSync(findingsPath, "utf8");
      } catch {
        return skipResult(
          "findings_not_found",
          `no findings.json at ${findingsPath} (set the path arg or $TERRAMEND_FINDINGS_PATH)`,
          { key: "found", reasonKey: "reason", extra: { concerns: [], groups: [] } }
        );
      }
      let parsed: Concern[];
      try {
        // accept BOTH a terraform-reviewer findings.json AND a standard SARIF
        // report (Trivy/Checkov/tflint -o sarif) — the dispatcher detects which.
        parsed = parseFindingsFile(raw, cwd);
      } catch {
        return skipResult("findings_parse_error", `could not parse findings file at ${findingsPath}`, {
          key: "found",
          reasonKey: "reason",
          extra: { concerns: [], groups: [] },
        });
      }

      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";
      const minRank = SEVERITY_RANK[threshold];

      // §1.4 baseline — same role as terraform_scan's, so a regression check
      // after a reviewer-sourced fix has a baseline to diff against.
      ctx.toolState.baselineConcernIds = dedupe(parsed).map((c) => c.id);

      const all = sortConcerns(dedupe(parsed))
        .filter(isTerraformConcern)
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank);
      // §3.9 + §3.11 — group (by-file or by-rule) and annotate autonomy, exactly
      // as terraform_scan does, so the rest of the Remediate checklist is
      // source-agnostic.
      const grouping = group_by ?? "file";
      const autonomyThreshold = (ctx.payload.autonomyThreshold as Severity | undefined) ?? "high";
      const groups = annotateGroups(
        grouping === "rule" ? groupConcernsByRule(all) : groupConcerns(all),
        all,
        autonomyThreshold
      );
      const batchPlan = planBatches(groups);
      const by_severity: Record<string, number> = {};
      for (const c of all) by_severity[c.severity] = (by_severity[c.severity] ?? 0) + 1;

      log.info(`» read_findings: ${all.length} concern(s) ≥ ${threshold} from ${findingsPath} (${groups.length} ${grouping}-group(s))`);

      return toolOk({
        found: true,
        source_file: findingsPath,
        grouping,
        summary: { total: all.length, groups: groups.length, by_severity },
        groups: groups.map((g) => ({ ...g, doc_urls: docUrlsForGroup(g, all) })),
        batch_plan: batchPlan,
        concerns: all.map((c) => ({ ...c, doc_url: ruleDocUrl(c) })),
      });
    }),
  });
}
