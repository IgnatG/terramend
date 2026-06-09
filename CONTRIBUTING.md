# Contributing to Terramend

By participating in this project you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Contributor License Agreement (required)

Terramend is **AGPL-3.0-or-later today, with commercial dual-licensing planned.**
That model only holds if the Project Owner can relicense every contribution — so
**all contributions are accepted under the [Contributor License Agreement](CLA.md).**

Enforcement is live via the **CLA Assistant** workflow
([`.github/workflows/cla.yml`](.github/workflows/cla.yml)): on your first PR the
`CLA Assistant` status check asks you to sign by commenting

> I have read the CLA Document and I hereby sign the CLA

once (covering future PRs). PRs can't be merged until that check passes. A plain
DCO sign-off is *not* sufficient here: it attests you had the right to submit,
but does not grant the relicensing rights the dual-license model needs.

> **Maintainer setup (one-time):** the workflow stores signatures in
> `signatures/version1/cla.json` on a `cla-signatures` branch it creates on first
> run (via `GITHUB_TOKEN`). Ensure Settings → Actions → General → Workflow
> permissions is set to **Read and write** and "Allow GitHub Actions to create
> and approve pull requests" is enabled. To keep signatures in a separate private
> repo, set a `CLA_SIGNATURES_TOKEN` PAT (see the commented block in the workflow).
> The action is SHA-pinned; Dependabot keeps it current.

## Development setup

Terramend standardises on **Node 24** and **pnpm 11** (enforced by `engines` and
the `packageManager` pin in [`package.json`](package.json)). Use Corepack so the
right pnpm is selected automatically:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck        # tsc --noEmit
pnpm check:entrypoints # stdlib-only guard for the GHA entrypoints (see below)
pnpm test             # vitest
```

## Requirements for an acceptable contribution

A change is mergeable when it meets all of these — they're enforced in CI on
every PR, so check them locally first:

1. **Type-clean** — `pnpm typecheck` passes (strict TypeScript, no `any`-escapes
   to silence errors; `exactOptionalPropertyTypes` is on).
2. **Tested** — `pnpm test` (Vitest) passes, and new behaviour ships with a test.
   Don't weaken or delete a test to go green.
3. **Style** — match the surrounding code: ES modules, the `#app/*` subpath
   imports, named exports, and the existing naming/formatting. Keep diffs minimal
   and scoped to one concern.
4. **Entrypoint guard** — `pnpm check:entrypoints` passes (see below): `entry.ts`
   / `entryPost.ts` and their import graph may use only `node:*` builtins and the
   `#app/*` / `#package.json` subpaths.
5. **Conventional Commits** — the PR title / commits follow the prefixes below so
   release-please can version and changelog the change.
6. **Signed CLA** — the CLA Assistant check is green (see above).
7. **Security & secrets** — no credentials, tokens, or customer data in code,
   tests, or fixtures; never weaken a guardrail to make a feature work.

## Conventional Commits → automated releases

Releases are automated with [release-please](https://github.com/googleapis/release-please)
driven by [Conventional Commits](https://www.conventionalcommits.org). Commit
prefixes map to version bumps and changelog sections:

| Prefix | Bump | Changelog section |
|--------|------|-------------------|
| `feat:` | minor | Features |
| `fix:` | patch | Bug Fixes |
| `deps:` | patch | Dependencies (Dependabot uses this) |
| `perf:` | patch | Performance Improvements |
| `revert:` | patch | Reverts |
| `feat!:` / `BREAKING CHANGE:` | major | — |
| `refactor:` `docs:` `build:` `ci:` `test:` `style:` `chore:` | **none** | hidden — does not cut a release or appear in the changelog |

Only `feat` / `fix` / `deps` / `perf` / `revert` (and breaking changes) cut a
release. Housekeeping types (`docs`, `ci`, `chore`, …) are deliberately
non-releasing so routine maintenance doesn't churn the version.

release-please keeps an open "release PR" that accumulates the changelog and the
`package.json` bump; merging it cuts the `vX.Y.Z` tag + GitHub release, and the
`tag-floats` job moves the `vX` / `vX.Y` float tags so consumers can pin
`terramend/terramend@v0`, `@v0.1`, or `@v0.1.3`. See
[`.github/workflows/release-please.yml`](.github/workflows/release-please.yml).
Don't hand-edit the version or hand-cut tags.

> npm publishing is **separate** — terramend's npm version is server-stamped from
> the SHA-pinned action ref at publish time (see [`src/runCli.ts`](src/runCli.ts)).
> release-please owns git tags / GitHub releases / the changelog only.

## Dependencies (Dependabot)

[`.github/dependabot.yml`](.github/dependabot.yml) opens weekly grouped PRs for
the `npm` (package.json + pnpm-lock), `github-actions`, and `docker` (local test
container) ecosystems, all with the `deps:` prefix.

## Pinning GitHub Actions

Pin every third-party action to a **full commit SHA** with a trailing version
comment, never a moving tag:

```yaml
- uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
```

A SHA can't be force-moved; a tag can. Dependabot rewrites both the SHA and the
`# vX` comment on each upstream release.

## The stdlib-only entrypoint guard

[`src/entry.ts`](src/entry.ts) (`main`) and [`src/entryPost.ts`](src/entryPost.ts)
(`post`) run via `node <file>.ts` **before** `node_modules` exists — the main
step installs deps only after `entry.ts` boots, and the post step never gets a
`node_modules` tree. So those two files and their entire transitive import graph
may import only `node:*` builtins, relative siblings, and the `#app/*` /
`#package.json` subpath imports. `pnpm check:entrypoints` (run in CI) enforces
this — a stray `@actions/core`/third-party import there breaks every consumer's
run with `ERR_MODULE_NOT_FOUND`.
