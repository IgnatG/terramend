---
name: terraform-best-practices
description: Fix Terraform to best practice from a scanner concern — the minimal, correct change for a trivy/checkov/tflint/fmt/validate finding, plus the security, structure, and naming conventions a good fix must follow. Use when remediating Terraform, applying a `terraform_scan` concern, or generating new HCL that must start compliant.
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
- **`trivy:*` / `checkov:*`** — security misconfiguration. These are the
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

## Secure-default catalogue (by problem class)

Copy-pasteable shapes for the highest-frequency security concerns. These target
the **AWS provider v5+** layout (encryption / versioning / ACL / public-access
are standalone resources, not inline `aws_s3_bucket` blocks). Adapt resource and
attribute names to the block the concern points at — don't paste blindly.

### Encryption at rest

S3 — server-side encryption with a customer-managed key (preferred over `AES256`
when the rule asks for a CMK):

```hcl
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this.arn
    }
    bucket_key_enabled = true
  }
}
```

EBS volume / root device: `encrypted = true` (add `kms_key_id` when a CMK is
required). RDS: `storage_encrypted = true` (+ `kms_key_id`). When `aws:kms` needs
a key and none exists, reference an existing `aws_kms_key`/`var.*`; only add a new
`aws_kms_key` resource if the stack genuinely has none — keep `AES256` if the rule
is satisfied by SSE-S3 alone.

### Block public access

S3 — the four-flag public-access block is the canonical fix; wire it to the same
bucket:

```hcl
resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

Also remove any `acl = "public-read"` (move to a private `aws_s3_bucket_acl` if an
ACL is needed at all).

### Network ingress

Replace world-open ingress with the real source. Never leave `0.0.0.0/0` on admin
ports (22/3389/database ports):

```hcl
ingress {
  from_port       = 443
  to_port         = 443
  protocol        = "tcp"
  cidr_blocks     = [var.allowed_cidr]      # or: security_groups = [aws_security_group.lb.id]
}
```

### IAM least privilege

Replace wildcard `Action`/`Resource` with the specific actions and ARNs the
workload actually uses. If you can't determine the exact set from the surrounding
code, this is a human decision — report it rather than guessing a narrow policy
that breaks the stack.

### Versioning & logging

S3 versioning and access logging as standalone resources:

```hcl
resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration { status = "Enabled" }
}
```

### EC2 instance metadata (IMDSv2)

Require token-backed metadata to close the SSRF→credential path:

```hcl
metadata_options {
  http_endpoint = "enabled"
  http_tokens   = "required"
}
```

### Deprecations & style

- **Provider v4→v5 S3 split** — inline `server_side_encryption_configuration` /
  `versioning` / `acl` / `logging` blocks on `aws_s3_bucket` are deprecated; move
  each to its standalone resource (above). Don't bump the provider major version
  as a side effect of a remediation — if a fix genuinely requires a newer
  provider, report that as a blocker.
- **`terraform-fmt:unformatted`** — run `terraform fmt` on the named file only;
  never fold a formatting pass into a behavioural fix.

## Don't over-reach

- **Smallest change that clears the concern.** Add the missing block; don't
  refactor the resource, rename it, or restructure the file around it.
- **Don't add speculative hardening** the concern didn't ask for (extra KMS keys,
  new modules, blanket tagging) — that's scope creep and buries the real fix.
- **Don't widen or bump version pins** to reach a resource or attribute.
- **One concern's blast radius only.** If the secure default would break the
  stack or needs a human call (a real CIDR, an IAM action set, a CMK policy),
  stop and report it instead of opening a broken or guessed PR.

## Conventions every fix must honour

- **Variables over hardcoded values.** Don't bake an account id, region, CIDR,
  or ARN into a fix — reference an existing `var.*`/`local.*`, or add a typed
  `variable` with a sensible `default` and `description` when one is genuinely
  needed.
- **Pin versions.** When adding a provider or module, include a version
  constraint. Never widen an existing pin as a side effect.
- **Approved modules first.** Call `list_modules` — if a catalogue is configured,
  prefer the catalogue module (a registry module or a local/house module) + its
  exact variable names over inlining a raw resource, and pin its `version`. See
  *Using Terraform modules* below.
- **No secrets in HCL or state.** Never introduce a literal credential. If the
  fix needs a secret, reference a variable or a secrets data source.
- **Idempotent, reviewable diffs.** The diff should read so a senior engineer
  approves it without hesitation: one concern, one rationale, no churn.

## Gold standards (the bar every fix is measured against)

These are the non-negotiable defaults a "good" Terraform change embodies. A fix
should never *move away* from any of these, and should move *toward* them when
the concern is adjacent:

- **Encrypt everything, at rest and in transit.** Storage encrypted (CMK where
  the data is sensitive); TLS-only endpoints; no plaintext in state.
- **Private by default.** No `0.0.0.0/0` to admin/database ports; public access
  blocked unless the resource's whole purpose is to be public (and then scoped).
- **Least privilege.** No `"*"` IAM actions/resources; scope to what the workload
  uses. Prefer a referenced role/policy over an inline wildcard.
- **Pinned + reproducible.** `required_version` and every `required_providers` /
  module `version` constrained (`~>`); no floating `latest`.
- **Parameterised, not hardcoded** (see below).
- **Tagged + named consistently.** Match the repo's existing tag keys and naming
  scheme; don't invent a new convention.
- **Observable.** Logging / versioning / audit trails enabled where the provider
  supports them and the concern is about data durability or traceability.
- **Idempotent + deterministic.** No `timestamp()`/`uuid()`/unkeyed `random_*`
  driving a value that lands in state — it produces a perpetual diff.

When in doubt, the secure/idiomatic default from the catalogue above IS the gold
standard. Don't gold-plate beyond the concern, but never regress one of these.

## Parameterize, don't hardcode (§4.13)

A value that varies by environment, account, or deployment must be a `variable`
or `local`, never a literal baked into a resource:

- **Reuse first.** If the repo already exposes `var.region` / `local.tags` /
  `var.vpc_cidr`, reference it — don't introduce a parallel one.
- **Introduce a typed variable** when none fits: give it a `type`, a
  `description`, and a safe `default` only when a default is genuinely sane
  (secrets and account-specific ids get NO default). Match the repo's existing
  file layout — add to `variables.tf` if the repo separates them, otherwise keep
  it next to the resource as the repo does.
- **Derive with `locals`.** Computed/repeated values (a name prefix, a merged tag
  map) belong in `locals`, referenced everywhere — not copy-pasted.
- **Never inline a secret, account id, ARN, or CIDR.** A "fix" that pastes a
  literal credential is itself a finding (and the secret-scan guardrail will
  block the push). Reference a variable or a secrets data source.

## Using Terraform modules (registry, private git libraries, your own)

Prefer a well-formed module over a pile of raw resources when one cleanly fits —
it carries the secure defaults for you. **Always call `list_modules` first**; it
returns three things: the operator's `module_catalogue`, the
`discovered_house_modules` (local modules already used in THIS repo), and a note.

Three source kinds you'll encounter, each pinned differently:

- **Public registry module** — `terraform-aws-modules/vpc/aws`. Pin with a
  `version = "~> 5.0"` argument. The big public collections
  ([terraform-aws-modules](https://registry.terraform.io/namespaces/terraform-aws-modules):
  `vpc`, `s3-bucket`, `rds`, `eks`, …) are the default when nothing is configured.
  A registry submodule is `…/aws//modules/log-group`.
- **Private git module library** — e.g.
  `git::https://github.com/acme/tf-modules.git//aws/s3?ref=s3-v0.1.2`. The
  `//aws/s3` selects the module within the repo and **`?ref=s3-v0.1.2` IS the
  version pin** (git modules have no `version` argument). Keep the exact `ref`;
  never float it. Many orgs (e.g. UKHSA's `data-integration-terraform-modules`)
  ship a whole library this way, tagged per-module.
- **House module** — one of the repo's own `modules/<name>` dirs. `list_modules`
  surfaces these under `discovered_house_modules` with their caller files — reuse
  the existing one with its **real variable names** (read its `variables.tf`)
  rather than re-implementing it.

Rules: use the module's **exact variable names**, set the secure-relevant inputs
the concern is about, and keep the version **pinned**. Don't introduce a module
mid-remediation just to "improve" things — using a module is right when
*generating* new infra or when the fix is genuinely a module swap; for a one-line
security fix on an existing raw resource, fix the resource in place.

### Authoring a reusable module (standard layout)

When you GENERATE a reusable module, follow the conventional layout real module
libraries use so it's drop-in familiar:

- `main.tf` (resources), `variables.tf` (every input typed, with a `description`
  and a `validation` block where it helps), `outputs.tf`, `versions.tf` /
  `providers.tf` (`required_version` + `required_providers` pinned), `README.md`
  (usage + inputs/outputs), and a `CHANGELOG.md` if the repo versions modules.
- Do **not** generate `examples/` fixtures. Document usage in the module's
  `README.md` instead; test coverage comes from the opt-in terratest scaffold
  (see below), which plans the module directly.

### Module-source-aware fixes (§4.14)

Before fixing a concern, call `terraform_module_graph` to see where the file
lives in the module call-graph:

- **Concern inside a LOCAL module dir** (listed in `local_module_dirs`): fix it
  **once at the module source**. The fix propagates to every caller — do not
  patch each call site. Note the callers in the PR body so a reviewer sees the
  blast radius.
- **Concern that would require editing a REGISTRY / git / remote module**: that
  source lives outside this repo — you **cannot** fix it here. Do **not** vendor
  the module or fork it inline. Instead report it (open an issue / PR comment)
  naming the upstream module + version and the concern, so a human routes it.

## Tests for modules (§28)

Terramend does **not** create or edit `examples/` fixtures — leave any the repo
already ships untouched. Module test coverage is **opt-in** via the `terratest`
input:

- **Terratest (opt-in).** When the `terratest` input is enabled, call
  `scaffold_terratest` (module name + dir) to generate a plan-only Go
  [Terratest](https://terratest.gruntwork.io/) smoke test (`test/<name>_test.go`)
  **and** a Terraform-native `*.tftest.hcl` in the module's own `tests/` dir.
  Both plan the **module directly** (no example fixture). Write the returned files
  (the input also widens `allowed_paths` to permit them). If the repo already has
  a Terratest suite, update its options/assertions to match the new interface
  instead.

In all cases: Terramend **never runs** the tests — it holds no cloud credentials,
and Terratest needs Go + a real `apply`. It keeps the test source consistent with
the module and flags in the PR that the suite should be run in the user's
pipeline. **Never weaken an assertion or delete a test to go green.**

## Hard rules

- Only modify `*.tf` / `*.tfvars` (and, when `allowed_paths` permits — i.e. the
  `terratest` input is on — that module's test files). Never touch CI, application
  code, or unrelated config in a remediation PR.
- One concern per PR. If you notice other issues, leave them for their own runs.
- Never auto-merge. The PR is for a human to review.
- If you cannot fix a concern cleanly (it needs a human decision, or the secure
  default would break the stack), do **not** open a broken PR — report it
  instead with what's blocking.
