import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { walkTfFiles } from "#app/mcp/modules";
import { loadProvidersSchema, unknownArgsForResource } from "#app/mcp/providerSchema";
import {
  type Concern,
  concernId,
  dedupe,
  lowerSeverity,
  type ResolvedRoot,
  rebaseConcern,
  resolveBaseRef,
  resolveRoots,
  run,
  type ScannerOutcome,
  type Severity,
  skipped,
  toRepoRelative,
} from "#app/mcp/terraform/types";
import { log } from "#app/utils/cli";

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

export function scanFmt(cwd: string): ScannerOutcome {
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

/** run `terraform validate` in one root and return concerns re-based onto cwd. */
function scanValidateRoot(root: ResolvedRoot): ScannerOutcome {
  ensureTerraformInit(root.absDir);
  const r = run("terraform", ["validate", "-json"], root.absDir);
  if (r.missing) return skipped("terraform-validate", "terraform not installed");
  try {
    const concerns = parseValidateOutput(r.stdout, root.absDir).map((c) =>
      rebaseConcern(c, root.relDir),
    );
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
export function scanValidate(cwd: string): ScannerOutcome {
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
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex-exec iteration
    while ((m = objRe.exec(body)) !== null) {
      const name = m[1]!;
      const inner = m[2]!;
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
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex-exec iteration
    while ((m = strRe.exec(bodyNoObjects)) !== null) {
      const name = m[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source: null, version: m[2]!, major: majorOf(m[2]!) });
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
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex-exec iteration
  while ((m = re.exec(hcl)) !== null) {
    const resourceType = m[1]!;
    const name = m[2]!;
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
 * A non-code span in HCL — a `"…"` string, a `#`/`//` line comment, or a
 * `<<EOF` heredoc — that the brace/argument scanners must skip wholesale (an
 * interpolation's `${…}`, a commented `}`, or a heredoc's `key = value` lines
 * would otherwise corrupt brace depth or fabricate arguments). Returned for a
 * span starting at `i`: `end` is the index of its LAST char (caller resumes at
 * `end + 1`), and `endsLine` is true when the span finished at a line boundary
 * (comment / heredoc — the next token begins a fresh statement). null when `i`
 * isn't the start of a non-code span. Single source of truth for both scanners.
 */
function skipNonCode(s: string, i: number): { end: number; endsLine: boolean } | null {
  const ch = s[i];
  // double-quoted string (with `\` escapes). Ends mid-line.
  if (ch === '"') {
    let j = i + 1;
    while (j < s.length && s[j] !== '"') {
      if (s[j] === "\\") j++;
      j++;
    }
    return { end: j, endsLine: false };
  }
  // heredoc body (`<<EOF` / `<<-EOF` / `<<~EOF`) — arbitrary text.
  if (ch === "<" && s[i + 1] === "<") {
    const m = /^<<[-~]?([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i, i + 80));
    if (m) {
      const delim = m[1];
      const openNl = s.indexOf("\n", i);
      if (openNl === -1) return { end: s.length - 1, endsLine: true };
      // the closing delimiter sits alone on its own line (optionally indented).
      const closeRe = new RegExp(`\\n[ \\t]*${delim}[ \\t]*(?=\\n|$)`);
      const cm = closeRe.exec(s.slice(openNl));
      const end = cm ? openNl + cm.index + cm[0].length - 1 : s.length - 1;
      return { end, endsLine: true };
    }
  }
  // `#` or `//` line comment.
  if (ch === "#" || (ch === "/" && s[i + 1] === "/")) {
    const nl = s.indexOf("\n", i);
    return { end: nl === -1 ? s.length - 1 : nl, endsLine: true };
  }
  return null;
}

/** brace-match from an opening `{` at `open`; returns the inner text + end index
 * (the matching `}`), string/comment/heredoc-aware so interpolation braces, a
 * commented `}`, or a heredoc body don't fool it. */
function matchBraceBody(hcl: string, open: string | number): { text: string; end: number } | null {
  const start = typeof open === "number" ? open : -1;
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < hcl.length; i++) {
    const span = skipNonCode(hcl, i);
    if (span) {
      i = span.end;
      continue;
    }
    const ch = hcl[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { text: hcl.slice(start + 1, i), end: i };
    }
  }
  return null;
}

/** extract the depth-0 argument names from a resource block body (string-,
 * comment-, and heredoc-aware), excluding meta-arguments. */
function topLevelArgNames(body: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  let atStmtStart = true;
  for (let i = 0; i < body.length; i++) {
    const span = skipNonCode(body, i);
    if (span) {
      i = span.end;
      // a comment/heredoc ends a line (next token is a fresh statement); a
      // string ends mid-line (still inside the current statement).
      atStmtStart = span.endsLine;
      continue;
    }
    const ch = body[i]!;
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
      while (j < body.length && /[A-Za-z0-9_-]/.test(body[j]!)) j++;
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
    log.info(
      "» tflint --init did not complete cleanly — provider ruleset plugins may be unavailable",
    );
  }
}

export function scanTflint(cwd: string): ScannerOutcome {
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
  const r = run(
    "checkov",
    ["-d", ".", "--framework", "terraform", "-o", "json", "--compact", "--quiet"],
    cwd,
  );
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

/**
 * Terraform files changed on the current branch vs the base. Returns null when
 * the base can't be determined (caller then falls back to a full scan).
 */
export function changedTerraformFiles(cwd: string): Set<string> | null {
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
export function runScanners(cwd: string): ScannerOutcome[] {
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
  currentConcernIds: Set<string>,
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
  currentConcernIds: Iterable<string>,
): string[] {
  const baseline = new Set(baselineConcernIds);
  const regressions = new Set<string>();
  for (const id of currentConcernIds) {
    if (!baseline.has(id)) regressions.add(id);
  }
  return [...regressions].sort();
}
