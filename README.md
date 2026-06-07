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
   `terraform-best-practices` skill (secure defaults, gold standards, registry/house modules, naming
   and structure conventions). It only ever touches Terraform files.
3. **Validates** the change (`terraform fmt` + `validate` + `tflint`) before opening anything — a PR is
   never opened on Terraform that doesn't pass.
4. **Proves the real-world effect (optional)** — when cloud credentials are present it runs
   `terraform plan` and attaches the change summary, blocks destructive changes to stateful resources,
   scores blast radius, and checks plan stability.
5. **Opens one scoped PR per concern**, on a branch named `remediate/<id>` (so re-runs update the
   existing PR rather than opening duplicates), with a body that cites the rule, links its docs,
   explains the fix in plain English, and carries a deterministic **confidence** label.
6. **Proves it** — re-runs the scan on the PR branch and records `✗ → ✓ <rule> resolved` in the PR body
   (or says honestly if a concern didn't clear), plus any **regressions** the fix introduced.

The model only *applies* fixes; the **tools decide** what's wrong. The finding set is deterministic.

### Tools the agent uses

| MCP tool | What it does |
|----------|--------------|
| `terraform_scan` | Runs fmt / validate / tflint / trivy / checkov over the workspace → a severity-ranked list of `concerns`, rolled into `groups`. Only `*.tf`/`*.tfvars` are reported. Supports `scan_scope: full \| diff`, `severity_threshold`, and `group_by: file \| rule` (one PR per rule across files). Returns a `batch_plan`, per-group autonomy, and per-concern `doc_url`. Absent scanners are reported *skipped* — never fatal. |
| `terraform_validate` | Fast pre-PR gate (fmt + validate + tflint). Also reports the pinned `providers` (name + version + resolved major) so a fix targets the right provider schema. |
| `terraform_plan` | *(needs cloud creds)* Runs `init` + `plan`; reports add/change/destroy, the destructive set, blast-radius tier, and plan stability. Degrades green (skips) without credentials. |
| `terraform_verify_remediation` | Re-runs the scanners and partitions the targeted `concern_ids` into `resolved` / `remaining` (the tamper-proof ✗→✓ proof), reports `regressions` the fix introduced, and a deterministic `confidence`. |
| `terraform_module_graph` | Parses the repo's `module` blocks into a call-graph (local / registry / git / remote) so a concern inside a **local module** is fixed once at the source, and a concern in a **remote** module is flagged as out-of-repo. |
| `list_modules` | Returns the [`module_catalogue`](#inputs) **plus** house modules auto-discovered in the repo (`discovered_house_modules`), so a fix/generation reuses a blessed registry, private-git, or house module over raw resources. |
| `scaffold_terratest` | *(opt-in via `terratest`)* Generates a plan-only Go Terratest smoke test + `examples/` fixture for a newly generated module. |
| `infracost_diff` | *(opt-in)* Monthly cost delta of the fix; escalates to `needs-human` when it crosses `cost_increase_block_usd`. |
| `read_findings` | Loads concerns from a terraform-reviewer `findings.json` instead of scanning — same `{concerns, groups}` shape. |

These run alongside Terramend's git/GitHub tools (checkout, branch, commit, push, open PR, comment).

### Required & optional command-line tools

Terramend **shells out** to these binaries; put the ones you want on the runner's `PATH`. A missing
*scanner* is reported *skipped* and never fails the run.

| Tool | Used by | Required? | How it's used |
|------|---------|-----------|---------------|
| `terraform` (or `tofu`) | `terraform_scan`, `terraform_validate`, `terraform_plan` | **Recommended** | `fmt -check`, `validate -json` (after a `init -backend=false`), and — with cloud creds — `init` + `plan -json`. |
| `tflint` | `terraform_scan`, `terraform_validate` | Optional | `tflint --recursive` (runs `--init` first when a `.tflint.hcl` is present so provider rulesets load). |
| `trivy` | `terraform_scan` | Optional | `trivy config --format json` for misconfiguration (AVD) findings. |
| `checkov` | `terraform_scan` | Optional | `checkov -d . --framework terraform -o json`. |
| `infracost` | `infracost_diff` | Optional | `infracost breakdown --format json`; needs `INFRACOST_API_KEY`. |
| `gitleaks` | secret-scan guardrail | Optional | `gitleaks detect` over the run's commits when `gitleaks: true` (on top of the always-on built-in scanner). |

---

## Guardrails

Terramend's remediation runs are bounded by **code-level** guardrails (not just prompt instructions),
all enforced at `push_branch` / `create_pull_request` and all **fail-closed**:

- **Terraform-only edits.** A push is rejected if the run changed any file outside `allowed_paths`
  (default `**/*.tf`, `**/*.tfvars`).
- **Protected paths.** A push that touched anything matching `protected_paths` is rejected — the inverse
  allow-list for prod state, data-store modules, anything you never want auto-modified.
- **No inlined secrets.** The diff is scanned for hardcoded credentials (AWS keys, PEM blocks, tokens,
  `secret = "literal"` assignments) before push; any hit blocks it. Optionally also runs `gitleaks`.
- **No destroying data.** With cloud credentials, `terraform plan` runs before the push; a fix that would
  **delete or replace a stateful resource** (RDS, S3, EBS, a SQL database, …) is hard-blocked. Opt in
  per-resource with `allow_replace`.
- **Bounded PR volume.** A run opens at most `max_prs` pull requests (default **1**).
- **Severity-driven autonomy.** High-severity *security* fixes (and large-blast-radius fixes) are
  labelled `needs-human` rather than waved through.
- **Never auto-merges.** Terramend has no merge capability — every change is left for human review.
- **Idempotent.** Branch/PR naming is keyed on the concern/rule `id`; an existing PR is updated, not
  duplicated.

---

## Usage

Add a workflow that runs Terramend on your Terraform repository. Install the scanner toolchain you want
on the runner's `PATH`; Terramend degrades gracefully (reporting tools *skipped*) when one is absent.

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
          # protected_paths: "prod/**,**/state/**"   # never auto-modify these
          # module_catalogue: |                       # prefer these modules
          #   terraform-aws-modules/vpc/aws ~> 5.0
          #   ./modules/networking
        env:
          # bring your own LLM key (BYOK) — pointed at an approved endpoint if needed
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
```

### Generate new Terraform

Pin `mode: generateterraform` and describe the infrastructure in `prompt`. Terramend writes
secure-by-default HCL (pinned versions, parameterised, validated, self-scan-clean), preferring your
`module_catalogue`, and opens one reviewable PR.

### Scope a run from a PR/issue comment

When the bot is mentioned, the comment scopes the run (no workflow edit needed):

- `@terramend fix #<concern-id>` — fix exactly one concern
- `@terramend fix all high-severity` — fix every concern at/above a severity
- `@terramend fix main.tf` — fix one file's group
- `@terramend fix all` — fix everything (still bounded by `max_prs`)

### Inputs

All Terraform inputs are optional; defaults are applied at the consumer so "unset" stays distinct from
an explicit value.

| Input | Default | Description |
|-------|---------|-------------|
| `mode` | (auto) | `remediate` (fix existing) or `generateterraform` (create new). |
| `scan_scope` | `full` | `full` scans the whole workspace; `diff` limits concerns to Terraform changed vs the base. |
| `severity_threshold` | `low` | Minimum concern severity to act on: `critical` / `high` / `medium` / `low` / `info`. |
| `max_prs` | `1` | Maximum remediation PRs opened per run. |
| `allowed_paths` | `**/*.tf,**/*.tfvars` | Comma-separated globs the agent may modify. |
| `protected_paths` | (none) | Comma-separated globs the fixer must **never** modify (inverse of `allowed_paths`). |
| `base_branch` | (default branch) | Branch the PR targets. Set to pin a specific base (e.g. a release branch). |
| `allow_replace` | (none) | Resource addresses (or globs, or `*`/`all`) the fix may destroy/replace. Needs cloud creds for the plan. |
| `autonomy_threshold` | `high` | Minimum severity at which a **security** finding is escalated to `needs-human`. A high blast radius always escalates. |
| `gitleaks` | `false` | `true` to also run the external `gitleaks` binary as a secret scanner (on top of the built-in). Best-effort. |
| `cost_increase_block_usd` | (none) | Monthly USD increase at/above which a fix is escalated to `needs-human` (when infracost runs). |
| `module_catalogue` | (none) | Newline/comma list of approved modules to prefer, each `[name=]<source>[ <version>]` — a registry module (`terraform-aws-modules/vpc/aws ~> 5.0`), a private git library (`git::https://github.com/acme/tf-modules.git//aws/s3?ref=s3-v0.1.2`), or a local/house module (`./modules/net`). |
| `terratest` | `false` | `true` to scaffold a plan-only Go Terratest test + `examples/` fixture when generating a reusable module. Widens `allowed_paths` to permit the test/example files. |

Standard agent inputs (`prompt`, `model`, `timeout`, `push`, `shell`, `token`, `output_schema`) are
also available.

### Cloud credentials (optional — unlocks the plan gate)

Add a **least-privilege, plan-only** cloud credential (`AWS_*` / `ARM_*` / `GOOGLE_*`, ideally an OIDC
role) and Terramend runs `terraform plan` before each push — enabling the destroy-block, blast-radius,
and plan-stability gates. Only cloud-prefixed env is passed to the `terraform` subprocess; your LLM key
is never leaked into it. Without credentials these gates degrade green (skipped, never failed).

### Bring your own key (BYOK)

Terramend runs the LLM behind a swappable backend. **BYOK is the default** — supply your provider key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) as a workflow secret, pointed at an
approved endpoint where data-residency matters. No external service is required for the core
remediation flow.

---

## Terraform modules

Terramend prefers a well-formed module over a pile of raw resources when one cleanly fits — a module
carries the secure defaults for you.

- **Public registry modules.** With no catalogue configured, Terramend prefers a well-maintained public
  module (e.g. the [terraform-aws-modules](https://registry.terraform.io/namespaces/terraform-aws-modules)
  collection — `vpc`, `s3-bucket`, `rds`, `eks`, …), pinned, when generating new infra.
- **Your own / house modules.** List them in `module_catalogue` (a local path like `./modules/net` or a
  private registry ref) and Terramend uses them with their exact variable names, pinned.
- **Module-source-aware fixes.** Terramend reads your `module` call-graph: a concern inside a **local
  module** is fixed once at its source (and the change propagates to every caller); a concern that would
  require editing a **registry/git/remote** module is reported (it lives outside the repo) rather than
  vendored or forked.
- **Tests & examples (Terratest).** When the change is to a reusable module, Terramend keeps its
  `examples/` and any [Terratest](https://terratest.gruntwork.io/) suite consistent with the new
  interface and flags in the PR that the suite should be run. It does **not** run Terratest itself
  (that needs Go + real cloud to `apply`) and never weakens an assertion to go green.

---

## Licence

Terramend is licensed under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later) —
see [`LICENSE`](LICENSE). It is a derivative of the MIT-licensed
[Pullfrog](https://github.com/pullfrog/pullfrog) agent runtime; that upstream notice is preserved in
[`NOTICE`](NOTICE) as the MIT licence requires.
