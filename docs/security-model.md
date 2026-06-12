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

## Tool-scope enforcement (REST write tools)

The agent is treated as **semi-trusted**: attacker-controlled PR/issue content can prompt-inject it.
The GitHub write tools are therefore bound, in code, to what the run is actually for:

- **Cross-repo writes are impossible.** Every tool pins `owner`/`repo` to the run's repository, and the
  GitHub App installation token is scoped to that repository.
- **Cross-issue/PR writes are blocked.** `create_issue_comment`, `update_pull_request_body`, `add_labels`,
  `reply_to_review_comment`, `create_pull_request_review` (including `APPROVE`), and `resolve_review_thread`
  may only act on the issue/PR that **triggered** the run, or one the run **opened itself**
  (`create_pull_request` / `create_issue`). A merely *checked-out* PR does not widen write scope — see
  `src/mcp/scope.ts`. This mirrors the cross-PR clobber guard already enforced at `push_branch`.
- **Issue/PR creation is a write.** `create_pull_request` and `create_issue` are refused under
  `push: disabled` (read-only access), the same as `push_branch`.

## Known hardening backlog

Tracked gaps with a planned mitigation — documented here so they can be scheduled, not silently carried:

- **The in-process MCP HTTP endpoint is unauthenticated.** During a run the action starts a FastMCP
  server bound to `127.0.0.1` on an ephemeral port (`src/mcp/server.ts`) that the coding agent connects
  to. It is reachable only from loopback and lives only for the run, but it has **no per-request auth**:
  any process that can run code on the same runner (most realistically a malicious dependency
  `postinstall`, which executes in `shell: restricted` runs) could scan the local port range, speak MCP,
  and drive privileged tools — `push_branch`, `create_pull_request` — using the server's
  already-loaded installation token, *without ever needing the token itself*. This side-steps the ASKPASS
  design that otherwise keeps that token out of child processes.
  - **Current mitigations:** loopback-only bind, ephemeral port, server lifetime bounded to the run.
  - **Planned fix:** mint a per-run bearer token, inject it into the agent's MCP client config, and reject
    unauthenticated requests via a FastMCP `authenticate` hook. Tracked separately because it changes how
    the agent's MCP client is configured.
