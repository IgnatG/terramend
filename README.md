# Terramend

**Terramend brings your Terraform up to best practice — automatically, as reviewable pull requests.**

Terramend is an open-source ([AGPL-3.0](#licence)) GitHub Action and agent runtime. Point it at a
repository and it scans the Terraform with the standard deterministic tools, then opens **one scoped,
reviewable pull request per concern** that fixes the issue and **proves it fixed** by re-scanning the
branch (✗ → ✓). It never auto-merges; a human always reviews.

> **Scope (first instance): Terraform only.** Terramend deliberately focuses on Terraform — security
> misconfiguration, idiomatic style, correctness, and cost. Other technologies (CI bootstrap,
> policy-as-code, threat modelling, non-Terraform IaC) and integration with a separate review engine
> are deliberate future work, not part of this release.

---

## What it does

1. **Scans** the Terraform in the workspace with deterministic check tools — `terraform fmt`,
   `terraform validate`, [tflint](https://github.com/terraform-linters/tflint),
   [Trivy](https://github.com/aquasecurity/trivy), and [Checkov](https://www.checkov.io/). Each
   finding is normalised into a **concern** with a stable, content-derived `id`, a severity, the
   producing rule, the file/line, and a remediation hint.
2. **Fixes** the highest-severity concern with the minimal, correct change, guided by a built-in
   `terraform-best-practices` skill (secure defaults, house/registry modules, naming and structure
   conventions). It only ever touches Terraform files.
3. **Validates** the change (`terraform fmt` + `validate` + `tflint`) before opening anything — a PR is
   never opened on Terraform that doesn't pass.
4. **Opens one scoped PR per concern**, on a branch named `remediate/<concern-id>` (so re-runs update
   the existing PR rather than opening duplicates), with a body that cites the rule and explains the
   fix in plain English.
5. **Proves it** — re-runs the scan on the PR branch and records `✗ → ✓ <rule> resolved` in the PR body
   (or says honestly if a concern didn't clear).

The model only *applies* fixes; the **tools decide** what's wrong. The finding set is deterministic.

### Tools the agent uses

| MCP tool | What it does |
|----------|--------------|
| `terraform_scan` | Runs fmt / validate / tflint / trivy / checkov over the workspace → a severity-ranked list of concerns. Only Terraform files (`*.tf`/`*.tfvars`) are reported; checkov runs with `--framework terraform`. Supports `scan_scope: full \| diff` and a `severity_threshold`. Scanners that aren't installed are reported as *skipped* — they never fail the scan. |
| `terraform_validate` | Fast pre-PR gate (fmt + validate + tflint over the workspace). |

These run alongside Terramend's git/GitHub tools (checkout, branch, commit, push, open PR, comment).

---

## Guardrails

Terramend's remediation runs are bounded by **code-level** guardrails (not just prompt instructions):

- **Terraform-only edits.** A remediation push is rejected if the run changed any file outside the
  allowed paths (default `**/*.tf`, `**/*.tfvars`). Configurable via `allowed_paths`.
- **Bounded PR volume.** A run opens at most `max_prs` pull requests (default **1**).
- **Never auto-merges.** Terramend has no merge capability — every change is left for human review.
- **Idempotent.** Branch/PR naming is keyed on the concern `id`; an existing remediation PR is updated,
  not duplicated.

---

## Usage

Add a workflow that runs Terramend on your Terraform repository. The scanner toolchain
(`terraform`, `tflint`, `trivy`, `checkov`) must be on the runner's `PATH` — Terramend shells out to
them and degrades gracefully (reporting them *skipped*) when one is absent.

```yaml
name: Terramend — Terraform remediation
on:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * 1" # weekly drift sweep

permissions:
  contents: write       # push the remediation branch
  pull-requests: write  # open the PR

jobs:
  remediate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # install the Terraform best-practice toolchain
      - uses: hashicorp/setup-terraform@v3
      - uses: terraform-linters/setup-tflint@v4
      - uses: aquasecurity/setup-trivy@v0.3.1
      - run: pipx install checkov

      - name: Run Terramend
        uses: <your-org>/terramend@v0
        with:
          mode: remediate
          severity_threshold: medium   # only act on medium+ concerns
          max_prs: 1                    # one scoped PR per run
          # allowed_paths: "**/*.tf,**/*.tfvars"   # default
          # scan_scope: full                       # or 'diff' on PRs
        env:
          # bring your own LLM key (BYOK) — pointed at an approved endpoint if needed
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
```

### Inputs (Terraform remediation)

| Input | Default | Description |
|-------|---------|-------------|
| `mode` | (auto) | `remediate` to bring Terraform up to best practice. |
| `scan_scope` | `full` | `full` scans the whole workspace; `diff` limits concerns to Terraform files changed vs the base branch. |
| `severity_threshold` | `low` | Minimum concern severity to act on: `critical` / `high` / `medium` / `low` / `info`. |
| `max_prs` | `1` | Maximum remediation PRs opened per run. |
| `allowed_paths` | `**/*.tf,**/*.tfvars` | Comma-separated globs the agent may modify. |
| `base_branch` | (run branch) | Branch the PR targets and is branched from. Defaults to the branch the run was triggered on, else the repository's default branch. Set it to pin a specific base regardless of where the run is dispatched. |

Standard agent inputs (`prompt`, `model`, `timeout`, `push`, `shell`, `token`, `output_schema`) are
also available.

### Bring your own key (BYOK)

Terramend runs the LLM behind a swappable backend. **BYOK is the default** — supply your provider key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) as a workflow secret, pointed at an
approved endpoint where data-residency matters. No external service is required for the core
remediation flow.

---

## Licence

Terramend is licensed under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later) —
see [`LICENSE`](LICENSE). It is a derivative of the MIT-licensed
[Pullfrog](https://github.com/pullfrog/pullfrog) agent runtime; that upstream notice is preserved in
[`NOTICE`](NOTICE) as the MIT licence requires.
