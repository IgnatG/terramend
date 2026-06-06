import { isAbsolute, resolve } from "node:path";
import * as core from "@actions/core";
import { type } from "arktype";
import type { AuthorPermission, PayloadEvent } from "#app/external";
import { BUILTIN_MODE_NAMES } from "#app/modes";
import packageJson from "#package.json" with { type: "json" };
import { log } from "#app/utils/cli";
import type { RepoSettings } from "#app/utils/runContext";
import { validateCompatibility } from "#app/utils/versioning";

// tool permission enum types for inputs
const ShellPermissionInput = type.enumerated("disabled", "restricted", "enabled");
const PushPermissionInput = type.enumerated("disabled", "restricted", "enabled");

// schema for JSON payload passed via prompt (internal dispatch invocation)
// note: permissions are intentionally NOT included here to prevent injection attacks
// permissions are derived from event.authorPermission instead
export const JsonPayload = type({
  "~terramend": "true",
  version: "string",
  "model?": "string | undefined",
  prompt: "string",
  "triggerer?": "string | undefined",

  "eventInstructions?": "string",
  "previousRunsNote?": "string",
  "event?": "object",
  "timeout?": "string | undefined",
  "progressComment?": type({
    id: "string",
    type: "'issue' | 'review'",
  }).or("undefined"),
  "generateSummary?": "boolean | undefined",
});

// permission levels that indicate collaborator status (have push access)
const COLLABORATOR_PERMISSIONS: AuthorPermission[] = ["admin", "maintain", "write"];

// check if the event author has collaborator-level permissions
function isCollaborator(event: PayloadEvent): boolean {
  const perm = event.authorPermission;
  return perm !== undefined && COLLABORATOR_PERMISSIONS.includes(perm);
}

// inputs schema - action inputs from core.getInput()
// note: tool permissions use .or("undefined") because getInput() || undefined
// explicitly sets the property to undefined when empty, which is different from
// the property being absent. arktype's "prop?" means "optional to include" but
// if included, must match the type - so we need to explicitly allow undefined.
export const Inputs = type({
  prompt: "string",
  "model?": type.string.or("undefined"),
  "mode?": type.string.or("undefined"),
  "timeout?": type.string.or("undefined"),
  "push?": PushPermissionInput.or("undefined"),
  "shell?": ShellPermissionInput.or("undefined"),
  "cwd?": type.string.or("undefined"),
  "output_schema?": type.string.or("undefined"),
  // Terraform remediation config (all optional; defaults applied downstream)
  "scan_scope?": type.string.or("undefined"),
  "severity_threshold?": type.string.or("undefined"),
  "max_prs?": type.string.or("undefined"),
  "allowed_paths?": type.string.or("undefined"),
  "base_branch?": type.string.or("undefined"),
});

export type Inputs = typeof Inputs.infer;

function isPayloadEvent(value: unknown): value is PayloadEvent {
  return typeof value === "object" && value !== null && "trigger" in value;
}

function resolveCwd(cwd: string | undefined): string | undefined {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!cwd) return workspace;
  if (isAbsolute(cwd)) return cwd;
  return workspace ? resolve(workspace, cwd) : cwd;
}

export type ResolvedPromptInput = string | typeof JsonPayload.infer;

export function resolvePromptInput(): ResolvedPromptInput {
  const prompt = core.getInput("prompt", { required: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    // JSON parse error is fine (plain text prompt)
    return prompt;
  }

  if (!parsed || typeof parsed !== "object" || !("~terramend" in parsed)) {
    // if it doesn't look like a terramend payload, return the plain text prompt
    return prompt;
  }

  // validation errors should propagate
  const jsonPayload = JsonPayload.assert(parsed);
  validateCompatibility(jsonPayload.version, packageJson.version);
  return jsonPayload;
}

function resolveNonPromptInputs() {
  return Inputs.omit("prompt").assert({
    model: core.getInput("model") || undefined,
    mode: core.getInput("mode") || undefined,
    timeout: core.getInput("timeout") || undefined,
    cwd: core.getInput("cwd") || undefined,
    push: core.getInput("push") || undefined,
    shell: core.getInput("shell") || undefined,
    scan_scope: core.getInput("scan_scope") || undefined,
    severity_threshold: core.getInput("severity_threshold") || undefined,
    max_prs: core.getInput("max_prs") || undefined,
    allowed_paths: core.getInput("allowed_paths") || undefined,
    base_branch: core.getInput("base_branch") || undefined,
  });
}

/**
 * Canonicalize the `mode` input against the built-in mode names
 * (case-insensitive). Returns the canonical name (e.g. "remediate" →
 * "Remediate") when it matches a built-in mode, letting CI pin a mode
 * deterministically. Unknown non-empty values warn and return undefined so the
 * agent falls back to prompt-driven `select_mode` — mirroring how an unknown
 * `model` slug degrades to auto-select rather than hard-failing the run.
 */
export function parseMode(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  const match = BUILTIN_MODE_NAMES.find((name) => name.toLowerCase() === v.toLowerCase());
  if (!match) {
    log.warning(
      `» unknown mode "${v}" — agent will select a mode (valid: ${BUILTIN_MODE_NAMES.join(", ")})`
    );
    return undefined;
  }
  return match;
}

/** parse scan_scope; "diff" or "full" (default). */
function parseScanScope(raw: string | undefined): "diff" | "full" | undefined {
  const v = raw?.trim().toLowerCase();
  return v === "diff" || v === "full" ? v : undefined;
}

const SEVERITY_VALUES = new Set(["critical", "high", "medium", "low", "info"]);

/** parse the severity_threshold input; undefined when unset or not a valid level. */
function parseSeverityThreshold(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  return SEVERITY_VALUES.has(v) ? v : undefined;
}

/** parse max_prs; a positive integer, else undefined (downstream default is 1). */
function parseMaxPrs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** parse the comma-separated allowed_paths glob list; undefined when unset. */
function parseAllowedPaths(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const globs = raw
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  return globs.length > 0 ? globs : undefined;
}

/** parse the base_branch override; trims and strips a leading `refs/heads/`,
 * undefined when unset (downstream resolves the run-start branch / default). */
export function parseBaseBranch(raw: string | undefined): string | undefined {
  const v = raw?.trim().replace(/^refs\/heads\//, "");
  return v || undefined;
}

const isTerramend = (actor: string | null | undefined): boolean => {
  actor = actor?.replace("[bot]", "");
  return !!actor && (actor === "terramend" || actor === "terramenddev");
};

export function resolvePayload(
  resolvedPromptInput: ResolvedPromptInput,
  repoSettings: RepoSettings
) {
  const [prompt, jsonPayload] =
    typeof resolvedPromptInput !== "string"
      ? [resolvedPromptInput.prompt, resolvedPromptInput]
      : [resolvedPromptInput, undefined];

  const inputs = resolveNonPromptInputs();

  // resolve event - use type guard for jsonPayload.event, fallback to unknown trigger
  const rawEvent = jsonPayload?.event;
  const event: PayloadEvent = isPayloadEvent(rawEvent) ? rawEvent : { trigger: "unknown" };

  const model = jsonPayload?.model ?? inputs.model ?? repoSettings.model ?? undefined;

  // determine shell permission - strictest setting wins
  // precedence: disabled > restricted > enabled
  // non-collaborators always get at least "restricted"
  const isNonCollaborator = !isCollaborator(event);
  const repoShell = repoSettings.shell ?? "restricted";
  const inputShell = inputs.shell;

  // resolve shell: start with repo setting, then apply restrictions
  let resolvedShell = repoShell;

  // input can only make it stricter (disabled > restricted > enabled)
  if (inputShell === "disabled") {
    resolvedShell = "disabled";
  } else if (inputShell === "restricted" && resolvedShell === "enabled") {
    resolvedShell = "restricted";
  }

  // non-collaborators get at least "restricted" (can't have "enabled")
  if (isNonCollaborator && resolvedShell === "enabled") {
    resolvedShell = "restricted";
  }

  // build payload - precedence: inputs > repoSettings > fallbacks
  // note: modes are NOT in payload - they come from repoSettings in main()
  return {
    "~terramend": true as const,
    version: jsonPayload?.version ?? packageJson.version,
    model,
    // deterministic mode pin for CI (action input only — not accepted from the
    // JSON payload, which is the internal dispatch surface). undefined → the
    // agent chooses via select_mode as before.
    mode: parseMode(inputs.mode),
    prompt,
    triggerer:
      jsonPayload?.triggerer ??
      // it's not a common use case but GITHUB_ACTOR can be a user when the workflow is manually triggered by a user through GitHub Actions UI
      (!isTerramend(process.env.GITHUB_ACTOR) ? process.env.GITHUB_ACTOR : undefined),
    eventInstructions: jsonPayload?.eventInstructions,
    previousRunsNote: jsonPayload?.previousRunsNote,
    event,
    timeout: inputs.timeout ?? jsonPayload?.timeout,
    cwd: resolveCwd(inputs.cwd),
    progressComment: jsonPayload?.progressComment,
    generateSummary: jsonPayload?.generateSummary,

    // permissions: inputs > repoSettings > fallbacks
    push: inputs.push ?? repoSettings.push ?? "restricted",
    shell: resolvedShell,

    // Terraform remediation config — consumed by mcp/terraform.ts + the
    // Remediate mode. Defaults are applied at the consumer, not here, so
    // "unset" stays distinguishable from an explicit value.
    scanScope: parseScanScope(inputs.scan_scope),
    severityThreshold: parseSeverityThreshold(inputs.severity_threshold),
    maxPrs: parseMaxPrs(inputs.max_prs),
    allowedPaths: parseAllowedPaths(inputs.allowed_paths),
    // explicit base-branch override; when unset the effective base is resolved
    // at PR time (run-start branch → repo default) — see resolveBaseBranch.
    baseBranch: parseBaseBranch(inputs.base_branch),
  };
}

export type ResolvedPayload = ReturnType<typeof resolvePayload>;

/**
 * Parse and validate the optional `output_schema` action input. Returns the
 * parsed object when present, or `undefined` when absent. Throws on invalid
 * JSON or non-object payloads — these are workflow-author errors that should
 * surface immediately, not silently degrade to "no schema".
 */
export function resolveOutputSchema(): Record<string, unknown> | undefined {
  const raw = core.getInput("output_schema");
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid output_schema: not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid output_schema: must be a JSON object`);
  }
  log.info("» structured output schema provided — output will be required");
  return parsed as Record<string, unknown>;
}
