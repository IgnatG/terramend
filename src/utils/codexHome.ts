// Codex-to-OpenCode auth bridging for the action runtime.
//
// `CODEX_AUTH_JSON` (a Codex CLI `auth.json` blob) is read from the environment
// — supplied directly as a GitHub Actions secret or workflow `env:` value. The
// hosted per-org secret store + `dbSecrets` delivery + server-side rotation
// (`maybeRotateCodexSecret`) were removed with the rest of the managed backend,
// so the standalone fork reads the env value verbatim.
//
// Caveat (GH Actions secrets are immutable at runtime): the OAuth refresh chain
// rotates on use, so a token stashed as a static secret expires on its first
// refresh (~1h). Codex auth is therefore best for short runs; longer runs rely
// on OpenCode's in-process CodexAuthPlugin to refresh mid-run. `entryPost.ts`
// still detects a mid-run rotation, but its hosted write-back is now a no-op
// without a backend to persist to. See wiki/codex-auth.md.
//
// This utility then:
//   1. parses + validates the env value
//   2. decodes the access_token JWT's `exp` claim so opencode knows how
//      long to trust the token before its CodexAuthPlugin attempts its
//      own mid-run refresh
//   3. converts Codex's shape `{ auth_mode, tokens: { access_token,
//      refresh_token, id_token?, account_id? } }` into OpenCode's shape
//      `{ openai: { type: "oauth", refresh, access, expires, accountId } }`
//   4. materializes it to disk under a path the MCP-shell mount-namespace
//      sandbox can hide from bash: `/var/lib/terramend/opencode/auth.json` in
//      CI (sudo-bootstrapped, fail-closed if sudo unavailable),
//      `$HOME/.local/share/opencode/auth.json` locally (sandbox is no-op
//      locally so the path is irrelevant to security)
//   5. returns the path + the original refresh token so the post-run hook
//      can detect a mid-run rotation and write back to Terramend
//
// Why `/var/lib/terramend/` and not `$HOME` in CI: bash via MCP runs inside a
// mount namespace that overlays tmpfs on `/var/lib/terramend/` (see FS_MOUNTS
// in action/mcp/shell.ts), so bash sees an empty dir while opencode's
// internal auth module — which runs in the agent process outside that
// namespace — reads/writes the real file. `$HOME` can't be tmpfs-overlaid
// without breaking the agent's legitimate need to access ~/.npm, ~/.cache,
// etc.
//
// See [wiki/codex-auth.md] for the full data-flow picture.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { log } from "#app/utils/cli";
import { decodeJwtExpMs, parseCodexAuthBody } from "#app/utils/codexOAuth";

const CODEX_AUTH_ENV = "CODEX_AUTH_JSON";

/** sandbox-hidden home for terramend-managed on-disk secrets in CI. bash via
 * MCP shell tmpfs-overlays this path; opencode's internal auth module
 * bypasses external_directory and reaches the real file. mirrors the
 * pattern in action/agents/claude.ts installManagedSettings.
 *
 * not used for codex auth in local dev — the sandbox is no-op there, so
 * the path doesn't matter. local dev keeps the existing $HOME path. */
export const TERRAMEND_DATA_DIR = "/var/lib/terramend";

interface OpenCodeAuthFile {
  openai: {
    type: "oauth";
    refresh: string;
    access: string;
    expires: number;
    accountId?: string;
  };
}

export interface InstalledCodexAuth {
  /** absolute path of the auth.json we wrote — caller passes this to the
   * post-hook via core.saveState for refresh-detection later. */
  authPath: string;
  /** value to set as XDG_DATA_HOME for the OpenCode subprocess. */
  xdgDataHome: string;
  /** refresh_token from the env at materialization time. post-hook
   * compares against the on-disk file after the run to detect whether
   * OpenCode refreshed during the session (only happens on long runs
   * that span >50min — see wiki/codex-auth.md "Concurrency"). */
  originalRefresh: string;
}

/** materialize CODEX_AUTH_JSON from env into a disk path OpenCode reads from.
 * returns null when the env var is absent, malformed, or wrong auth mode —
 * caller treats null as "no codex auth, fall through to API key flow".
 *
 * The env value is read as-is — we only parse + write it here, no refresh and
 * no DB interaction. Freshness is the supplier's responsibility (see the
 * header caveat on static-secret expiry). */
export function installCodexAuth(): InstalledCodexAuth | null {
  const raw = process.env[CODEX_AUTH_ENV];
  if (!raw) return null;

  const body = parseCodexAuthBody(raw);
  if (!body) {
    log.warning(`» ${CODEX_AUTH_ENV} present but malformed; ignoring`);
    return null;
  }

  // decode the access_token's JWT exp so opencode trusts the token until
  // its real expiry (no need to refresh on first request). null exp ->
  // fall back to "expires: 0" so opencode refreshes immediately on first
  // request (the old behavior).
  const expiresMs = decodeJwtExpMs(body.tokens.access_token) ?? 0;

  const xdgDataHome = resolveDataHome();
  const opencodeDir = join(xdgDataHome, "opencode");
  const authPath = join(opencodeDir, "auth.json");

  const opencodeAuth: OpenCodeAuthFile = {
    openai: {
      type: "oauth",
      refresh: body.tokens.refresh_token,
      access: body.tokens.access_token,
      expires: expiresMs,
      ...(body.tokens.account_id ? { accountId: body.tokens.account_id } : {}),
    },
  };

  mkdirSync(opencodeDir, { recursive: true });
  writeFileSync(authPath, `${JSON.stringify(opencodeAuth, null, 2)}\n`, { mode: 0o600 });

  log.info(`» installed Codex auth at ${authPath}`);

  return {
    authPath,
    xdgDataHome,
    originalRefresh: body.tokens.refresh_token,
  };
}

/** pick the XDG_DATA_HOME for codex auth.
 *
 * - **local dev (CI != true)**: use $HOME. mount-namespace sandbox is no-op
 *   locally so the file isn't protected from bash either way; codex auth on
 *   a developer's machine is the developer's responsibility.
 * - **CI**: bootstrap /var/lib/terramend via sudo. MCP shell's mount namespace
 *   tmpfs-overlays this path, and claude managed-settings + opencode
 *   external_directory both deny it — three independent layers.
 *
 * **fail closed in CI** when the sudo bootstrap fails. falling back to
 * $HOME silently strips two of the three protection layers — the wiki
 * claims three layers; degrading to one without a hard error contradicts
 * that claim and is exactly the kind of silent security regression the
 * reviewer should never have to catch. operators on locked-down runners
 * that can't passwordless-sudo should re-provision sudo or remove
 * `CODEX_AUTH_JSON` from the run entirely. */
function resolveDataHome(): string {
  if (process.env.CI !== "true") return join(homedir(), ".local", "share");
  bootstrapTerramendDataDir();
  return TERRAMEND_DATA_DIR;
}

function bootstrapTerramendDataDir(): void {
  const user = userInfo().username;
  // `id -gn $user` resolves the user's primary group name correctly even on
  // self-hosted images where the group isn't `<user>:<user>` (e.g., `runner`
  // belongs to `runner`, but a self-hosted setup might use `users`, `docker`,
  // or a project-specific gid). avoids the brittle "group has same name as
  // user" assumption.
  let primaryGroup: string;
  try {
    primaryGroup = execFileSync("id", ["-gn", user], { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    primaryGroup = user;
  }
  // `-n` (non-interactive) makes sudo fail-fast on locked-down runners
  // instead of prompting and timing out.
  try {
    execFileSync("sudo", ["-n", "mkdir", "-p", TERRAMEND_DATA_DIR], { stdio: "pipe" });
    execFileSync("sudo", ["-n", "chown", `${user}:${primaryGroup}`, TERRAMEND_DATA_DIR], {
      stdio: "pipe",
    });
    execFileSync("sudo", ["-n", "chmod", "700", TERRAMEND_DATA_DIR], { stdio: "pipe" });
  } catch (err) {
    throw new Error(
      `failed to bootstrap ${TERRAMEND_DATA_DIR} (required for codex auth in CI): ${err instanceof Error ? err.message : String(err)}. ` +
        `the MCP shell's mount-namespace sandbox cannot protect the auth file when it lives under $HOME, ` +
        `and silently falling back would contradict the "three independent layers" claim in wiki/codex-auth.md. ` +
        `passwordless sudo is required for codex auth on this runner — either configure it, or remove ` +
        `CODEX_AUTH_JSON from the run.`
    );
  }
}
