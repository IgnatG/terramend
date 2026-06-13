# Configuring Terramend

How to shape a run: modes, scoping, cloud credentials, BYOK, SARIF reporting, and modules.
For the complete input/output reference see [action-inputs.md](action-inputs.md) (generated
from `action.yml`, always current).

## Modes

**Remediate (default).** Scan existing Terraform and open one scoped ✗→✓ PR per concern, as shown in
the README quickstart.

**Generate new Terraform.** Pin `mode: generateterraform` and describe the infrastructure in `prompt`.
Terramend writes secure-by-default HCL (pinned versions, parameterised, validated, self-scan-clean),
preferring your `module_catalogue`, and opens one reviewable PR.

## Repo config (`.terramend.yml`)

Commit a `.terramend.yml` (or `.terramend.yaml`) at the repo root to keep the **policy** next to the code
instead of in the workflow file. It's a thin layer **under** the action inputs — an explicit workflow input
always wins; the file only fills the gaps — so a team can set sensible repo-wide defaults while a specific
workflow still overrides them.

```yaml
# .terramend.yml — repo-level Terramend policy (versioned with the code)
tools_enabled:           # same grammar as the input: names, -tool, all/none
  - trivy
  - checkov
  - tflint               # naming a non-permissive tool here IS the licence opt-in
protected_paths:         # globs the fixer must never touch
  - prod/**
  - "**/state/**"
allowed_paths: "**/*.tf,**/*.tfvars"
scan_scope: full         # full | diff
severity_threshold: low  # critical | high | medium | low | info
autonomy_threshold: high
module_catalogue:
  - terraform-aws-modules/vpc/aws ~> 5.0
  - ./modules/networking
```

Each key maps 1:1 to the matching action input and is validated by the **same** parser, so a value behaves
identically whether it comes from the file or the workflow. Values may be a string or a YAML list.

- **Only these keys are read.** Secrets (`module_fetch_token`) and per-run/workflow knobs (`mode`, `max_prs`,
  `base_branch`, `allow_replace`) are deliberately **not** read from the file — a committed file is the wrong
  place for a credential, and the run's shape belongs to the workflow.
- **Trust boundary.** The file is controlled by whoever can push to the repo (the same surface as the
  Terraform being remediated). It can only relax *within* the licence gate (naming a non-permissive tool is
  the repo owner's licence acknowledgement, exactly as on the input) and can never disable the required
  `terraform` substrate. To **enforce** a policy a contributor can't override, set the action input — it wins.
- **Degrade-green.** A missing file is a silent no-op; malformed YAML, an unknown key, or a wrong-shaped
  value is logged as a warning and ignored — it never fails the run.

## What a Terramend PR looks like

Every fix lands as a small, self-explanatory pull request. The body is built **only** from tool
results — every status line is backed by a scanner or plan output, never a self-report. A typical
single-concern PR reads like this:

```markdown
> [!NOTE]
> Hardened the S3 state bucket — encryption at rest + public-access block. Verified, low blast radius.

**Hardened `main.tf` — S3 encryption + public-access block.**

`Confidence: high` · `Blast radius: low (1 resource)` · `Plan: +0 ~1 -0` · `Idempotent: yes`

## What changed

### 🔒 [`trivy:AVD-AWS-0088`](https://avd.aquasec.com/misconfig/avd-aws-0088) — S3 bucket not encrypted

- **Was** — the bucket had no server-side encryption configured.
- **Changed** — added an `aws_s3_bucket_server_side_encryption_configuration` with `aes256`.
- **Safe because** — encryption-at-rest is transparent to readers/writers; no data is moved or replaced.

## Validation (✗ → ✓)

- ✗ → ✓ `trivy:AVD-AWS-0088` resolved
- ✗ → ✓ `checkov:CKV_AWS_19` resolved
```

The **Validation (✗ → ✓)** block is the part you can trust without trusting Terramend: it's produced by
re-running the same deterministic scanners on the PR branch, so anyone can reproduce it. Branch name is
`remediate/<id>`, so a re-run updates this PR instead of opening a duplicate. Higher-risk fixes (a
regression, a stateful destroy/replace, a large blast radius, a non-deterministic plan) swap the
`> [!NOTE]` banner for `> [!CAUTION]` and get a `needs-human` label.

## Scope a run from a PR/issue comment

When the bot is mentioned, the comment scopes the run (no workflow edit needed):

- `@terramend fix #<concern-id>` — fix exactly one concern
- `@terramend fix all high-severity` — fix every concern at/above a severity
- `@terramend fix main.tf` — fix one file's group
- `@terramend fix all` — fix everything (still bounded by `max_prs`)

## Scope out a finding

Not every finding should be fixed — a deliberate exception, a false positive, a path you never want
touched. Four ways to scope, from coarse to surgical:

- **By path** — list globs in `protected_paths` (e.g. `prod/**,**/state/**`); the fixer is hard-blocked
  from modifying anything that matches.
- **By severity** — raise `severity_threshold` so only concerns at/above a level are acted on.
- **By the scanner's own ignore** — Terramend runs the real scanners, so it honors their inline
  suppressions. An `#checkov:skip=CKV_AWS_19:reason`, a `# tflint-ignore: aws_...`, or a
  `#trivy:ignore:AVD-AWS-0088` comment removes the concern at the source, so Terramend never opens a PR
  for it (and the suppression is reviewable in your code, with its reason).
- **Per run, from a comment** — `@terramend fix #<concern-id>` (or `fix main.tf`, `fix all high-severity`)
  scopes a single run to exactly what you name.

## Cloud credentials & the plan gate

Add a **least-privilege, plan-only** cloud credential (`AWS_*` / `ARM_*` / `GOOGLE_*`, ideally an OIDC
role) and Terramend runs `terraform plan` before each push — enabling the destroy-block, blast-radius,
and plan-stability gates. Only cloud-prefixed env is passed to the `terraform` subprocess; your LLM key
is never leaked into it. Without credentials these gates degrade green (skipped, never failed).

### The minimal OIDC role

`terraform plan` needs only to **read** state and provider data — never to create, modify, or destroy.
Grant the narrowest role that lets a plan complete, via short-lived OIDC (no static keys):

- **AWS** — a role assumed via GitHub OIDC (`token.actions.githubusercontent.com`) with **read-only**
  data access (`ReadOnlyAccess`, or a tighter policy covering just the resource types in your config),
  **plus** read/write to the **state backend only** (the S3 state bucket + the DynamoDB lock table).
  Nothing else. Plan never mutates infrastructure, so no `Create*`/`Delete*`/`Put*` on real resources.
- **Azure** — a workload-identity federation app with the **Reader** role on the subscription/RG, plus
  Storage Blob Data Reader/Contributor on the state container. Set `ARM_USE_OIDC=true`.
- **GCP** — Workload Identity Federation with **`roles/viewer`** plus object access to the GCS state
  bucket.

Wire it in the workflow with `permissions: id-token: write` and the cloud's OIDC login action before the
Terramend step:

```yaml
permissions:
  id-token: write   # mint the OIDC token
  contents: write   # open the remediation branch/PR
steps:
  - uses: actions/checkout@v6
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::<acct>:role/terramend-plan-readonly
      aws-region: eu-west-2
  - uses: terramend/terramend@v0
    with:
      mode: remediate
```

Keep the role **plan-only**: Terramend never `apply`s, and the push-time destroy-block + `allow_replace`
guardrails are the second line of defence even if a plan shows a destructive change.

## Bring your own key (BYOK)

Terramend runs the LLM behind a swappable backend. **BYOK is the default** — supply your provider key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) as a workflow secret, pointed at an
approved endpoint where data-residency matters. No external service is required for the core
remediation flow. See [models.md](models.md) for the supported model catalog and selection rules.

## Report findings to code-scanning (SARIF)

Beyond opening fix PRs, Terramend can publish its scan to the repo's **Security tab**. Have the agent
call `terraform_emit_sarif` (writes `terramend.sarif`), then upload it:

```yaml
- uses: terramend/terramend@v0
  with:
    mode: remediate
- uses: github/codeql-action/upload-sarif@v4
  if: always()
  with:
    sarif_file: terramend.sarif
```

Each concern lands as a code-scanning alert with the right severity and a doc link — the **emit** side of
the same SARIF schema `read_findings` **ingests**.

## Terraform modules

Terramend prefers a well-formed module over a pile of raw resources when one cleanly fits — a module
carries the secure defaults for you.

- **Public registry modules.** With no catalogue configured, Terramend prefers a well-maintained public
  module (e.g. the [terraform-aws-modules](https://registry.terraform.io/namespaces/terraform-aws-modules)
  collection — `vpc`, `s3-bucket`, `rds`, `eks`, …), pinned, when generating new infra.
- **Your own / house modules.** List them in `module_catalogue` (a local path like `./modules/net` or a
  private registry ref) and Terramend uses them with their exact variable names, pinned.
- **Private cross-repo modules (another org repo).** A module referenced as
  `git::https://github.com/<org>/<repo>.git//path?ref=…` from a *private* repo can't be fetched with the
  job token (it's single-repo). Pass a scoped `module_fetch_token` (a PAT, GitHub App token, or
  fine-grained token with read access to the module repo) and Terramend authorises `terraform init`/`plan`
  to fetch it. The token is injected per-subprocess via `GIT_CONFIG_*` — never written to disk, never the
  action's own git. HTTPS sources only (SSH/deploy-key isn't covered). Pass it from a secret, e.g.
  `module_fetch_token: ${{ secrets.MODULE_FETCH_TOKEN }}`.
- **Module-source-aware fixes.** Terramend reads your `module` call-graph: a concern inside a **local
  module** is fixed once at its source (and the change propagates to every caller); a concern that would
  require editing a **registry/git/remote** module is reported (it lives outside the repo) rather than
  vendored or forked.
- **Modularization as remediation.** `module_extraction_candidates` finds clusters of raw resources that
  should be a module call (matched against your house modules and catalogue); the refactor PR preserves
  every resource address with `moved {}` blocks and may proceed only when `terraform_plan` proves it's a
  pure-move no-op (`refactor_safe: true`).
- **Version currency.** `terraform_version_currency` reports providers and registry modules that trail
  the registry's latest stable version (and unpinned modules); upgrades land as scoped `chore(deps)` PRs —
  major bumps always escalate to `needs-human`.
- **Live registry knowledge (opt-in).** Set `terraform_mcp: "true"` to give the agent HashiCorp's
  terraform-mcp-server (current module versions, provider argument shapes) — see [mcp.md](mcp.md).
- **Choosing the toolchain (`tools_enabled`).** One declarative allow/deny list controls which external
  tools run: comma- or newline-separated tokens, each a tool name (`terraform`, `tflint`, `trivy`,
  `checkov`, `infracost`, `gitleaks`, `conftest`, `terratest`, `terraform_mcp`), `-tool` to disable one, or
  the bases `all` / `none`. **Permissively-licensed tools run by default; non-permissive ones are off until
  you name them.** In particular **tflint (MPL-2.0, with an embedded BUSL Terraform fork) no longer runs by
  default** — opt in with `tools_enabled: "tflint"` (naming it is the explicit, licence-aware
  acknowledgement). Terraform itself is the required substrate and always runs. Examples:
  `tools_enabled: "tflint"` (add tflint to the permissive defaults), `tools_enabled: "all, -trivy"`
  (everything except Trivy), `tools_enabled: "none, +checkov"` (only Checkov + the substrate). The dedicated
  `gitleaks` / `terratest` / `terraform_mcp` inputs still work and count as an opt-in.
- **Tests (opt-in Terratest).** With the `terratest` input on, Terramend scaffolds a plan-only Go
  [Terratest](https://terratest.gruntwork.io/) smoke test **and** a native `*.tftest.hcl` test for a
  reusable module it generates — both plan the module directly (Terramend does **not** generate
  `examples/` fixtures). If the repo already has a Terratest suite, it keeps it consistent with the new
  interface and flags in the PR that the suite should be run. It does **not** run the tests itself (that
  needs Go + real cloud to `apply`) and never weakens an assertion to go green.
