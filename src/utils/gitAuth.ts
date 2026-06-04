/**
 * git authentication via GIT_ASKPASS.
 *
 * a localhost HTTP server serves tokens via UUID codes whose lifetime is
 * bounded by the parent $git() invocation: register() makes the code active,
 * the script (and any sibling subprocess — e.g. git-lfs pre-push) can fetch
 * the token any number of times, and $git()'s finally calls revoke() to
 * close the window. each $git() call writes a unique askpass script with
 * the server port+code baked into the file body — no secrets in subprocess
 * env. a replay of a revoked code trips a 409 and revokes the underlying
 * github installation token.
 *
 * see wiki/askpass.md for full security documentation.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { log } from "./cli.ts";
import type { GitAuthServer } from "./gitAuthServer.ts";
import { filterEnv } from "./secrets.ts";
import { $ } from "./shell.ts";
import { spawn } from "./subprocess.ts";

type SafeGitSubcommand = "fetch" | "push";

type GitAuthOptions = {
  token: string;
  cwd?: string;
};

type GitResult = {
  stdout: string;
  stderr: string;
};

// --- git binary resolution and tamper detection ---

type GitBinaryInfo = {
  path: string;
  sha256: string;
};

let gitBinary: GitBinaryInfo | undefined;

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * resolve and fingerprint the git binary. must be called once at startup
 * (in main()) before any agent code runs, so the path and hash reflect
 * the untampered binary.
 *
 * resolves symlinks via realpath so the hash is of the actual binary.
 * a malicious agent with sudo could replace the binary later, which is
 * caught by verifyGitBinary() before each authenticated call.
 */
export function resolveGit(): void {
  const whichPath = execSync("which git", { encoding: "utf-8" }).trim();
  const resolvedPath = realpathSync(whichPath);
  const sha256 = hashFile(resolvedPath);
  gitBinary = { path: resolvedPath, sha256 };
  log.debug(`» git binary: ${resolvedPath} (sha256: ${sha256.slice(0, 12)}...)`);
}

function verifyGitBinary(): string {
  if (!gitBinary) {
    throw new Error("git binary not initialized — call resolveGit() at startup");
  }
  const currentHash = hashFile(gitBinary.path);
  if (currentHash !== gitBinary.sha256) {
    throw new Error(
      `git binary tampered: expected sha256 ${gitBinary.sha256}, got ${currentHash}. ` +
        `path: ${gitBinary.path}`
    );
  }
  return gitBinary.path;
}

// --- auth server ---

let authServer: GitAuthServer | undefined;

export function setGitAuthServer(server: GitAuthServer): void {
  authServer = server;
}

/**
 * execute authenticated git command via ASKPASS.
 *
 * subcommand is restricted to "fetch" | "push" — operations that talk to
 * a remote and need credentials. working-tree operations (checkout, merge)
 * use $() from shell.ts which has no token.
 *
 * per call: registers a code with the auth server (valid for the lifetime
 * of this invocation), writes a unique askpass script with port+code baked
 * in, spawns git with GIT_ASKPASS pointing to the script. on completion,
 * revokes the code and deletes the script in finally. multiple sibling
 * askpass calls within one invocation (e.g. git itself + git-lfs pre-push)
 * all see a valid code; replay attempts after finally trip a 409 and the
 * server revokes the underlying github token as a tamper signal.
 *
 * @example
 * await $git("fetch", ["origin", "main"], { token });
 * await $git("push", ["-u", "origin", "feature"], { token });
 */
export async function $git(
  subcommand: SafeGitSubcommand,
  args: string[],
  options: GitAuthOptions
): Promise<GitResult> {
  const gitPath = verifyGitBinary();

  if (!authServer) {
    throw new Error("git auth server not initialized — call setGitAuthServer() at startup");
  }

  const cwd = options.cwd ?? process.cwd();

  const code = authServer.register(options.token);
  const scriptPath = authServer.writeAskpassScript(code);

  // -c flags override local .git/config — defense-in-depth against
  // agent-set config that could spawn subprocesses before ASKPASS runs
  const fullArgs = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "core.sshCommand=ssh",
    subcommand,
    ...args,
  ];

  log.debug(`git ${fullArgs.join(" ")}`);

  try {
    const result = await spawn({
      cmd: gitPath,
      args: fullArgs,
      cwd,
      env: {
        ...filterEnv(),
        GIT_ASKPASS: scriptPath,
        GIT_TERMINAL_PROMPT: "0",
        // blocks env-based git config injection from outer processes.
        // GIT_CONFIG_COUNT=0 blocks the newer KEY_n/VALUE_n mechanism.
        // GIT_CONFIG_PARAMETERS="" clears the legacy quoted-list mechanism.
        // both are needed — they are independent systems.
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
      },
      activityTimeout: 0,
    });

    if (result.stderr.includes("askpass-compromised")) {
      log.info("askpass code was replayed after revoke — token has been revoked");
      throw new Error("git auth failed — askpass code was replayed after revoke, token revoked");
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      // stderr is the primary channel for git diagnostics, but in rare cases
      // (e.g. some HTTPS smart-protocol failures) the only useful detail is
      // on stdout — without it the agent / operator sees an empty error.
      // include exit code so we can distinguish e.g. signal-killed (1 with
      // empty output) from a genuine git-level rejection.
      const detail =
        stderr && stdout
          ? `${stderr}\n--- stdout ---\n${stdout}`
          : stderr || stdout || "(no output)";
      const message = `git ${subcommand} failed (exit ${result.exitCode}): ${detail}`;
      log.info(message);
      throw new Error(message);
    }

    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } finally {
    authServer.revoke(code);
    try {
      unlinkSync(scriptPath);
    } catch {
      // script may already be gone (e.g. tmpdir cleanup raced us)
    }
  }
}

/**
 * shallow-clone unreachable: when an existing local depth is too shallow for
 * git to traverse to the requested ref's ancestry, the remote walk fails with
 * one of these wordings (git emits the full OID via oid_to_hex, so the bound
 * is 40 for SHA-1 or 64 for SHA-256). detecting both lets a single deepen
 * retry recover before the error reaches the agent — see issue #564 for the
 * original `git_fetch` precedent and #656 for the `checkout_pr` follow-up.
 */
export const SHALLOW_UNREACHABLE_PATTERNS: RegExp[] = [
  /Could not read [a-f0-9]{40,64}/,
  /remote did not send all necessary objects/,
];

/**
 * large enough to clear the merge base on most real-world PRs without
 * downloading the full history; matches the fallback used by
 * `checkoutPrBranch` when the GitHub compare API is unavailable.
 */
export const DEEPEN_RETRY_DEPTH = 1000;

/**
 * authenticated `git fetch` that recovers from shallow-unreachable errors
 * by retrying once with `--deepen=1000`. callers pass the same args they
 * would to `$git("fetch", ...)`; on shallow-unreachable failures in a
 * shallow repo, the second attempt prepends `--deepen=N` and strips any
 * caller-supplied `--depth=` (the two flags are mutually exclusive, and
 * the caller's depth is what got us into this mess).
 *
 * non-shallow-unreachable errors and non-shallow repos rethrow unchanged,
 * so this is safe to wrap any fetch without changing fast-path behavior.
 */
export async function $gitFetchWithDeepen(
  args: string[],
  options: GitAuthOptions,
  label?: string
): Promise<GitResult> {
  try {
    return await $git("fetch", args, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isShallowUnreachable = SHALLOW_UNREACHABLE_PATTERNS.some((p) => p.test(msg));
    if (!isShallowUnreachable) throw err;
    const isShallow =
      $("git", ["rev-parse", "--is-shallow-repository"], { log: false }).trim() === "true";
    if (!isShallow) throw err;
    log.info(
      `» ${label ?? "git fetch"} hit shallow-unreachable error, retrying with --deepen=${DEEPEN_RETRY_DEPTH}`
    );
    const retryArgs = args.filter((a) => !a.startsWith("--depth="));
    return await $git("fetch", [`--deepen=${DEEPEN_RETRY_DEPTH}`, ...retryArgs], options);
  }
}
