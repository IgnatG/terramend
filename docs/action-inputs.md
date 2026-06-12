# Action inputs & outputs

<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with `pnpm docs:inputs` after changing action.yml. -->

The complete reference for [`action.yml`](../action.yml), generated from the manifest
itself so it can't drift. All Terraform inputs are optional; defaults are applied at the
consumer so "unset" stays distinguishable from an explicit value.

## Inputs

| Input | Required | Default | Description |
| ----- | :------: | ------- | ----------- |
| `prompt` | **yes** | — | Prompt to send to the agent (string or JSON payload) |
| `timeout` | no | — | Maximum run duration (e.g., 10m, 1h30m). Default: 1h |
| `model` | no | — | Model to use (e.g., anthropic/claude-opus). Overrides repo settings. |
| `mode` | no | — | Pin the run to a specific mode (e.g. 'Remediate') instead of letting the agent choose from the prompt. Case-insensitive; unknown values fall back to agent selection. Recommended for deterministic CI. |
| `cwd` | no | — | Working directory for the agent (defaults to GITHUB_WORKSPACE) |
| `push` | no | — | Git push permission: disabled (read-only), restricted (push feature branches only — blocks pushes to the default branch, branch deletion, and tag pushes), or enabled (full push access). Default: restricted (safe by default; opt into 'enabled' only when a run must push to protected refs). |
| `shell` | no | — | Shell permission: disabled, restricted (filters secrets from env vars), or enabled. Public repos default to restricted for security; private repos default to enabled. |
| `output_schema` | no | — | JSON Schema (draft-07) for structured output validation. When provided, the action output becomes required and must conform to this schema. |
| `scan_scope` | no | — | Terraform remediation: 'full' scans the whole workspace; 'diff' limits concerns to Terraform files changed vs the base branch. Default: full. |
| `severity_threshold` | no | — | Terraform remediation: minimum concern severity to act on (critical\|high\|medium\|low\|info). Default: low. |
| `max_prs` | no | — | Terraform remediation: maximum remediation PRs to open per run. Default: 1. |
| `allowed_paths` | no | — | Terraform remediation: comma-separated globs the agent may modify. Default: **/*.tf,**/*.tfvars. |
| `base_branch` | no | — | Branch the remediation/generation PR targets. Default: the repository's default branch (main, or master). Set this to pin a specific base (e.g. a release branch) regardless of where the run is dispatched. |
| `allow_replace` | no | — | Terraform remediation: comma-separated resource addresses (or globs, or '*'/'all') allowed to be destroyed/replaced. By default a fix that terraform_plan shows would delete/replace a stateful resource (RDS, S3, EBS, a SQL database, …) is blocked at push to prevent data loss. Requires cloud credentials for the plan to run. |
| `protected_paths` | no | — | Terraform remediation: comma-separated globs the fixer must NEVER auto-modify (e.g. prod state, data-store modules). A push that touched any matching file is blocked — the inverse of allowed_paths. Default: none. |
| `autonomy_threshold` | no | — | Terraform remediation: minimum severity at which a SECURITY finding is escalated to human review (needs-human label) rather than auto-fixed (critical\|high\|medium\|low\|info). A high blast radius always escalates. Default: high. |
| `gitleaks` | no | — | Terraform remediation: set 'true' to run the external gitleaks binary as an additional secret scanner on top of the built-in detectors before pushing. Opt-in and best-effort — if gitleaks isn't installed the built-in scanner is still enforced. Default: false. |
| `cost_increase_block_usd` | no | — | Terraform remediation: monthly USD increase at/above which a fix is escalated to human review (needs-human label) when infracost runs. Default: unset (no cost escalation). |
| `module_catalogue` | no | — | Terraform remediation/generation: newline- or comma-separated list of approved modules the agent should PREFER over raw resources, each '[name=]<source>[ <version>]' — a public registry module (e.g. 'terraform-aws-modules/vpc/aws ~> 5.0'), a private git module library (e.g. 'git::https://github.com/acme/tf-modules.git//aws/s3?ref=s3-v0.1.2'), or a local/house module path (e.g. './modules/networking'). Surfaced via the list_modules tool (which also auto-discovers house modules already used in the repo). Default: none. |
| `terratest` | no | — | Terraform generation: set 'true' to scaffold a Go Terratest smoke test + a native *.tftest.hcl test when generating a reusable module (via the scaffold_terratest tool). Both plan the module directly (no examples/ fixture). Opt-in and plan-only (never applies). Enabling it widens allowed_paths to permit the test files. Default: false. |
| `terraform_mcp` | no | — | Terraform remediation/generation: set 'true' to give the agent live Terraform Registry knowledge (current module versions, provider argument shapes) via HashiCorp's terraform-mcp-server, run as a version-pinned Docker image with the read-only registry toolset only. Requires docker on the runner; degrades green with a log note when absent. Default: false. |
| `review_instructions` | no | — | Review modes: org-specific review policy appended to the Review/IncrementalReview guidance (IncrementalReview inherits Review's). Inline text — use a YAML block scalar (\|) for multi-line policy. Composes with (does not replace) repo-level mode instructions from Terramend settings. Default: none. |
| `fp_filtering_instructions` | no | — | Review modes: org-specific false-positive precedents appended to the built-in Finding precedents (e.g. 'we terminate TLS at the ALB — don't flag plain HTTP on target groups'). Travels verbatim into every adversarial-verification dispatch. Inline text; use a YAML block scalar (\|) for multi-line. Default: none. |
| `token` | no | `${{ github.token }}` | GitHub-provided token with job-scoped permissions. Do not set this unless you know what you are doing. |

## Outputs

| Output | Description |
| ------ | ----------- |
| `result` | It's set when the prompt explicitly requests it and is required when output_schema is provided; use it to capture actionable output for the next workflow step. |
| `findings-count` | Number of concerns the deterministic Terraform scan reported (post scope/severity filtering). Unset when no scan ran this run; '0' when the scan came back clean — so a workflow gate can tell 'clean' from 'not scanned'. |
| `findings-sarif-path` | Absolute path to the SARIF 2.1.0 file with the scan's reported concerns (terramend.sarif in the workspace) — upload it with github/codeql-action/upload-sarif or actions/upload-artifact. Unset when no scan ran. |

