# Security model

Letting an agent touch your infrastructure code is a trust decision. Terramend is built so the answer
to "what happens to my code and who's in control?" is boring and verifiable. For vulnerability
reporting and supported versions, see [SECURITY.md](../SECURITY.md).

## Guardrails (enforced in code, not prompts)

Terramend's remediation runs are bounded by **code-level** guardrails, all enforced at
`push_branch` / `create_pull_request` and all **fail-closed**:

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

## Trust & data privacy

- **Your key, your endpoint — BYOK by default.** Terramend ships with no hosted LLM backend. Your
  Terraform is only ever sent to the provider *you* configure with *your* key (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, …), which you can point at a region-pinned or self-hosted endpoint
  where data residency matters. Terramend stores and retains nothing.
- **Runs in your runner.** Everything happens inside your own GitHub Actions runner — clone, scan, fix,
  plan, push. No code is shipped to a Terramend service; there is no Terramend service in the core flow.
- **Deterministic detection, scoped generation.** The scanners decide what's wrong; the LLM only drafts
  the minimal fix. The model never invents findings, and it only ever sees what it needs to fix them.
- **A human always merges.** Terramend has no merge capability. Every change is a reviewable PR with a
  reproducible ✗ → ✓ proof — you approve it, or you don't.
- **Credentials stay separated.** Only cloud-prefixed env (`AWS_*` / `ARM_*` / `GOOGLE_*`) is passed to
  the `terraform` subprocess for the optional plan gate; your LLM key is never leaked into it. The
  plan-gate role is least-privilege and **plan-only** (see
  [configuration.md](configuration.md#cloud-credentials--the-plan-gate)).
- **Third-party MCP is opt-in and pinned.** The optional `terraform_mcp` integration runs HashiCorp's
  terraform-mcp-server as a version-pinned Docker image with the read-only registry toolset only — no
  TFE operations, no TFE token (see [mcp.md](mcp.md)).
