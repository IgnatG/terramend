# Under the hood — tools

What actually runs during a Terramend run: the MCP tools the agent calls, and the command-line
binaries they shell out to. (For using these tools from your IDE, see [mcp.md](mcp.md).)

## MCP tools the agent uses

| MCP tool | What it does |
|----------|--------------|
| `terraform_scan` | Runs fmt / validate / tflint / trivy / checkov over the workspace → a severity-ranked list of `concerns`, rolled into `groups`. Only `*.tf`/`*.tfvars` are reported. Supports `scan_scope: full \| diff`, `severity_threshold`, and `group_by: file \| rule` (one PR per rule across files). Returns a `batch_plan`, per-group autonomy, and per-concern `doc_url`. Absent scanners are reported *skipped* — never fatal. |
| `terraform_validate` | Fast pre-PR gate (fmt + validate + tflint). **Multi-root aware** — validates every Terraform root (`roots_validated`). Reports the pinned `providers` (name + version + resolved major) and `unknown_arguments` — written arguments not in the **installed** provider's schema that would break `plan` (advisory; `schema_checked: false` when the schema is unavailable). |
| `terraform_plan` | *(needs cloud creds)* **Multi-root aware** — plans every root (`roots_planned`) and aggregates add/change/destroy, the destructive set, blast-radius tier, and plan stability. Tracks `moved` (state-only) operations and reports `refactor_safe: true` for a pure-move plan — the gate a modularization refactor must pass. Degrades green (skips) without credentials. |
| `terraform_verify_remediation` | Re-runs the scanners and partitions the targeted `concern_ids` into `resolved` / `remaining` (the independently re-verifiable ✗→✓ proof — anyone can re-run the same deterministic scanners on the branch and reproduce it), reports `regressions` the fix introduced, and a deterministic `confidence`. |
| `terraform_version_currency` | Checks pinned providers and registry modules against the Terraform Registry's published versions — reports `latest`, the newest version the written constraint admits, `outdated`/`majors_behind`, and `unpinned` registry modules. Powers scoped `chore(deps)` upgrade PRs (major bumps escalate to `needs-human`). Network-dependent; degrades green when the registry is unreachable. |
| `terraform_module_graph` | Parses the repo's `module` blocks into a call-graph (local / registry / git / remote) so a concern inside a **local module** is fixed once at the source, and a concern in a **remote** module is flagged as out-of-repo. Also returns `dependency_order` — fix a depended-on local module **before** its dependents so sequenced PRs don't conflict (§24). |
| `list_modules` | Returns the operator's `module_catalogue` **plus** house modules auto-discovered in the repo (`discovered_house_modules`), so a fix/generation reuses a blessed registry, private-git, or house module over raw resources. |
| `terraform_module_interface` | Parses a module's `variable`s (name/type/required) + `output`s so a `module` block uses the module's real interface. |
| `module_extraction_candidates` | Finds clusters of raw resources that should likely be a module call (M2 modularization-as-remediation): clusters by shared name prefix / cohesive file, matched against house modules (real resource-type signature + `required_variables`) and the catalogue (service keyword). The refactor contract: `moved {}` blocks per resource, and the PR proceeds only when `terraform_plan` reports `refactor_safe: true`. |
| `terraform_roots` | Discovers the repo's Terraform **root modules** (dirs with a `provider`/`backend`) so plan/validate run per-root in multi-root repos. Also returns `environment_twins` — parallel `dev`/`staging`/`prod` (or per-region) stacks, so a fix can be offered for every twin (§22). |
| `terraform_provider_schema` | After `init`, returns a resource type's valid attributes/blocks for the **installed provider**, flagging args that would break `plan`. Cached per run. |
| `terraform_emit_sarif` | Writes the scan as a **SARIF 2.1.0** file (default `terramend.sarif`) for `github/codeql-action/upload-sarif` — surfaces every concern in the repo's Security tab. The emit side of `read_findings`' SARIF ingest. |
| `policy_check` | *(opt-in)* Runs the repo's own **policy-as-code** (Rego) via the external `conftest` (OPA) binary against the plan JSON. A `passed: false` is a stop-sign (treated like a failed validate). Degrades green when conftest / a policy dir is absent. |
| `terraform_compliance_crosswalk` | Maps a scan's concerns → the **UK + general compliance controls** they touch (NCSC Cloud Security Principles, Cyber Essentials, NHS DSPT, Secure by Design, CIS Controls v8, SOC 2) for an auditor-facing PR note. Covers only frameworks with controls assessable from Terraform; broad process- or service-level standards are deliberately **out of scope** — they're not determinable from IaC alone. Indicative, versioned rule-pack — alignment guidance, not an audit verdict (§23). |
| `scaffold_terratest` | *(opt-in via `terratest`)* Generates a plan-only Go Terratest test **+** a native `*.tftest.hcl` test for a newly generated module — both plan the module directly (no `examples/` fixture). |
| `infracost_diff` | *(opt-in)* Monthly cost delta of the fix; escalates to `needs-human` when it crosses `cost_increase_block_usd`. |
| `read_findings` | Loads concerns from a terraform-reviewer `findings.json` **or a SARIF report** instead of scanning — same `{concerns, groups}` shape. A supported **bring-your-own-findings** input: point Terramend at any scanner that emits SARIF and it remediates those instead of running its own scan. |

Every tool returns a consistent structured envelope: success → `{ ok: true, … }`, skip/unavailable →
`{ ok: false, code, detail }` (with a stable machine `code`), so a run can branch on outcomes
deterministically.

These run alongside Terramend's git/GitHub tools (checkout, branch, commit, push, open PR, comment) —
and, with `terraform_mcp: "true"`, HashiCorp's terraform-mcp-server for live registry knowledge
(see [mcp.md](mcp.md)).

## Required & optional command-line tools

Terramend **shells out** to these binaries; put the ones you want on the runner's `PATH`. A missing
*scanner* is reported *skipped* and never fails the run.

| Tool | Used by | Required? | How it's used |
|------|---------|-----------|---------------|
| `terraform` (or `tofu`) | `terraform_scan`, `terraform_validate`, `terraform_plan` | **Recommended** | `fmt -check`, `validate -json` (after a `init -backend=false`), and — with cloud creds — `init` + `plan -json`. |
| `tflint` | `terraform_scan`, `terraform_validate` | Optional | `tflint --recursive` (runs `--init` first when a `.tflint.hcl` is present so provider rulesets load). |
| `trivy` | `terraform_scan` | Optional | `trivy config --format json` for misconfiguration (AVD) findings. |
| `checkov` | `terraform_scan` | Optional | `checkov -d . --framework terraform -o json`. |
| `infracost` | `infracost_diff` | Optional | `infracost breakdown --format json`; needs `INFRACOST_API_KEY`. **Data residency:** by default infracost sends resource attributes to its US-hosted Cloud Pricing API. To keep pricing in-region, run the [self-hosted Cloud Pricing API](https://www.infracost.io/docs/cloud_pricing_api/self_hosted/) and set `INFRACOST_PRICING_API_ENDPOINT` to your instance. Leave `infracost` off entirely to send nothing. |
| `gitleaks` | secret-scan guardrail | Optional | `gitleaks detect` over the run's commits when `gitleaks: true` (on top of the always-on built-in scanner). |
| `conftest` | `policy_check` | Optional | `conftest test --output json -p <policy-dir>` against the plan JSON; opt-in policy-as-code gate. |
| `docker` | `terraform_mcp` input | Optional | `docker run -i --rm hashicorp/terraform-mcp-server:<pinned> --toolsets=registry` — the opt-in registry-knowledge MCP server. Skipped with a note when absent. |
