<!-- markdownlint-disable MD013 MD033 MD060 -->

# Terramend — Terraform Remediator adaptation map (forked from Pullfrog)

> **What this is.** A code-grounded, end-to-end map of how **Terramend** was built by forking the
> MIT-licensed [Pullfrog](https://github.com/pullfrog/pullfrog) agent runtime into a **standalone
> Terraform best-practices Remediator / Generator**. "Pullfrog" below refers to the upstream base we
> inherited from; the product itself is now Terramend (AGPL-3.0; the upstream MIT notice is preserved in
> `NOTICE`). Every change references the actual file it touches.
>
> **Scope decision (2026-06-04).** The Remediator does the work **on its own** — it does
> *not* depend on the Assessor. Its job: take a repo (or a request) and make sure the
> **Terraform follows relevant best practices**, opening scoped PRs that fix what's wrong.
> Integration with the reviewer ([`../terraform-reviewer`](../terraform-reviewer)) and other
> technologies (CI bootstrap, policy-as-code, threat modelling, non-Terraform IaC) are
> **explicit future work** — designed for, not built now (§7).
>
> **Build status (2026-06-04): Slices 0 + 1 landed, caveats hardened, relicensed + renamed.**
> Implemented: `src/mcp/terraform.ts` (the `Concern` model + `terraform_scan` / `terraform_validate`
> tools, registered in `src/mcp/server.ts`); the **Remediate** mode in `src/modes.ts`
> (scan → fix → validate → one PR per concern → ✗→✓); the `scan_scope` / `severity_threshold` /
> `max_prs` / `allowed_paths` inputs in `action.yml` + `src/utils/payload.ts`; the bundled
> `terraform-best-practices` skill; the scanner toolchain in the `Dockerfile`; a
> `fixtures/terraform-bad/` dogfood repo; and tests (`src/mcp/terraform.test.ts`, `src/mcp/guardrails.test.ts`).
>
> **Caveats now hardened** (`src/mcp/guardrails.ts`): `allowed_paths` is **code-enforced** at push time
> (Remediate-mode-only gate in `push_branch` — §3.H); `max_prs` is **code-enforced** in
> `create_pull_request`; `scan_scope=diff` is implemented in `terraform_scan` (degrades to full when no
> base branch is found).
>
> **Licence + name:** relicensed to **AGPL-3.0-or-later** (`LICENSE` + `NOTICE` preserving the upstream
> Pullfrog MIT notice); product renamed **Pullfrog → Terramend** across the codebase (MCP namespace,
> env-var prefix `TERRAMEND_*`, package name, command, branding). `pnpm typecheck` + `pnpm build` pass;
> the full test suite passes except 5 pre-existing Windows-environment failures (POSIX signals,
> `/bin/bash`, Unix file modes, case-insensitive env, nested-clone path) unrelated to these changes.
>
> **Layout + imports (2026-06-05):** all source lives under `src/` (config/tooling stays at root).
> Internal imports use the node-native **`#app/*` subpath alias** (package.json `imports` →
> `./src/*.ts`, extensionless), not tsconfig `paths` — the action runs TS source directly via node, so a
> bundler-only alias would break at runtime. `#app/*` resolves across node-runtime, tsc, esbuild, and
> vitest. Removed Pullfrog leftovers irrelevant to Terramend: `get-installation-token/`, the upstream-sync
> /publish/token-test workflows, and the `git-archaeology` skill.

---

## 0. Scope — what this fork becomes (now vs later)

**Now (this fork, standalone, Terraform-only):**

- **Remediate Terraform to best practice** — run the Terraform check tools itself, then open **one scoped PR per concern** that fixes security / style / structure / cost issues, validated before opening.
- **Generate Terraform to best practice** (B1) — plain-English / diagram → HCL that *starts* compliant (constrained to a house module catalogue when one is configured; sane defaults otherwise).
- **Self-validation loop (✗→✓)** — after a fix, re-run the same checks and show the issue resolved in the PR body.

**Later (designed-for, not built — §7):**

- Consume the reviewer's `findings.json` as an *alternative* concern source (the internal concern model below is shaped so this drops in).
- Other technologies / lenses: CI bootstrap (B2), policy-as-code (B3), threat model (B4), accessibility, non-Terraform IaC.

---

## 1. The spine — an internal "concern" model fed by the fork's own Terraform checks

Without the Assessor, the Remediator needs its **own ground truth** for "what's not best practice." Philosophy stays the same as the plan ("tools decide, LLM assists"): **deterministic Terraform scanners flag the problems; the agent applies the minimal, constrained fix.**

The fork runs these itself (all already standard, permissive-licensed, used by the Assessor too):

| Check | Best-practice dimension | Tool |
|---|---|---|
| `terraform fmt -check` | canonical style | terraform CLI |
| `terraform validate` | correctness | terraform CLI |
| tflint | idiomatic HCL, deprecations, provider rules | tflint |
| tfsec / checkov | security misconfig (encryption, public access, IAM) | tfsec, checkov |
| Infracost | cost awareness | infracost |

These normalize into one **internal `Concern` model** the agent acts on:

```jsonc
{
  "id",            // stable sha1(source|rule|file|line) — idempotency key (branch/PR naming)
  "source",        // tfsec | checkov | tflint | terraform-fmt | terraform-validate | infracost
  "rule_id",       // e.g. tfsec:aws-s3-enable-bucket-encryption
  "severity",      // critical | high | medium | low | info
  "category",      // security | style | correctness | cost
  "evidence",      // the scanner message (what's wrong)
  "location": { "file", "line" },
  "remediation_hint"
}
```

> **Why this exact shape:** it is a deliberate **subset of the reviewer's
> `findings.schema.json` v1.0** (`../terraform-reviewer/schemas/findings.schema.json`). The
> reviewer's findings are a *superset* (they add `lens`, `standard`, `control_id`, `state`).
> So when we integrate the reviewer later (§7), its findings map onto this same `Concern`
> with **zero change to the mode logic or MCP tools** — only the *source* of concerns swaps.
> Build the internal model now; get reviewer-compatibility for free later.

The fork's own scanner output is produced by a new `terraform_scan` MCP tool (§3.D). A future `read_findings` tool (reviewer) emits the same `Concern[]`.

---

## 2. Gap analysis — inherit vs build

| Capability | Pullfrog already gives us | What we add now |
|---|---|---|
| MCP server, git/GitHub ops (checkout, git, push, PR, comment, review, labels, shell) | ✅ `src/mcp/server.ts` (~32 tools) | New tools: `terraform_scan`, `terraform_validate`, `infracost_diff`, `list_house_modules` |
| Auto-fix / scoped PR flow | ✅ `src/modes.ts` Build/Fix | New **Remediate** + **GenerateTerraform** modes |
| Structured output (Zod/JSON-schema) | ✅ `src/mcp/output.ts`, `output_schema` input | Reuse for fix-plan preview + machine-readable result |
| Skills system | ✅ `src/skills/`, `src/utils/skills.ts`, `BUNDLED_SKILL_NAMES` | New **`terraform-best-practices`** + **`terraform-generation`** bundled skills |
| BYOK (Anthropic/OpenAI/Gemini/xAI/DeepSeek/OpenRouter/Moonshot) | ✅ `src/models.ts`, `src/utils/apiKeys.ts`, `byokFallback.ts` | (Copilot SDK backend — later, §7) |
| Sandboxed shell / Docker for running tools | ✅ `src/mcp/shell.ts`, `docker.ts` | Wire the Terraform toolchain into the image (§3.K) |
| **Own deterministic Terraform check layer** | ❌ | **Build** — `terraform_scan` → `Concern[]` |
| **Concern → minimal constrained fix** | ❌ | **Build** — Remediate mode + best-practices skill |
| **Self-validation loop (✗→✓)** | ❌ | **Build** — re-run `terraform_scan`, diff concern `id`s, render in PR body |
| **Guardrails** (no auto-merge, allow-list paths, one-PR-per-concern, idempotency) | ⚠️ partial (push validation, no merge tool) | **Build** — path allow-list, idempotency by `id`, `max_prs` |
| **Cost-aware PRs** (Infracost delta) | ❌ | **Build** — `infracost_diff` + PR-body section |

---

## 3. End-to-end change map

Ordered by subsystem. Each item: **file → change**.

### 3.A Action contract — `action.yml`

Current inputs: `prompt`, `timeout`, `model`, `cwd`, `push`, `shell`, `output_schema`, `token`. Add:

| New input | Purpose |
|---|---|
| `mode` | `remediate \| generate-terraform` — skip mode auto-select for headless CI. |
| `scan_scope` | `diff \| full` — scan changed files on a PR vs whole repo on a schedule. |
| `severity_threshold` | Minimum severity to act on (e.g. `medium`). |
| `house_modules` | Optional path/URL to the house module catalogue manifest (constrained generation). When unset, generation uses sane public-module/best-practice defaults. |
| `allowed_paths` | Glob allow-list the agent may modify (guardrail). Default: `**/*.tf`, `**/*.tfvars` only. |
| `max_prs` | Cap on PRs per run (batch guardrail). Default 1. |
| `infracost` | `enabled \| disabled` — attach cost delta to PRs (auto-enabled if `INFRACOST_API_KEY` present). |
| *(future)* `findings_json` | Reviewer handoff — **reserved, not implemented now** (§7). |

Keep `result`; add `concerns_fixed` / `prs_opened` outputs via `set_output`.

> Parse new inputs in **`src/utils/payload.ts`** (`resolvePayload`, near the existing `output_schema` read ~line 186) into `WriteablePayload`.

### 3.B Payload & modes wiring — `src/external.ts`, `src/utils/payload.ts`

- **`src/external.ts`** — add to the `PayloadEvent` union (~lines 249–264, alongside `fix_review` / `implement_plan`): `remediate_terraform`, `generate_terraform`. Add to `WriteablePayload` (~lines 267–296): `scanScope?`, `severityThreshold?`, `houseModulesPath?`, `allowedPaths?`, `maxPrs?`, `infracost?`.
- **`src/utils/payload.ts`** — map new inputs + the GitHub event into those members; standalone stays `unknown`.

### 3.C Modes — `src/modes.ts` (the workflows)

`computeModes(agentId)` (~lines 162–606); each mode's orchestrator guidance is returned by `select_mode` (`src/mcp/selectMode.ts`). **Add two modes:**

| New mode | Workflow (orchestrator guidance) |
|---|---|
| **Remediate** | `terraform_scan` → group `Concern[]` into scoped concerns (by file or rule) → for each (≤ `max_prs`, ≥ `severity_threshold`): branch `remediate/<concern-id>` → apply **minimal** fix using the `terraform-best-practices` skill, pinned to `allowed_paths` → `terraform_validate` + `fmt` → `infracost_diff` (if infra changed) → push → open **one** scoped PR → re-run `terraform_scan` on the branch → embed ✗→✓ in PR body |
| **GenerateTerraform** | parse requirement/diagram → `list_house_modules` (if configured) → generate HCL pinned to module paths/vars (or best-practice defaults) → `terraform_validate` + `infracost_diff` → PR with a plain-English explanation |

Register their committing/non-committing classification (`src/modes.ts` ~lines 621–625; both commit). Reuse Build's checkout/branch/push plumbing.

### 3.D MCP tools — `src/mcp/*.ts` + register in `src/mcp/server.ts`

Pattern (from `src/mcp/shared.ts`): arktype params + `tool({ name, description, parameters, execute })`, pushed into `buildCommonTools()` / `buildOrchestratorTools()` (`server.ts` ~lines 117–167). Run via the sandboxed `shell` (`src/mcp/shell.ts`).

| New tool (new file) | Purpose |
|---|---|
| `terraform_scan` (`src/mcp/terraform.ts`) | Run fmt-check + validate + tflint + tfsec + checkov over the workspace (scope = diff/full); normalize all output into the internal `Concern[]`; **group into scoped concerns**. The ground-truth source. |
| `terraform_validate` (`src/mcp/terraform.ts`) | `terraform fmt -check` / `validate` / `tflint` on changed files only — the gate before opening a PR (plan §9.2). |
| `infracost_diff` (`src/mcp/infracost.ts`) | Infracost baseline→branch £/month delta for the PR body (skipped gracefully if no key). |
| `list_house_modules` (`src/mcp/houseModules.ts`) | Read the house module catalogue manifest → exact module paths + variable names for constrained generation. Inert when `house_modules` unset. |
| *(future)* `read_findings` (`src/mcp/findings.ts`) | Reviewer handoff — emits the same `Concern[]`. **Reserved (§7).** |

### 3.E Skills — `src/skills/*/SKILL.md` + `src/utils/skills.ts`

A skill is `src/skills/<name>/SKILL.md` (frontmatter + body); discovery via `BUNDLED_SKILL_NAMES` (`src/utils/skills.ts` ~line 17); copied to agent skill dirs at runtime; bundled to `dist/skills/` by esbuild. **Add:**

- **`terraform-best-practices`** — the heart of the standalone value. Encodes: how to read a `Concern`, apply the *minimal* fix, prefer house/registry modules, naming + structure conventions, security defaults (encryption, no public access, least-privilege IAM), and what **not** to touch. This is the "best practices" content the user asked for. (Curate it like the reviewer's rule packs — it's the real asset.)
- **`terraform-generation`** — constrained HCL generation from house modules / best-practice defaults (B1).

The Remediate mode routes to the best-practices skill for every concern.

### 3.F Instructions / system prompt — `src/utils/instructions.ts`

`resolveInstructions(ctx)` assembles the prompt. **Add:**

1. A **CONCERNS** section (mirror the LEARNINGS seeding at `src/main.ts` ~lines 414–432) — inject the grouped concerns (or a TOC + a path the agent reads via `terraform_scan`).
2. **Remediation guardrails** in SYSTEM (priority order already security > user > event, ~lines 148–153): one scoped PR per concern (never a mega-PR); edits pinned to `allowed_paths`; minimal diff (don't refactor unrelated code — matches the repo `CLAUDE.md` "surgical changes"); **never auto-merge, always require human review**; `terraform_validate` before opening a PR; a cost/AI failure must not block the core fix (plan §9.2).

### 3.G Self-validation loop (✗→✓) — `src/modes.ts` guidance + `src/mcp/terraform.ts` + `src/utils/prSummary.ts`

After push, the Remediate guidance re-runs `terraform_scan` on the branch, compares returned concern `id`s against the targeted set, and renders a ✗→✓ table via `src/utils/prSummary.ts` / `src/mcp/pr.ts` (`update_pull_request_body`): each targeted `id` → was `severity` → now resolved/remaining. If a concern didn't flip, iterate (bounded) or note it honestly.

### 3.H Guardrails & idempotency — `src/mcp/git.ts`, `src/mcp/pr.ts`, new `src/utils/guardrails.ts`

- **Idempotency** — branch `remediate/<concern-id>`; before opening, list open PRs/branches and **update the existing one** instead of opening a duplicate.
- **Path allow-list** — enforce `allowed_paths` (default `**/*.tf`, `**/*.tfvars`); reject edits outside it. (Pullfrog validates push destinations in `src/mcp/git.ts` ~lines 67–129; add a path gate.)
- **No auto-merge** — Pullfrog has no merge tool; keep it that way; assert in guardrails.
- **`max_prs`** cap per run.

### 3.I PR rendering — `src/utils/prSummary.ts` / `src/utils/buildPullfrogFooter.ts`

Each PR body: the concern + rule cited; the ✗→✓ table; the Infracost delta (infra PRs); the plain-English explanation (generation). Reuse the existing footer.

### 3.J AI backend — unchanged for now

BYOK is already first-class (`src/models.ts`, `src/utils/apiKeys.ts`, `byokFallback.ts`). The **Copilot SDK backend** (`src/agents/copilot.ts` + `src/agents/index.ts` + `src/utils/agent.ts` route; add `"copilot"` to `AgentId` in `src/external.ts`) is deferred to §7.

### 3.K Toolchain in the image — `Dockerfile`, `src/prep/`

The Terraform tools must be on `PATH` for `terraform_scan`. Add to the `Dockerfile` (and document for self-hosted/Action runners): `terraform`, `tflint`, `tfsec`, `checkov`, `infracost`. Consider lazy install via `src/prep/` (mirrors `src/prep/installNodeDependencies.ts`) so a run without Terraform changes stays light.

---

## 4. Build sequence (dogfoodable)

1. **Slice 0 — scan + report (no edits).** Add the Terraform toolchain (§3.K) + `terraform_scan` (§3.D) → internal `Concern[]`; add the **Remediate** mode that only *reports* the concern plan + CONCERNS prompt section. → verify: run on a dogfood Terraform repo; agent prints what it would fix. **No generation risk.**
2. **Slice 1 — one fix PR per concern.** Wire Remediate to apply the minimal fix for one concern via the `terraform-best-practices` skill (constrained, allow-listed) → `terraform_validate` → push → one scoped PR; idempotency by `id`. → verify: a real tfsec/checkov issue becomes a green PR.
3. **Slice 2 — self-validation loop ✗→✓.** Re-run `terraform_scan` on the branch → ✗→✓ table in PR body. → verify: PR shows the concern flipping.
4. **Slice 3 — guardrails + batch.** Path allow-list, `severity_threshold`, `max_prs`, no-auto-merge; batch across concerns.
5. **Slice 4 — Infracost + generation (B1).** `infracost_diff` on PRs; `terraform-generation` skill + `list_house_modules` + GenerateTerraform mode.

## 5. Verify-as-you-go

Each slice ships with: a fixture Terraform repo under `fixtures/` with known issues; a test asserting the concern is detected (Slice 0), the PR diff fixes it and validates (Slice 1), and the re-scan flips it (Slice 2). Matches the repo `CLAUDE.md` "write a test that reproduces it, then make it pass."

## 6. Open questions (decide before coding)

1. **Scanner set for v1** — all of fmt/validate/tflint/tfsec/checkov, or start with the cheapest reliable subset (fmt + validate + tflint) and add security scanners in Slice 3?
2. **Concern grouping** — one PR per concern `id`, or group by `location.file`? (Affects branch naming + idempotency + review ergonomics.)
3. **House module catalogue** — does one exist already (see [`../terraform-aws-repo-examples`](../terraform-aws-repo-examples))? Its shape defines `list_house_modules` + constrained generation.
4. **Upstream sync** — keep this rebasable on `pullfrog/pullfrog` (minimise core edits, prefer new files + registration), or hard-fork (free to edit `src/modes.ts`/`server.ts` in place)?

## 7. Designed-for-later (not now)

- **Reviewer integration** — add `read_findings` (`src/mcp/findings.ts`) emitting the same `Concern[]` from `findings.json`; add the `findings_json` input. Mode logic + skills unchanged because the `Concern` model is already a subset of `findings.schema.json` (§1).
- **Other technologies** — CI bootstrap (B2), policy-as-code (B3), threat model via Threagile (B4), accessibility, non-Terraform IaC: each is a new mode + skill + tool, slotting into the same orchestration.
- **Copilot SDK backend** (§3.J) behind BYOK-first resolution.
- **Hosted dashboard POST** of run results.
