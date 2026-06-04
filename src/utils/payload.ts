import { isAbsolute, resolve } from "node:path";
import * as core from "@actions/core";
import { type } from "arktype";
import type { AuthorPermission, PayloadEvent } from "../external.ts";
import packageJson from "../../package.json" with { type: "json" };
import { log } from "./cli.ts";
import type { RepoSettings } from "./runContext.ts";
import { validateCompatibility } from "./versioning.ts";

// tool permission enum types for inputs
const ShellPermissionInput = type.enumerated("disabled", "restricted", "enabled");
const PushPermissionInput = type.enumerated("disabled", "restricted", "enabled");

// schema for JSON payload passed via prompt (internal dispatch invocation)
// note: permissions are intentionally NOT included here to prevent injection attacks
// permissions are derived from event.authorPermission instead
export const JsonPayload = type({
  "~lintel": "true",
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

  if (!parsed || typeof parsed !== "object" || !("~lintel" in parsed)) {
    // if it doesn't look like a lintel payload, return the plain text prompt
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
    timeout: core.getInput("timeout") || undefined,
    cwd: core.getInput("cwd") || undefined,
    push: core.getInput("push") || undefined,
    shell: core.getInput("shell") || undefined,
    scan_scope: core.getInput("scan_scope") || undefined,
    severity_threshold: core.getInput("severity_threshold") || undefined,
    max_prs: core.getInput("max_prs") || undefined,
    allowed_paths: core.getInput("allowed_paths") || undefined,
  });
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

const isLintel = (actor: string | null | undefined): boolean => {
  actor = actor?.replace("[bot]", "");
  return !!actor && (actor === "lintel" || actor === "linteldev");
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
    "~lintel": true as const,
    version: jsonPayload?.version ?? packageJson.version,
    model,
    prompt,
    triggerer:
      jsonPayload?.triggerer ??
      // it's not a common use case but GITHUB_ACTOR can be a user when the workflow is manually triggered by a user through GitHub Actions UI
      (!isLintel(process.env.GITHUB_ACTOR) ? process.env.GITHUB_ACTOR : undefined),
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

    // set by proxy logic in main.ts when routing through OpenRouter
    proxyModel: undefined as string | undefined,
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
