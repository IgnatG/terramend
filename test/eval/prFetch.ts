/**
 * Fetch a GitHub PR's head tree into a local worktree so the detection eval
 * (`run.ts`) can scan real PRs, not just committed fixtures. Mirrors
 * claude-code-security-review's eval_engine repo handling: one cached
 * blob-less clone per repo, one disposable worktree per PR fetch.
 *
 * Clones land under `.temp/eval/` (already gitignored via `.temp/`). The
 * worktree is recreated on every call so a re-run always evaluates the PR's
 * current head, not a stale fetch.
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** Parse `owner/repo#123`. Returns null on any malformed input. */
export function parsePrRef(raw: string): PrRef | null {
  const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const number = Number.parseInt(match[3] as string, 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { owner: match[1] as string, repo: match[2] as string, number };
}

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${r.status}): ${r.stderr.trim()}`);
  }
}

/**
 * Ensure `pr`'s head is checked out in a worktree and return its path.
 * Uses ambient git credentials (public repos need none; private repos need
 * a configured credential helper, e.g. `gh auth setup-git`).
 */
export function fetchPrHead(pr: PrRef, evalTempDir: string): string {
  const cloneDir = join(evalTempDir, `${pr.owner}-${pr.repo}`);
  const worktreeDir = join(evalTempDir, `${pr.owner}-${pr.repo}-pr${pr.number}`);

  if (!existsSync(cloneDir)) {
    git(
      [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        `https://github.com/${pr.owner}/${pr.repo}.git`,
        cloneDir,
      ],
      evalTempDir,
    );
  }

  // refresh: drop any previous worktree for this PR so the scan always sees
  // the current head, then fetch and re-create.
  if (existsSync(worktreeDir)) {
    try {
      git(["worktree", "remove", "--force", worktreeDir], cloneDir);
    } catch {
      // a half-removed worktree (e.g. interrupted prior run) — fall through
      // to rmSync + prune.
    }
    rmSync(worktreeDir, { recursive: true, force: true });
    git(["worktree", "prune"], cloneDir);
  }

  git(["fetch", "--no-tags", "origin", `pull/${pr.number}/head`], cloneDir);
  git(["worktree", "add", "--detach", worktreeDir, "FETCH_HEAD"], cloneDir);
  return worktreeDir;
}
