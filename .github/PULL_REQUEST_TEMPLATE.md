<!--
Thanks for contributing to Terramend! Please keep the diff minimal and scoped to
one concern. See CONTRIBUTING.md for the full guide.
-->

## What & why

<!-- What does this change do, and why? Link any related issue: "Fixes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / tech debt
- [ ] Documentation
- [ ] CI / tooling

## Checklist

- [ ] Title follows [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `fix(mcp): ...`) — release-please relies on it.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm check:entrypoints` passes.
- [ ] `pnpm test` passes (added/updated tests for the change where it makes sense).
- [ ] For security-sensitive changes (sandbox, guardrails, token/git handling), I considered the adversarial test surface in `test/`.
- [ ] I have read and signed the [CLA](../CLA.md) (the CLA Assistant check will prompt on first PR).
