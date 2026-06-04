import type { OctokitWithPlugins } from "#app/utils/github";

interface ResolveRunParams {
  octokit: OctokitWithPlugins;
}

export interface ResolveRunResult {
  runId: number | undefined;
}

/**
 * Resolve GitHub Actions workflow run context.
 * Uses GITHUB_REPOSITORY and GITHUB_RUN_ID env vars.
 */
export async function resolveRun(_params: ResolveRunParams): Promise<ResolveRunResult> {
  const runId = process.env.GITHUB_RUN_ID
    ? Number.parseInt(process.env.GITHUB_RUN_ID, 10)
    : undefined;
  const githubRepo = process.env.GITHUB_REPOSITORY;
  if (!githubRepo || !githubRepo.includes("/")) {
    throw new Error(`GITHUB_REPOSITORY env var must be set to "owner/repo", got: ${githubRepo}`);
  }

  return { runId };
}
