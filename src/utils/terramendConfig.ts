/**
 * Repo-committed `.terramend.yml` config (the §1.5 follow-up to the unified
 * `tools_enabled` input). A thin layer that sits **under** the action inputs: an
 * explicit workflow input always wins; the file only fills the gaps. It versions
 * the toolchain + scoping policy *with the code* (and doubles as the auditable
 * record of which non-permissive tools the repo owner opted into), so the
 * workflow file can stay minimal and the policy lives next to the Terraform.
 *
 * Scope is deliberate — only repo-level **policy** knobs live here. Each maps
 * 1:1 to the matching action input and flows through the SAME parser, so the file
 * and the input validate identically. Secrets (`module_fetch_token`) and
 * per-run/workflow knobs (`mode`, `max_prs`, `base_branch`, `allow_replace`) are
 * intentionally NOT read from the file: a committed file is the wrong place for a
 * credential, and the run's shape belongs to the workflow that dispatches it.
 *
 * Trust boundary: `.terramend.yml` is controlled by whoever can push to the repo
 * — the same surface as the Terraform being remediated. It can only RELAX within
 * the licence gate's structure (naming a non-permissive tool is the repo owner's
 * licence acknowledgement, exactly as on the input) and it can never disable the
 * required substrate. A workflow author who needs to *enforce* a policy sets the
 * action input, which wins over the file.
 *
 * Degrade-green: a missing file is silent; malformed YAML, a non-mapping
 * document, an unknown key, or a value of the wrong shape yields a warning and is
 * ignored — never a hard failure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { log } from "#app/utils/cli";

/** filenames checked, in order; the first that exists wins. */
export const TERRAMEND_CONFIG_FILENAMES = [".terramend.yml", ".terramend.yaml"] as const;

/** the repo-level keys `.terramend.yml` may set. Each is the snake_case name of
 * the matching action input, so the file value can be fed straight through the
 * input's own parser in `resolvePayload`. */
export const TERRAMEND_CONFIG_KEYS = [
  "tools_enabled",
  "protected_paths",
  "allowed_paths",
  "scan_scope",
  "severity_threshold",
  "autonomy_threshold",
  "module_catalogue",
] as const;

export type TerramendConfigKey = (typeof TERRAMEND_CONFIG_KEYS)[number];

/** normalized string values (lists newline-joined), keyed by input name. */
export type TerramendFileValues = Partial<Record<TerramendConfigKey, string>>;

export interface ParsedTerramendConfig {
  values: TerramendFileValues;
  /** non-fatal problems (malformed value, unknown key) for the caller to log. */
  warnings: string[];
}

const KEY_SET: ReadonlySet<string> = new Set(TERRAMEND_CONFIG_KEYS);

/**
 * Normalize a YAML value to the string shape the action-input parsers expect:
 * a scalar → its trimmed string; a list → newline-joined (the tool-selection,
 * glob, and module-catalogue parsers all split on newlines *or* commas). Returns
 * null for an unusable value (a mapping, an empty/blank string, null) so the
 * caller can warn and skip it.
 */
function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value
      .filter((v) => v !== null && v !== undefined && typeof v !== "object")
      .map((v) => String(v).trim())
      .filter(Boolean);
    return items.length > 0 ? items.join("\n") : null;
  }
  return null; // a nested mapping isn't a valid value for any of these keys.
}

/**
 * Parse raw `.terramend.yml` text into normalized string values + warnings.
 * Pure — no I/O, no logging — so the parsing/validation is unit-testable.
 */
export function parseTerramendConfig(raw: string): ParsedTerramendConfig {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { values: {}, warnings: [`.terramend.yml is not valid YAML — ignored (${detail})`] };
  }
  // an empty file / only comments parses to null|undefined — a valid no-op.
  if (doc === null || doc === undefined) return { values: {}, warnings: [] };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return {
      values: {},
      warnings: [".terramend.yml must be a YAML mapping (key: value) — ignored"],
    };
  }

  const values: TerramendFileValues = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (!KEY_SET.has(key)) {
      warnings.push(`.terramend.yml: ignoring unrecognised key "${key}"`);
      continue;
    }
    const normalized = normalizeValue(value);
    if (normalized === null) {
      warnings.push(`.terramend.yml: ignoring "${key}" — expected a string or a list of strings`);
      continue;
    }
    values[key as TerramendConfigKey] = normalized;
  }
  return { values, warnings };
}

/**
 * Read + parse the repo's `.terramend.yml` (first of the supported filenames
 * found under `cwd`). Returns the normalized values, logging any warnings. A
 * missing file resolves to `{}` silently — the common, valid case.
 */
export function loadTerramendConfig(cwd: string | undefined): TerramendFileValues {
  const root = cwd ?? process.cwd();
  for (const name of TERRAMEND_CONFIG_FILENAMES) {
    let raw: string;
    try {
      raw = readFileSync(join(root, name), "utf-8");
    } catch {
      continue; // not this filename — try the next, or fall through to {}.
    }
    const { values, warnings } = parseTerramendConfig(raw);
    for (const w of warnings) log.warning(`» ${w}`);
    if (Object.keys(values).length > 0) {
      log.info(`» loaded ${name} (${Object.keys(values).join(", ")})`);
    }
    return values;
  }
  return {};
}
