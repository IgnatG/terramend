/**
 * Org-private cross-repo module fetch (§1.5 "org-private cross-repo module
 * fetch" — the HepCare shape).
 *
 * Referencing a private module from another repo in your org works today
 * (`git::https://github.com/acme/tf-modules.git//aws/s3?ref=…`), but FETCHING it
 * at `terraform init` does not: the action's own git is locked down (ASKPASS,
 * `credential.helper=`) and the job token is single-repo, so terraform's child
 * `git clone` of the module repo has no credential. This module supplies a
 * scoped one — a PAT / GitHub App token / fine-grained token the operator passes
 * as `module_fetch_token`.
 *
 * Mechanism: Git's `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
 * env injection (Git ≥ 2.31). We add an `http.https://<host>/.extraheader`
 * carrying a Basic auth header (the same pattern actions/checkout uses), scoped
 * to the terraform subprocess only — no global/file config is mutated and the
 * token never lands on disk. Only HTTPS `git::` sources are covered; an SSH /
 * deploy-key source needs a key, which is out of scope here.
 */

/** the `x-access-token:<token>` Basic header value Git sends per request. */
function basicAuthHeader(token: string): string {
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `Authorization: Basic ${encoded}`;
}

/**
 * Build the `GIT_CONFIG_*` env that authorises `git clone` of a private module
 * over HTTPS for each host. Pure (token + hosts in, env out) so it is unit-
 * testable without a real git. Empty/whitespace hosts are dropped; hosts are
 * de-duplicated case-insensitively. Returns an empty object only when no usable
 * host remains (the caller treats that as "no module-fetch credential").
 */
export function buildModuleFetchGitEnv(token: string, hosts: string[]): Record<string, string> {
  const seen = new Set<string>();
  const uniqueHosts: string[] = [];
  for (const h of hosts) {
    const host = h.trim().toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    uniqueHosts.push(host);
  }
  if (uniqueHosts.length === 0) return {};

  const header = basicAuthHeader(token);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(uniqueHosts.length) };
  uniqueHosts.forEach((host, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `http.https://${host}/.extraheader`;
    env[`GIT_CONFIG_VALUE_${i}`] = header;
  });
  return env;
}

/**
 * The hosts a module-fetch credential should authorise: always github.com, plus
 * the GitHub host the run executes against (a GitHub Enterprise Server instance
 * via `GITHUB_SERVER_URL`) when it differs. Reads the env; pure given it.
 */
export function moduleFetchHosts(serverUrl = process.env.GITHUB_SERVER_URL): string[] {
  const hosts = ["github.com"];
  if (serverUrl) {
    try {
      const host = new URL(serverUrl).hostname;
      // de-dupe case-insensitively: on github.com-hosted runs GITHUB_SERVER_URL
      // is https://github.com, so the seeded host would otherwise repeat.
      if (host && !hosts.some((h) => h.toLowerCase() === host.toLowerCase())) hosts.push(host);
    } catch {
      /* malformed GITHUB_SERVER_URL — fall back to github.com only */
    }
  }
  return hosts;
}

/**
 * Resolve the module-fetch git env for a run, or undefined when no
 * `module_fetch_token` was supplied (the common case — public/registry/local
 * modules need no credential). The result is merged into the env of the
 * `terraform init`/`plan` invocations so private cross-repo modules resolve.
 */
export function resolveModuleFetchEnv(payload: {
  moduleFetchToken?: string | undefined;
}): Record<string, string> | undefined {
  const token = payload.moduleFetchToken?.trim();
  if (!token) return undefined;
  return buildModuleFetchGitEnv(token, moduleFetchHosts());
}
