import * as core from "@actions/core";
import type { Octokit } from "@octokit/rest";
import { log } from "#app/utils/cli";
import { type OctokitWithPlugins, parseRepoContext } from "#app/utils/github";
import { type AccountPlan, fetchRunContext, type RepoSettings } from "#app/utils/runContext";
import packageJson from "#package.json" with { type: "json" };

export interface RunContextData {
  repo: {
    owner: string;
    name: string;
    data: Awaited<ReturnType<Octokit["repos"]["get"]>>["data"];
  };
  repoSettings: RepoSettings;
  apiToken: string;
  oss: boolean;
  plan: AccountPlan;
}

interface ResolveRunContextDataParams {
  octokit: OctokitWithPlugins;
  token: string;
}

/**
 * initialize run context data: parse context, fetch repo info and settings
 */
export async function resolveRunContextData(
  params: ResolveRunContextDataParams,
): Promise<RunContextData> {
  log.info(`» running Terramend v${packageJson.version}...`);

  const repoContext = parseRepoContext();

  let oidcToken: string | undefined;
  try {
    oidcToken = await core.getIDToken("terramend-api");
  } catch {
    // OIDC not available (local dev, non-actions environment, fork PRs)
  }

  const [repoResponse, runContext] = await Promise.all([
    params.octokit.repos.get({ owner: repoContext.owner, repo: repoContext.name }),
    fetchRunContext({ token: params.token, repoContext, oidcToken }),
  ]);

  return {
    repo: {
      owner: repoContext.owner,
      name: repoContext.name,
      data: repoResponse.data,
    },
    repoSettings: runContext.settings,
    apiToken: runContext.apiToken,
    oss: runContext.oss,
    plan: runContext.plan,
  };
}
