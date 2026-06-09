# Terramend examples

Copy-pasteable GitHub Actions workflows. Drop one into `.github/workflows/`, set
your BYOK model secret (e.g. `ANTHROPIC_API_KEY`), and pin `uses: <your-org>/terramend@v0`
to a release tag.

| File | What it does |
|------|--------------|
| [`remediate.yml`](remediate.yml) | The bread-and-butter: scheduled + on-demand remediation. Scans, fixes the highest-severity group, opens one ✗→✓ PR. |
| [`generate-terraform.yml`](generate-terraform.yml) | Generate new secure-by-default Terraform from a plain-English requirement (`mode: generateterraform`). |
| [`comment-fix.yml`](comment-fix.yml) | Trigger a scoped fix from a `@terramend fix …` PR/issue comment. |
| [`remediate-advanced.yml`](remediate-advanced.yml) | The production shape: adds SARIF → Security tab, the plan gate via a plan-only OIDC role, and the `policy_check` (conftest/OPA) gate. |
| [`remediate-dispatch.yml`](remediate-dispatch.yml) | On-demand run with `workflow_dispatch` inputs (severity / PR count) and an opinionated `prompt` that defines your "best practice" standard. Full toolchain + SARIF + conftest; demonstrates non-Anthropic BYOK (Gemini) via the `TERRAMEND_MODEL` passthrough. |
| [`all-inputs-reference.yml`](all-inputs-reference.yml) | **Reference (not a starter):** every action input + environment variable in one place, each at its default — copy only the lines you need. |

All install the scanner toolchain (terraform / tflint / trivy / checkov) — any that's absent is reported
*skipped*, never fatal. See the [main README](../README.md) for the full input reference, the guardrails,
and the minimal plan-only OIDC role. A complete end-to-end demo repo (a deliberately-flawed module + the
remediation workflow) lives in [`terraform-aws-repo-examples`](../../terraform-aws-repo-examples).

> **A note on the Node 20 deprecation warning.** If your run shows *"Node.js 20 actions are
> deprecated … actions/checkout@v4, hashicorp/setup-terraform@v3, …"*, that's GitHub flagging the
> **third-party setup actions**, not Terramend (the Terramend action itself already runs on Node 24).
> It's an informational notice — nothing breaks, and there's nothing you must do. These examples pin
> `actions/checkout@v6` (Node 24) to keep it quiet; the `setup-terraform` / `setup-tflint` / `setup-trivy`
> actions are maintained by their own vendors and will move to Node 24 on their own schedule.
