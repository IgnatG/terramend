// shared helpers used by `init` and `auth` subcommands. these were originally
// inlined in `init.ts`; pulled out so `auth.ts` can reuse them without
// duplicating gh-auth/lintel-api/secret-save logic.

import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";

export const LINTEL_API_URL = (process.env.LINTEL_API_URL || "https://lintel.com").replace(
  /\/+$/,
  ""
);

// active spinner reference so bail/cancel can stop it before exiting. shared
// across init/auth subcommands via this module's singleton scope; whichever
// command starts a spinner sets this so handleCancel/bail can clean up.
let activeSpin: ReturnType<typeof p.spinner> | null = null;

export function setActiveSpin(spin: ReturnType<typeof p.spinner> | null): void {
  activeSpin = spin;
}

export function bail(msg: string): never {
  if (activeSpin) {
    activeSpin.stop(pc.red("failed"));
    activeSpin = null;
  }
  p.cancel(msg);
  process.exit(1);
}

export function handleCancel<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    if (activeSpin) {
      activeSpin.stop(pc.red("canceled."));
      activeSpin = null;
    }
    p.cancel("canceled.");
    process.exit(0);
  }
}

export function getGhToken(): string {
  let token: string;
  try {
    token = execFileSync("gh", ["auth", "token"], { encoding: "utf-8" }).trim();
  } catch {
    bail(
      `gh cli not found or not authenticated.\n` +
        `  ${pc.dim("install:")} https://cli.github.com\n` +
        `  ${pc.dim("then:")}    gh auth login`
    );
  }
  if (!token) {
    bail(
      `gh cli returned an empty token. try re-authenticating:\n` +
        `  ${pc.dim("run:")} gh auth login`
    );
  }
  return token;
}

export function parseGitRemote(): { owner: string; repo: string } {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" }).trim();
  } catch {
    bail("not a git repository or no 'origin' remote found.");
  }

  const match = url.match(/github\.com(?::\d+)?[:/]+([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/);
  if (!match) bail(`could not parse github owner/repo from remote: ${url}`);
  return { owner: match[1], repo: match[2] };
}

// ── Lintel API ──

type SecretsApiData = {
  error?: string;
  appSlug?: string;
  installationId?: number | null;
  repositorySelection?: string | null;
  isOrg?: boolean;
  accessible?: boolean;
  repoSecrets?: string[];
  orgSecrets?: string[];
  lintelSecrets?: string[];
  repoStatus?: string | null;
  repoModel?: string | null;
  hasRuns?: boolean;
};

type SecretsInfo = {
  isOrg: boolean;
  installationId: number | null;
  secretsAccessible: boolean;
  repoSecrets: string[];
  orgSecrets: string[];
  lintelSecrets: string[];
  model: string | null;
  hasRuns: boolean;
};

type InstallationNotFound = {
  appSlug: string;
  installationId: number | null;
  repositorySelection: "all" | "selected" | null;
  isOrg: boolean;
};

type StatusResult =
  | ({ installed: true } & SecretsInfo)
  | ({ installed: false } & InstallationNotFound);

type ApiResult<T = Record<string, unknown>> = {
  ok: boolean;
  status: number;
  data: T;
};

async function lintelApi<T = Record<string, unknown>>(ctx: {
  path: string;
  token: string;
  method?: string;
  body?: Record<string, unknown>;
}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${ctx.token}` };
  if (ctx.body) headers["content-type"] = "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${LINTEL_API_URL}${ctx.path}`, {
      method: ctx.method || "GET",
      headers,
      body: ctx.body ? JSON.stringify(ctx.body) : null,
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => ({}))) as T;
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchStatus(ctx: {
  token: string;
  owner: string;
  repo: string;
}): Promise<StatusResult> {
  const result = await lintelApi<SecretsApiData>({
    path: `/api/cli/secrets?owner=${encodeURIComponent(ctx.owner)}&repo=${encodeURIComponent(ctx.repo)}`,
    token: ctx.token,
  });

  if (!result.ok) {
    const errorMsg = result.data.error || "";
    if (result.status === 401) bail("invalid or expired github token.");
    if (result.status === 404) {
      const sel = result.data.repositorySelection;
      if (!result.data.appSlug) bail("server did not return appSlug");
      return {
        installed: false,
        appSlug: result.data.appSlug,
        installationId:
          typeof result.data.installationId === "number" ? result.data.installationId : null,
        repositorySelection: sel === "all" || sel === "selected" ? sel : null,
        isOrg: result.data.isOrg === true,
      };
    }
    bail(errorMsg || `secrets check failed (${result.status})`);
  }

  return {
    installed: true,
    isOrg: result.data.isOrg === true,
    installationId:
      typeof result.data.installationId === "number" ? result.data.installationId : null,
    secretsAccessible: result.data.accessible !== false,
    repoSecrets: result.data.repoSecrets || [],
    orgSecrets: result.data.orgSecrets || [],
    lintelSecrets: result.data.lintelSecrets || [],
    model: result.data.repoModel ?? null,
    hasRuns: result.data.hasRuns === true,
  };
}

// ── secret save ──

export type SecretScope = "account" | "repo";

type LintelSecretResult = { saved: boolean; error: string };

export async function setLintelSecret(ctx: {
  token: string;
  owner: string;
  repo: string;
  name: string;
  value: string;
  scope: SecretScope;
}): Promise<LintelSecretResult> {
  const result = await lintelApi<{ success?: boolean; error?: string }>({
    path: "/api/cli/secrets",
    token: ctx.token,
    method: "POST",
    body: {
      owner: ctx.owner,
      repo: ctx.repo,
      name: ctx.name,
      value: ctx.value,
      scope: ctx.scope,
    },
  });
  if (result.ok && result.data.success === true) {
    return { saved: true, error: "" };
  }
  return { saved: false, error: result.data.error || `api returned ${result.status}` };
}

export async function promptScope(ctx: { owner: string; repo: string }): Promise<SecretScope> {
  const scope = await p.select<SecretScope>({
    message: "secret scope",
    options: [
      { value: "account", label: `${ctx.owner} organization`, hint: "shared across repos" },
      { value: "repo", label: `${ctx.owner}/${ctx.repo} only` },
    ],
  });
  handleCancel(scope);
  return scope;
}
