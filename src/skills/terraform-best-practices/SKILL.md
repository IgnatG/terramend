---
name: terraform-best-practices
description: Fix Terraform to best practice from a scanner concern — the minimal, correct change for a tfsec/checkov/tflint/fmt/validate finding, plus the security, structure, and naming conventions a good fix must follow. Use when remediating Terraform, applying a `terraform_scan` concern, or generating new HCL that must start compliant.
---

# Terraform best-practice remediation

You are fixing Terraform against a **concern** emitted by `terraform_scan` (or
`terraform_validate`). Each concern names the producing `source`, a `rule_id`,
the `location` (file + line), an `evidence` string (what's wrong), and often a
`remediation_hint`. Your job is the **smallest correct change** that clears that
concern — nothing more.

## The remediation loop

1. **Read the concern.** The `rule_id` tells you the class of problem; the
   `evidence` tells you the specifics; `location.file:line` tells you where.
2. **Open the file and understand the surrounding resource** before editing.
   Don't fix a line in isolation — know which `resource` / `module` / `variable`
   block it belongs to.
3. **Apply the minimal fix** (see the catalogue below). Touch only `*.tf` /
   `*.tfvars`. Do not reformat, reorder, or "improve" unrelated code — that
   buries the real fix and breaks the one-concern-per-PR contract.
4. **Re-validate** with `terraform_validate`. If it doesn't pass, your fix is
   incomplete or introduced a new problem — fix that before opening a PR.
5. **Confirm the concern cleared** by re-running `terraform_scan` on the branch.
   The concern's `id` must be gone. If it isn't, say so honestly.

## What a good fix looks like, by source

- **`terraform-fmt:unformatted`** — run `terraform fmt` on the named file. This
  is whitespace/alignment only; never combine it with a behavioural change in
  the same PR.
- **`tflint:*`** — idiomatic-HCL and provider-rule issues. Common fixes: remove
  unused `variable`/`local`/`data` declarations; pin deprecated syntax forward;
  add missing required provider/version constraints. Follow the rule's link.
- **`tfsec:*` / `checkov:*`** — security misconfiguration. These are the
  high-value fixes. Apply the **secure default**, e.g.:
  - **encryption at rest** — add the `server_side_encryption_configuration` /
    `encryption` block (S3, RDS, EBS, etc.); prefer a CMK where the rule asks.
  - **no public access** — set `block_public_acls`/`block_public_policy` etc. to
    `true`; remove `acl = "public-read"`; tighten `0.0.0.0/0` ingress to the
    real CIDR or a referenced security group.
  - **least privilege** — replace `"*"` actions/resources in IAM policies with
    the specific actions/ARNs actually needed.
  - **logging / versioning** — add the access-logging, audit, or versioning
    block the rule requires.
- **`terraform-validate:*`** — a correctness error (bad reference, type
  mismatch, missing required argument). Fix the actual HCL so `terraform
  validate` passes.

## Conventions every fix must honour

- **Variables over hardcoded values.** Don't bake an account id, region, CIDR,
  or ARN into a fix — reference an existing `var.*`/`local.*`, or add a typed
  `variable` with a sensible `default` and `description` when one is genuinely
  needed.
- **Pin versions.** When adding a provider or module, include a version
  constraint. Never widen an existing pin as a side effect.
- **House modules first.** If a house module catalogue is configured (see the
  `list_house_modules` tool), prefer the house module + its exact variable
  names over inlining a raw resource.
- **No secrets in HCL or state.** Never introduce a literal credential. If the
  fix needs a secret, reference a variable or a secrets data source.
- **Idempotent, reviewable diffs.** The diff should read so a senior engineer
  approves it without hesitation: one concern, one rationale, no churn.

## Hard rules

- Only modify `*.tf` / `*.tfvars`. Never touch CI, application code, or
  unrelated config in a remediation PR.
- One concern per PR. If you notice other issues, leave them for their own runs.
- Never auto-merge. The PR is for a human to review.
- If you cannot fix a concern cleanly (it needs a human decision, or the secure
  default would break the stack), do **not** open a broken PR — report it
  instead with what's blocking.
