# Contributing to Terramend

By participating in this project you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Contributor License Agreement (required)

All contributions are accepted under the [Contributor License Agreement](CLA.md).
Terramend is **AGPL-3.0-or-later today, with commercial dual-licensing planned** —
that model only holds if the Project Owner can relicense every contribution, which
is exactly the right the CLA grants. A plain DCO sign-off is *not* sufficient: it
attests you had the right to submit, but does not grant the relicensing rights the
dual-license model needs.

Signing is automated by the **CLA Assistant** workflow
([`.github/workflows/cla.yml`](.github/workflows/cla.yml)): on your first PR the
`CLA Assistant` status check asks you to sign by commenting

> I have read the CLA Document and I hereby sign the CLA

once — that covers all your future PRs, and the check can't go green (so the PR
can't merge) until you do. See [`CLA.md`](CLA.md) for the full agreement.

## Development setup

Terramend standardises on **Node 24** and **pnpm 11** (enforced by `engines` and
the `packageManager` pin in [`package.json`](package.json)). Use Corepack so the
right pnpm is selected automatically:

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Submitting a change

1. Fork the repo and create a feature branch.
2. Make your change. Match the surrounding code — ES modules, the `#app/*` subpath
   imports, named exports, existing naming/formatting — and keep the diff minimal
   and scoped to one concern.
3. Ship new behaviour with a test. Don't weaken or delete a test to go green.
4. Run the same checks CI does:

   ```bash
   pnpm typecheck         # strict TypeScript, no `any`-escapes (exactOptionalPropertyTypes is on)
   pnpm check:entrypoints # stdlib-only guard for the GHA entrypoints (see below)
   pnpm test              # vitest
   ```

5. Use a [Conventional Commits](https://www.conventionalcommits.org) prefix on your
   commits / PR title (see the table below) so release-please can version the change.
6. Open the PR and sign the CLA when prompted.

Those checks are enforced in CI on every PR — a change is mergeable when they all
pass. Two gates that aren't a command: **never commit credentials, tokens, or
customer data** (in code, tests, or fixtures), and **never weaken a guardrail to
make a feature work**.

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
release; housekeeping types are deliberately non-releasing so routine maintenance
doesn't churn the version. **Don't hand-edit the version, changelog, or git tags** —
release-please owns them. (Release-process mechanics live in
[`.github/workflows/release-please.yml`](.github/workflows/release-please.yml).)

## The stdlib-only entrypoint guard

[`src/entry.ts`](src/entry.ts) (`main`) and [`src/entryPost.ts`](src/entryPost.ts)
(`post`) run via `node <file>.ts` **before** `node_modules` exists — the main
step installs deps only after `entry.ts` boots, and the post step never gets a
`node_modules` tree. So those two files and their entire transitive import graph
may import only `node:*` builtins, relative siblings, and the `#app/*` /
`#package.json` subpath imports. `pnpm check:entrypoints` (run in CI) enforces
this — a stray `@actions/core`/third-party import there breaks every consumer's
run with `ERR_MODULE_NOT_FOUND`.

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
