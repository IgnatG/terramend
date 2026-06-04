import * as core from "@actions/core";
import type { Octokit } from "@octokit/rest";
import packageJson from "../../package.json" with { type: "json" };
import { log } from "./cli.ts";
import { type OctokitWithPlugins, parseRepoContext } from "./github.ts";
import { type AccountPlan, fetchRunContext, type RepoSettings } from "./runContext.ts";

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
  proxyModel?: string | undefined;
  dbSecrets?: Record<string, string> | undefined;
}

interface ResolveRunContextDataParams {
  octokit: OctokitWithPlugins;
  token: string;
}

/**
 * initialize run context data: parse context, fetch repo info and settings
 */
export async function resolveRunContextData(
  params: ResolveRunContextDataParams
): Promise<RunContextData> {
  log.info(`» running Lintel v${packageJson.version}...`);

  const repoContext = parseRepoContext();

  let oidcToken: string | undefined;
  try {
    oidcToken = await core.getIDToken("lintel-api");
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
    proxyModel: runContext.proxyModel,
    dbSecrets: runContext.dbSecrets,
  };
}
