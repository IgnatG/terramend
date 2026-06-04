// OpenCode-as-source-of-truth for BYOK detection.
//
// `opencode models` returns the `provider/model` specifiers that OpenCode
// can actually route given the current env (workflow env block + GH Actions
// secrets) and `auth.json` (Codex / future managed credentials). This is
// authoritative — strictly more accurate than the static
// `provider.envVars + provider.managedCredentials` catalog in `models.ts`
// for the "do we have BYOK auth?" gate. The catalog can (and will) miss
// new auth shapes; OpenCode itself can't.
//
// Two captures per run:
//   1. `captureBaselineModels` — called BEFORE Codex `auth.json` is
//      materialized. The set OpenCode can serve from the runner's pre-existing
//      environment alone (workflow `env:` block + GH Actions secrets).
//   2. `captureAuthorizedModels` — called AFTER Codex `auth.json`
//      materialization. The authoritative set for BYOK decisions (fallback +
//      validateAgentApiKey).
//
// The set difference (`authorized - baseline`) is the contribution of the
// Codex OAuth credential to this run — logged once for operator visibility.
//
// Memoized at module scope so the two consumers
// (`selectFallbackModelIfNeeded` + `autoSelectModel`) share one shell-out.

import { execFileSync } from "node:child_process";
import { log } from "#app/utils/cli";

let baseline: Set<string> | undefined;
let authorized: Set<string> | undefined;

function readModels(cliPath: string): Set<string> {
  try {
    const output = execFileSync(cliPath, ["models"], {
      encoding: "utf-8",
      timeout: 30_000,
      env: process.env,
    });
    return new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    );
  } catch (error) {
    log.debug(
      `» \`opencode models\` failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return new Set();
  }
}

/** Snapshot the set of models OpenCode can serve from the current env, BEFORE
 * Terramend-stored credentials are merged in. Call once early in `main.ts`. */
export function captureBaselineModels(cliPath: string): void {
  baseline = readModels(cliPath);
  log.debug(`» opencode baseline: ${baseline.size} models`);
}

/** Snapshot the set of models OpenCode can serve AFTER dbSecrets +
 * Codex auth.json are in place. Logs the diff against the baseline as
 * `» BYOK auth enabled N model(s): …`. */
export function captureAuthorizedModels(cliPath: string): void {
  authorized = readModels(cliPath);
  const base = baseline;
  if (base) {
    const diff = [...authorized].filter((m) => !base.has(m));
    if (diff.length > 0) {
      log.info(`» BYOK auth enabled ${diff.length} model(s): ${diff.join(", ")}`);
    }
  }
  log.debug(`» opencode authorized: ${authorized.size} models`);
}

/** Authorized set captured after Terramend-stored auth is applied. Throws if
 * called before `captureAuthorizedModels` — the call sites (fallback gate,
 * api-key validation, auto-select) all run strictly after capture. */
export function getAuthorizedModels(): Set<string> {
  if (!authorized) {
    throw new Error("getAuthorizedModels called before captureAuthorizedModels");
  }
  return authorized;
}
