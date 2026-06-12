// changes to mode definitions should be reflected in docs/modes.mdx
import { REVIEWER_AGENT_NAME } from "#app/agents/reviewer";
import { type AgentId, formatMcpToolRef, terramendMcpName } from "#app/external";
import { FINDING_VERIFICATION_PASS, REVIEW_FINDING_PRECEDENTS } from "#app/reviewQuality";

export interface Mode {
  name: string;
  description: string;
  // step-by-step guidance returned when the agent calls select_mode.
  // custom user-defined modes supply this; built-in modes define it here.
  prompt?: string | undefined;
}

// Default user-facing summary format embedded in BOTH Review and
// IncrementalReview review bodies. The two modes share the preamble +
// cross-cutting + nitpicks shape; the only difference is scope (full PR for
// Review vs delta against the prior terramend review for IncrementalReview).
// Distinct from the agent-internal snapshot (action/utils/prSummary.ts) which
// has its own stable scaffold and is never shaped by user instructions — see
// selectMode.ts for the firewall.
export const PR_SUMMARY_FORMAT = `### Default format

The body has at most four parts in this exact order:

1. **Reviewed changes preamble** — one bolded inline lead-in describing what was reviewed in this run, a bullet list of the substantive changes, and an HTML comment carrying review metadata for downstream agents.
2. **Cross-cutting issue sections** (zero or more) — one \`### \` heading per concern, with a human-readable problem write-up and a collapsed \`<details>Technical details</details>\` block underneath.
3. **\`### ℹ️ Nitpicks\`** (only if there are nits worth surfacing in the body) — a flat bullet list, no technical-details block.
4. **\`Suppressed findings\` collapsed block** at the very bottom (only when the adversarial verification pass suppressed at least one 🚨/⚠️ candidate) — the one-line-per-finding audit trail for the false-positive filter.

Inline-vs-body split: concerns that anchor to a specific line go inline (use the \`comments\` parameter). Body \`### \` sections are reserved for concerns that **have no line to anchor to** — typically because the concern is about *absence* (something the diff should have done but didn't), *sequencing* (rollout / deletion / migration order), *design decisions only the human can make*, or *scope questions the diff implicitly raises but doesn't address*. A concern that anchors to a line but has broad implications still goes inline (use the technical-details block there to capture the implications — see Inline technical details below). If you found no non-anchorable concerns, the body has zero \`### \` issue sections — just the preamble + metadata.

## 1. Reviewed changes preamble

Open with a single bolded inline lead-in followed immediately by the bullet list (no \`### Key changes\` heading, no \`<b>TL;DR</b>\`):

\`\`\`
**Reviewed changes** — one sentence on what was reviewed in this run. For Review (initial), this is what the PR does and why. For IncrementalReview, this is what changed since the prior terramend review. Focus on intent, not mechanics.

- **Short human-readable title** — 1 sentence per substantive change. Write a short prose phrase; when you name a file, type, or function, put that name in backticks (e.g. **Add \\\`TodoTracker\\\` for live checklists**). A reviewer should understand the full reviewed scope from this list alone — this IS the dispassionate "what was reviewed and what changed" overview, so cover the substantive changes, not just the loudest ones.

<!--
Terramend review metadata — for any agent (or human-with-agent) reading this
review. Incorporate the fields below into your understanding of the context
this review was made in. The findings below were written against
{head_sha_short}; if new commits have landed on {head_ref} since this review
was submitted, treat any specific bug, file, or line callout as POTENTIALLY
STALE — re-diff against {head_sha_short} (or trigger a fresh review) and
factor commits past {head_sha_short} into your understanding of the current
state before acting on findings.

- Mode: Review (initial)   or   IncrementalReview (delta against prior terramend review)
- Files reviewed: {file_count}
- Commits reviewed: {commit_count}
- Base: {base_ref} ({base_sha_short})
- Head: {head_ref} ({head_sha_short})
- Reviewed commits:
  - {sha_short} — {commit_subject}
  - ...
- Prior terramend review: none   or   {prior_sha_short} ({prior_review_html_url})
- Submitted at: {iso_timestamp}
-->
\`\`\`

Pull every metadata field from the \`checkout_pr\` tool's response — file count, commit count, base/head ref + SHA, the commit list. For \`IncrementalReview\` runs, populate \`Prior terramend review\` with the prior review's commit_id (short SHA) and \`html_url\` from \`list_pull_request_reviews\`.

## 2. Cross-cutting issue sections (zero or more)

For each cross-cutting concern, one \`### \` section. Use this exact shape:

\`\`\`
### {emoji} {short, descriptive title — what's wrong, not what to do}

{Human-readable problem write-up. Describes the PROBLEM only — what's broken, what the symptom is, what the blast radius is. NO asks, NO suggested fixes, NO "the right thing to do is...". Asks and fixes live in the technical-details block below; the visible part is for the human to *understand* the problem, not to implement it.}

<details><summary>Technical details</summary>

\\\`\\\`\\\`\\\`markdown
# {title repeated}

## Affected sites
- {file path:line} — {what's wrong there}
- ...

## Required outcome
- {what the fix needs to achieve, not how to achieve it}
- ...

## Suggested approach (optional)
{When the fix shape is non-obvious, sketch one or more reasonable directions. Skip when the outcome alone makes the fix obvious.}

## Open questions for the human (optional)
- {Any decision an implementing agent shouldn't make unilaterally — pricing thresholds, breaking-change policy, naming, scope of follow-up.}
\\\`\\\`\\\`\\\`

</details>
\`\`\`

Concrete example of the visible part of a non-anchored section (technical-details block unchanged from the template above):

\`\`\`
### ℹ️ Legacy \`opencode.ts\` has no documented deletion plan

The v2 harness lands alongside the v1 file and imports one helper from it. Worth a follow-up issue or a TODO so the next maintainer doesn't have to re-derive the cleanup plan.
\`\`\`

The example's value is its *shape*: a finding about absence (no deletion plan), not a line-anchored bug. Body sections live or die on whether the concern genuinely doesn't fit on a line.

**Heading severity emoji** — every \`### \` heading carries one:

- 🚨 critical — blocks merge (data loss, security, broken core flow)
- ⚠️ important — must address before merging (regression, missing validation, incorrect behavior)
- ℹ️ informational — surfaced for awareness; mergeable as-is

**Visible problem write-up rules:**

- **No asks, no suggested fixes** in the visible part. The visible portion describes the problem; the technical-details block describes the fix shape and any open questions. The exception: a fix so self-evident that NOT stating it would be weird (e.g. "the typo is missing an 'r'") — in that case, fold it into the problem statement and skip the suggested-approach block in technical details too.
- **Never two successive plain paragraphs.** Every transition between block-level elements must alternate prose with structure: paragraph → bullet list → paragraph; paragraph → code fence → bullet list; paragraph → table → paragraph. Two consecutive paragraphs in a row create a wall of text that's impossible to digest. If you catch yourself writing one, find a way to split it: pull a list out of it, drop a 2-3 line code fence between them, or merge them into a single tighter paragraph.
- **Per-paragraph budget:** ~3 sentences max. Past that, you're explaining where you should be structuring.
- **Identifier discipline still applies** in the visible part. Lead with behavior in plain English; name an identifier only when it's the subject of the concern or a public surface a reader would recognize. The technical-details block is where dense identifier references belong.

**Technical-details block rules:**

- Wrapped in a 4-backtick markdown fence (\`\\\`\\\`\\\`\\\`markdown ... \\\`\\\`\\\`\\\`\`) so it's visually distinct, one-click copyable, and can contain its own 3-backtick code fences without escape gymnastics. The contents are agent-readable — a fix-agent will pull the body down and use this block as the brief.
- File paths and \`file:line\` refs are encouraged (and necessary) — the next agent uses these to navigate. Identifier density is fine here.
- Slightly more verbose than the absolute minimum is OK when it materially helps the next agent: a small code snippet showing the symptom, a short table of mismatched key/column pairs, a one-paragraph "why CI doesn't catch it" note. Skip massive regression-test scaffolding or full route rewrites — the implementing agent writes those.
- Use the four standard sections (\`Affected sites\`, \`Required outcome\`, optional \`Suggested approach\`, optional \`Open questions for the human\`). Skip the optional sections when they wouldn't add anything.

## Inline technical details

Inline comments are short (~2-3 sentences) by default. When an inline finding has broader implications worth recording for a fix-agent — e.g. a localized bug whose proper fix requires touching several files, or where the right fix depends on a design decision the human needs to make — append a collapsed \`<details><summary>Technical details</summary>\` block to the inline comment's body. Same shape as the body-section technical-details block (4-backtick fenced markdown, \`## Affected sites\` / \`## Required outcome\` / optional \`## Suggested approach\` / optional \`## Open questions for the human\`).

GitHub renders the same markdown parser in inline comments as in the review body, so the collapsed-details affordance works the same way. The visible part of the inline comment stays scannable; the depth is one click away for any agent that needs it.

## 3. \`### ℹ️ Nitpicks\` (optional, last content section)

Only when there are nits that for some reason can't be inlined. Filepaths in nit text are fine — these are simple enough that a human or agent reads once and acts. No technical-details block.

\`\`\`
### ℹ️ Nitpicks

- {nit, with file path inline if useful, ≤ ~200 chars}
- ...
\`\`\`

## 4. \`Suppressed findings\` (optional, very last)

Only when the adversarial verification pass (see the checklist) suppressed at least one 🚨/⚠️ candidate. One collapsed block, always the last element in the body, with the count in the summary line:

\`\`\`
<details><summary>🗑️ Suppressed findings (2)</summary>

- ⚠️ \`networking/main.tf:42\` — claimed the subnet exposes the DB publicly — refuted: \`publicly_accessible = false\` at \`db.tf:18\`.
- 🚨 \`api/auth.ts:77\` — claimed JWT signature bypass — refuted: the unverified decode is dev-only, gated by the \`NODE_ENV\` check two lines above.

</details>
\`\`\`

One bullet per suppressed finding: severity emoji, \`file:line\`, the claim in a few words, the refutation in a few words. One line each — the block exists for auditability (a human catching the false-positive filter being wrong), not re-litigation. Omit the block entirely when nothing was suppressed.

## Inline comment shape

Inline comments use the same severity framing as body \`### \` sections, scaled down for line-anchored use:

- **Lead with a 1-2 sentence problem statement.** The reader is looking at the line in question, so don't restate what the line says — describe what's wrong with it. Optionally prefix the visible line with a severity emoji (🚨 / ⚠️ / ℹ️) when severity isn't obvious from context.
- **Optional \`<details><summary>Technical details</summary>...</details>\` collapsible** for findings whose technical context (longer file:line references, related-code snippets, suggested approach, regression-risk notes) would overwhelm the human-readable lead-in. Same agent-readable purpose, same 4-backtick fence shape, and same 4-section structure as the body's technical-details block — see *Inline technical details* above. Encouraged whenever the depth helps a downstream fix-agent; don't force one when the inline lead-in already says everything.
- **Visible portion ≤ 2-3 sentences.** If you find yourself writing more, that's the cue to split the depth into the \`Technical details\` collapsible.

## Body-wide rules

- **Inline-vs-body discipline (repeated for emphasis):** anything that anchors to a specific line goes inline (with a \`<details>Technical details</details>\` block when the implications are broad). The body is for non-anchorable concerns only — absence, sequencing, design decisions, scope questions, architectural risk.
- **No \`### Issues found\` heading** above the issue sections — each \`### \` heading IS the issue.
- **Severity emoji on every \`### \` heading** (🚨 / ⚠️ / ℹ️). No emoji on the preamble lead-in or anywhere else.
- **GitHub block-level rendering**: GitHub's markdown parser requires a blank line between ALL block-level elements (HTML tags like \`<br/>\`, \`<sub>\`, \`<details>\`, \`<b>\` and markdown syntax like headings, lists, blockquotes, code fences, paragraphs). Without a blank line, GitHub treats following content as a continuation of the HTML block and renders markdown syntax as literal text. ALWAYS separate block-level elements with a blank line.
- **Backtick-wrap** every variable, identifier, or file name when you mention one (in either visible or technical-details portions).
- **Don't repeat diff content**, don't include raw \`+123 / -45\` stats, don't include a changelog section, don't use horizontal rules (\`---\`).
- **Pull file/commit counts from \`checkout_pr\` metadata** — never count manually.
- **Legacy headings REMOVED.** Do not use \`### Key changes\`, \`### Issues found\`, \`<b>TL;DR</b>\`, or \`<sub><b>Summary</b>\`. The new structure subsumes them.`;

// Canonical body format for a Terramend REMEDIATION / GENERATION pull request.
// Distinct from PR_SUMMARY_FORMAT (which shapes a *review* body): this is the
// body of a PR Terramend OPENS. Every field maps to a deterministic tool result
// (terraform_scan / _validate / _plan / _verify_remediation / infracost_diff),
// so the body is evidence-built, never self-reported. Append this to the
// Remediate + GenerateTerraform prompts so every Terramend PR looks identical
// and a reviewer can scan it top-to-bottom in seconds.
export const REMEDIATION_PR_FORMAT = `### Remediation PR format

**Minimum (ALWAYS include, even under tight budget):** a one-paragraph plain-English summary of *what was wrong and what you changed*, then a \`## What changed\` list with one *Was / Changed / Safe because* note per concern, then the \`## Validation (✗ → ✓)\` list. If you produce nothing else, produce these three — a PR a human can't understand from its body alone has failed its job. Everything below enriches this minimum; it does not replace it.

Build the PR body in this EXACT order. Every line is backed by a tool result — never write a status you didn't get from a tool. Omit a whole section only when its tool didn't run (e.g. no plan without cloud creds); never fabricate it. Keep a blank line between every block-level element (GitHub needs it to render).

#### 1. Status banner (first line)

One GitHub alert blockquote that sets the reviewer's expectation, picked from the verification evidence:

- \`> [!CAUTION]\` — a \`needs-human\` signal fired: a regression (\`has_regressions\`), a stateful destroy/replace, a high blast radius, a non-deterministic plan, or a cost escalation. One sentence naming the reason.
- \`> [!WARNING]\` — verified but with a caveat (medium blast radius, a still-\`remaining\` concern, baseline-unavailable cost).
- \`> [!NOTE]\` — clean: \`verified: true\`, no regressions, low blast radius. One sentence: what was hardened.

#### 2. Title line + badges

A single bolded sentence naming the file/group and what was fixed, then a one-line badge row built from the tool results (drop any badge whose tool didn't run):

\`\`\`
**Hardened \\\`main.tf\\\` — S3 encryption + public-access block.**

\`Confidence: high\` · \`Blast radius: low (1 resource)\` · \`Plan: +0 ~1 -0\` · \`Idempotent: yes\` · \`Cost: +$0.00/mo\`
\`\`\`

Render \`Confidence\` verbatim from \`terraform_verify_remediation.confidence\` — never inflate it. Use \`·\` separators, backtick-wrap each badge.

#### 3. \`## What changed\`

One \`### \` subsection per resolved concern (or one per rule for a by-rule group), each with the §5.17 three-line micro-template and the rule linked to its docs (\`doc_url\`, else \`remediation_hint\`):

\`\`\`
### 🔒 [\\\`trivy:AVD-AWS-0088\\\`](https://avd.aquasec.com/misconfig/avd-aws-0088) — S3 bucket not encrypted

- **Was** — {the scanner's \`evidence\`, in plain English}.
- **Changed** — {what the fix did, one sentence}.
- **Safe because** — {why it's correct and non-breaking}.
\`\`\`

Lead each heading with a severity emoji (🚨 critical · ⚠️ high · 🔒 security · ℹ️ low/info). Backtick-wrap every identifier. No raw diff dumps — the Files tab shows the diff.

#### 4. \`## Validation (✗ → ✓)\`

Built ONLY from \`terraform_verify_remediation\`'s result — this is the proof, not a self-report. One line per id in \`resolved\`, then any still-open id honestly:

\`\`\`
## Validation (✗ → ✓)

- ✗ → ✓ \\\`trivy:AVD-AWS-0088\\\` resolved
- ✗ → ✓ \\\`checkov:CKV_AWS_19\\\` resolved
- ⚠️ still open: \\\`tflint:...\\\` — {why it couldn't be cleared}
\`\`\`

**Resolved XOR still-open — never both.** Each concern appears on exactly one line: an \`id\` in the tool's \`resolved\` set gets a \`✗ → ✓ … resolved\` line; an \`id\` in \`remaining\` gets a \`⚠️ still open: …\` line. NEVER write \`✗ → ✓ … re-flagged\` / \`✗ → ✓ … still open\` or otherwise mark an unresolved concern with the ✗→✓ symbol — that is a false attestation and the single worst thing this body can do. A concern is ✓ only if the tool returned its id in \`resolved\`; if it's in \`remaining\`, it is still-open, full stop.

If \`has_regressions\` is true, add a \`> [!CAUTION]\` **Regression** callout listing each id in the tool's \`regressions\` set BEFORE this list, and ensure the \`needs-human\` label is set. \`regressions\` are concerns the fix genuinely INTRODUCED (a new \`rule\`+\`file\` not present before) — they are computed line-independently, so a pre-existing concern that merely moved lines is NOT a regression; do not relabel a \`remaining\` concern as a regression.

#### 5. \`<details><summary>Plan</summary>\` (when \`terraform_plan\` ran)

Attach the full \`plan_text\` in a collapsed code block so a reviewer sees the exact change without re-running it:

\`\`\`
<details><summary>Terraform plan</summary>

\\\`\\\`\\\`
{plan_text}
\\\`\\\`\\\`

</details>
\`\`\`

When \`needs_human\` is true, surface \`needs_human_reasons\` as a visible bullet list above the \`<details>\` — don't bury an escalation in a collapsed block.

#### 6. \`## 🛡️ Prevent recurrence\` (optional follow-up)

From the scan's \`prevention\` map — the CI guardrail that stops this class of concern coming back. Clearly marked **not part of this PR's diff**: a short intro sentence then the \`mechanism\` + a fenced \`snippet\`. One entry per distinct rule.

#### 7. \`## Compliance\` (optional, when a crosswalk was run)

When \`terraform_compliance_crosswalk\` was called, add a short auditor-facing note: the frameworks/controls this fix touches (from \`by_framework\`), prefixed "Indicative alignment (crosswalk v{version}) — not an audit verdict." Skip entirely when the crosswalk wasn't run.

#### Body-wide rules

- **Evidence-built, never self-reported** — every badge, ✓, and count comes from a tool result. If a tool didn't run, omit its section; don't guess.
- **Blank line between ALL block-level elements** (callouts, headings, lists, code fences, \`<details>\`) — GitHub renders markdown as literal text otherwise.
- **Backtick-wrap** every file, rule id, resource address, and identifier.
- **No raw \`+N/-M\` diff stats, no horizontal rules (\`---\`), no changelog section.** The footer is appended automatically — don't add your own.
- **One scoped group per PR.** The body describes this group's fix only.`;

export function computeModes(agentId: AgentId): Mode[] {
  const t = (toolName: string) => formatMcpToolRef(agentId, toolName);
  return [
    {
      name: "Build",
      description:
        "Implement, build, create, or develop code changes; make specific changes to files or features; execute a plan; or handle tasks with specific implementation details",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **plan** (optional, for complex tasks): analyze requirements, read AGENTS.md and relevant code, produce a step-by-step implementation plan.

3. **setup**: checkout or create the branch:
   - **PR event, modifying the existing PR**: call \`${t("checkout_pr")}\`
   - **new branch**: use \`${t("git")}\` to create a branch (\`git checkout -b terramend/branch-name\`)

4. **build**: implement changes using your native file and shell tools:
   - follow the plan (if you ran a plan phase)
   - plan your approach before writing code: identify which files need to change, key design decisions, and edge cases. for non-trivial changes, consider whether there's a more elegant approach.
   - run relevant tests/lints before committing

5. **self-review**: judgment call — does YOUR diff warrant a fresh-eyes pass?

   Skip self-review (commit directly) when the diff is **genuinely trivial**:
   - doc typos, comment-only edits, whitespace/format-only, import reordering
   - lockfile or generated-code regeneration, mechanical rename whose only effect is import-path updates (size of diff is irrelevant — read the *shape*, not the line count)
   - low-risk dep patch bump from a trusted source

   Run self-review when the diff has **any behavioral surface, however small**:
   - 1-line changes to SQL operators / comparison logic / regexes / redirects / HTTP methods / response codes
   - any change to money / tax / currency / billing / fee / refund / payout calculations or constants
   - any change to auth / permissions / roles / sessions / tokens / signature verification
   - any change to feature-flag defaults, retry counts, timeouts, rate limits, batch sizes
   - new endpoints, new code paths, new error branches — even small ones
   - mixed diffs (whitespace + a single semantic line) — the semantic line still triggers self-review
   - anything you're uncertain about

   Tie-breaker: when in doubt, run self-review. One false-positive subagent dispatch costs cents; one false-negative shipped bug costs much more. There's no value in dispatching for a typo, but there's also no excuse for skipping on a 1-line change to a billing path.

   Otherwise delegate the \`${REVIEWER_AGENT_NAME}\` subagent to review your diff with fresh eyes against YOUR TASK. The subagent's baked-in system prompt enforces a non-mutative + non-recursive contract: read-only file/search/web tools and read-only MCP queries only; no writes, shell side effects, state-changing MCP calls, or nested subagent dispatch. Enforcement is prose-only — restate the constraint in your dispatch instructions and do not relax it.

   Before dispatching, ensure \`origin/<base>\` is locally available — the runner is often a shallow single-branch \`actions/checkout\` (depth=1, head-only refspec), and the reviewer's \`git diff --merge-base origin/<base>\` will fail with \`ambiguous argument\` or \`no merge base\` otherwise. Run \`git fetch --no-tags --deepen=1000 origin <base>:refs/remotes/origin/<base>\` once (the explicit destination refspec is required — a shallow single-branch checkout configures a head-only refspec, so a bare \`origin <base>\` only updates \`FETCH_HEAD\` and never creates the \`origin/<base>\` tracking ref); it's a no-op if the ref already has enough history. (The reviewer is read-only by contract, so it cannot do this itself — fetching is the orchestrator's job.)

   Compose your \`${REVIEWER_AGENT_NAME}\` dispatch prompt using this template verbatim, substituting the \`<...>\` placeholders. The preamble aligns the orchestrator side of the dispatch contract with the reviewer's baked-in system prompt — both ends say the same thing about where the work lives and what to do on an empty diff.

   \`\`\`
   ## What you're reviewing
   This is a PRE-COMMIT Build-mode self-review. The work to review lives in the working tree (uncommitted), NOT in committed history.

   Branch: <branch> (off <base>)
   Canonical diff command: git diff --merge-base origin/<base>

   Use \`--merge-base\` (single MCP \`git\` call, no shell substitution required). NOT bare \`git diff origin/<base>\` or two-dot \`git diff origin/<base>..HEAD\` — the symmetric forms include the inverse of every commit landed on \`<base>\` since this branch forked, which is noise (and the git tool will reject those forms when the divergence is detected). \`origin/<base>...HEAD\` (three-dot) and \`--cached\` both miss the uncommitted edits self-review runs on, so they're also wrong here.

   If the merge-base diff returns empty, treat it as "no changes — nothing to review" and stop per your system prompt. Do not search for the work elsewhere.

   ## Your task
   <YOUR TASK content>

   ## Build-phase failures
   <tight summary — what broke, root cause, the fix — or "no build-phase failures">
   \`\`\`

   Follow the template with the diff content (\`git diff --merge-base origin/<base-branch>\` — single MCP \`git\` call, captures committed + staged + unstaged, excludes base-branch progress) and your task brief. Instruct the subagent to flag bugs, logic errors, missing edge cases, gaps between request and diff, and unintended changes.

   Delegation + research discipline (distilled from \`/anneal\` canonical — these are codified learnings from many review rounds, not theoretical best practices):
   - Do NOT summarize what you implemented — that biases the subagent toward validating the shape of your solution rather than questioning it.
   - Do NOT curate a reading list of files. Let the subagent discover scope from the diff and codebase.
   - Do NOT pre-shape output with a severity / category schema. That leaks your hypotheses; severity is your call during evaluation.
   - Do NOT defect-hunt the diff yourself in parallel with the subagent. Your role is dispatch + evaluation; doing the review yourself reintroduces the implementation bias the subagent is meant to mitigate.
   - For diffs that rely on third-party API contracts, SDK semantics, framework directives, or DB engine specifics, instruct the subagent to verify load-bearing claims via web search and quote source URLs rather than trust training data — this is the single most common review-quality failure mode.

   Be **discerning** about what comes back. The reviewer is an AI subagent and is fallible — treat every finding as a hypothesis, not a directive, and **verify each one yourself** against the diff and the code before deciding whether to apply. You are searching for a solution that is **complete, minimal, and elegant** — you may need to think hard to find it. Do not over-engineer, do not be over-defensive, **do not write AI slop**. Reviewers bias toward *recommending additions*, and that bias has a recognizable slop texture: defensive checks for cases that cannot happen, extra logging, new abstractions used once, comments restating code, tests asserting tautologies, "just-in-case" guards, error handlers for cases the type system already rules out. Reject those. For each surviving finding, ask: would applying it leave the code more sound, correct, AND elegant? Two-out-of-three means look harder for a fix that gets all three before settling. After applying the fixes you accept, re-read your diff and be discerning about what *you just changed*: if any fix turned out to be bloat in context, revert it. Then verify only intended changes are present, no debug artifacts or commented-out code remain, no unrelated files were modified. Commit locally via shell (\`git add . && git commit -m "..."\`).

6. **finalize**:
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (see *SYSTEM* Git rules if this fails — prepush errors are usually the repo's tests/lint, not infra timeouts)
   - create a PR via \`${t("create_pull_request")}\`
   - call \`${t("report_progress")}\` with the PR link or the exact error if push/PR failed

### Notes

For simple, well-defined tasks, skip the plan phase and go straight to build.`,
    },
    {
      name: "AddressReviews",
      description:
        "Address PR review feedback; respond to reviewer comments; make requested changes to an existing PR",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Checkout the PR branch via \`${t("checkout_pr")}\`.

3. Fetch review comments via \`${t("get_review_comments")}\`.

4. For each comment:
   - understand the feedback
   - **verify the finding yourself** against the actual code before deciding whether to apply — every comment (human or agent) is a hypothesis, not a directive. agent reviewers especially are fallible.
   - you are searching for a solution that is **complete, minimal, and elegant** — you may need to think hard to find it. do not over-engineer, do not be over-defensive, **do not write AI slop**. reviewers bias toward *recommending additions*, and that bias has a recognizable slop texture: defensive checks for impossible cases, extra abstractions used once, comments restating obvious code, tests asserting tautologies, "just-in-case" guards, error handlers for cases the type system already rules out. reject those. evaluate whether applying the finding would leave the code more **sound, correct, AND elegant**; two-out-of-three is a signal to look harder for a fix that gets all three. if a request would add bloat — ceremony without commensurate correctness benefit — push back in your reply rather than mechanically applying it.
   - if the request stands, make the code change using your native tools; otherwise reply explaining why
   - record what was done (or why nothing was done)

5. Quality check:
   - test changes, then review the diff before committing — verify only intended changes are present, no debug artifacts remain, no fix turned out to be bloat in context (revert any that did), and the changes are clean enough that a senior engineer would approve without hesitation
   - commit locally via shell (\`git add . && git commit -m "..."\`)

6. Finalize. Reply + resolve are paired write actions: do BOTH or NEITHER for each thread.
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*)
   - **if push fails**, call \`${t("report_progress")}\` with the exact error and STOP — do NOT reply or resolve any thread until the fix is live on the remote. Resolving a thread without the fix landing misleads the reviewer.
   - **on push success**, for each thread you acted on:
     - reply ONCE via \`${t("reply_to_review_comment")}\`. The \`comment_id\` parameter takes the root comment's numeric \`id=\` (from the first \`comment author=...\` tag in the \`${t("get_review_comments")}\` output) — NOT the \`thread=\` value; that's a separate GraphQL ID used by resolve. The runtime dedupes identical bodies within a session.
     - **immediately** call \`${t("resolve_review_thread")}\` with that thread's \`thread=\` value as \`thread_id\`. Resolve every thread where you (a) made the requested code change in full — partial fixes leave the thread open — OR (b) replied with a substantive answer the user explicitly asked for. Do NOT resolve threads where you pushed back on the request and the disagreement is unresolved; leave those open for the human to mediate.
   - call \`${t("report_progress")}\` with a brief summary`,
    },
    // Review and IncrementalReview use a 0-or-2+ lens pattern. The default is
    // 0 lenses (orchestrator handles the review solo). Multi-lens (2+
    // reviewfrog subagents in parallel) only fires for substantive PRs or
    // high-stakes-subsystem touches — and when it fires, ALL lenses must
    // dispatch in a single assistant turn or the parallelism win disappears.
    // We never dispatch exactly one lens: a single lens is just a worse,
    // slower version of doing the work yourself.
    //
    // Build mode self-review is a different problem shape: the orchestrator
    // wrote the code, so bias-mitigation comes from delegating to one
    // fresh-eyes subagent that doesn't share the implementation context. A
    // single subagent there is appropriate; the 0-or-2+ rule applies only to
    // the Review/IncrementalReview lens fan-out where independence between
    // perspectives is what's being purchased.
    //
    // Severity categorization is split across two surfaces: the opening
    // callout (CAUTION/IMPORTANT/ℹ️/✅) sets the review's overall tier, and
    // per-bullet emoji prefixes (🚨/⚠️/ℹ️ in PR_SUMMARY_FORMAT) tag
    // individual points inside summary sections — scoping severity to the
    // specific bullet rather than the whole section keeps a section that
    // mixes a 🚨 and an ℹ️ from being mislabeled by either of them.
    {
      name: "Review",
      description:
        "Review code, PRs, or implementations; provide feedback or suggestions; identify issues; or check code quality, style, and correctness",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **checkout**: call \`${t("checkout_pr")}\` — this returns PR metadata and a \`diffPath\`. read the diff TOC end-to-end and treat its file line ranges as your coverage checklist.

3. **triage**: orient yourself on the PR — identify *what kind of thing this is* (domain it touches, seams it crosses, external contracts it depends on, user-facing surfaces it changes). pull as much context as you need to render a confident, well-grounded review: read related files, grep for callers of changed symbols, check tests that exercise the touched paths, fetch related GitHub state. **you are the synthesizer** — never delegate understanding to subagents.

   if the PR is **genuinely trivial**, skip the fan-out entirely and submit a \`No new issues found.\` review per step 7.

   "Genuinely trivial" (skip):
   - single-word doc typo, whitespace/format-only, comment-only across any number of files
   - lockfile or generated-code regeneration (size of diff is irrelevant — read the *shape*)
   - mechanical rename whose only effect is import-path updates
   - low-risk dep patch bump

   "Looks trivial but isn't" (do **NOT** skip — small diff, big blast radius):
   - any 1-line change to SQL / regex / auth / billing / permission / signature-verification code
   - flipping a feature-flag default, default config value, or retry/timeout constant
   - changing a money/tax/currency/fee constant by any amount
   - changing an HTTP method, redirect URL, response code, or status enum
   - tightening or loosening a comparison operator (\`<\` ↔ \`<=\`, \`==\` ↔ \`!=\`)
   - renaming a public API surface (still trivial in shape, but needs an impact lens)
   - adding a new direct dependency (supply-chain surface)
   - any "typo fix" in user-facing copy that changes meaning ("approved" → "denied")
   - mixed diffs where a semantic 1-liner is buried in whitespace/formatting changes

4. **lens decision — 0 or 2+, NEVER 1**.

   The default is **0 lenses**: handle the review yourself end-to-end. Most PRs land here.

   Dispatch **2+ \`${REVIEWER_AGENT_NAME}\` lenses in parallel** ONLY when ALL of the following are true:
   - the PR is substantive (>5 files changed AND >200 net lines), OR touches a high-stakes subsystem (auth, billing, payments, schema migration, webhooks, secrets, RBAC, multi-tenant isolation, cron/scheduling)
   - you can name 2+ distinct concrete failure modes that warrant independent lenses (one lens per failure mode; orthogonal, not overlapping)
   - parallel-orchestrated independent perspectives meaningfully outperform what you'd find solo

   **NEVER dispatch exactly one lens.** A single lens is just a more expensive version of doing the work yourself with a worse model — it adds wall time and a context-handoff for no orthogonality benefit. Either you have at least two genuinely independent failure-mode hypotheses (dispatch all in one turn), or you don't (do the review yourself).

   When you do go multi-lens, lens framings come in two flavors:
   - **themed lenses** — a perspective applied across the whole diff (correctness, security, user-journey, performance, etc.).
   - **subsystem lenses** — a domain-scoped frame for high-stakes subsystems the PR touches (e.g. "the auth lens", "the billing lens", "the schema-migration lens"). **for high-stakes domains, lead with the subsystem lens rather than the generic themed equivalent** — "billing-subsystem" outperforms "correctness on billing code" because the framing primes the subagent to remember domain-specific failure modes (double-charges, refund races, currency rounding, dispute flows) the generic lens misses.

   starter menu (combine, omit, or invent your own):
   - **correctness & invariants** — bugs, races, error handling, edge cases, state-machine boundaries
   - **impact** — stale references in code/tests/docs/configs/UI after rename/remove
   - **research-validated assumptions** — third-party API contracts, SDK semantics, framework directives, version-gated behavior. **only pick when the PR's correctness depends on the contract behaving a specific way** — not when the API is merely used. The bar is "if the third-party contract differs from what the diff assumes, the PR is incorrect." When dispatched, the subagent must verify load-bearing claims via web search and quote source URLs.
   - **security** — new endpoints, authZ, input validation, secrets handling, replay/CSRF/injection, cross-tenant isolation
   - **user-journey** — UX-touching flows: walk through happy path and failure modes as a user
   - **operational readiness** — observability, alerting, migrations (forward + rollback), feature flags, on-call burden
   - **integration & cross-cutting** — API contracts between modules, backward-compat of public surfaces, multi-service ordering
   - **test integrity** — meaningful coverage for the changed behavior; deterministic; no shared-state pollution
   - **performance** — N+1 queries, hot-path allocation, latency budgets, index coverage
   - **holistic** — does the PR make sense as a whole? symmetric flows (delete for every create, rollback for every migration)?
   - **subsystem lenses** (invent as the PR demands) — auth, billing, payments, schema migration, webhooks, secrets, RBAC, multi-tenant isolation, cron/scheduling, etc.

   The only subagent type is \`${REVIEWER_AGENT_NAME}\` — used for lens judgment work ("is this safe / correct / well-tested?"), runs on a mid-tier model.

5. **fan out (only if step 4 said 2+ lenses)**: dispatch every \`${REVIEWER_AGENT_NAME}\` subagent for this run **IN A SINGLE ASSISTANT TURN, AS MULTIPLE PARALLEL TASK TOOL_USE BLOCKS IN ONE MESSAGE.**

   ⚠️  CRITICAL — PARALLELISM IS THE ONLY REASON LENSES EXIST. ⚠️
   The default tool-call behavior of Claude Code (and most agent runtimes) is **serial dispatch**: emit one Task call, await result, emit next, await, etc. This collapses your fan-out into a sequential review where each lens adds N × (orchestrator-think-time + lens-execution-time) to wall time. **YOU MUST OVERRIDE THIS DEFAULT.** Emit ALL of your Task tool_use blocks in the SAME assistant message, BEFORE you read ANY result from ANY of them. If you find yourself emitting one Task call, then thinking about the result, then emitting another — STOP and re-issue them all together. The whole point of going multi-lens is the wall-clock speedup from parallel execution; serial dispatch defeats it entirely.

   ✅ Right pattern: one assistant turn with N Task tool_use blocks → wait → N results arrive together → aggregate.
   ❌ Wrong pattern: turn 1 = Task(lens A) → turn 2 (after A's result) = Task(lens B) → turn 3 (after B's result) = Task(lens C). This is the failure mode. Do not do this.

   You can also include your own \`read\` / \`grep\` / \`webfetch\` calls in the SAME turn as the parallel \`${REVIEWER_AGENT_NAME}\` dispatches — concurrent context-pulling on the orchestrator side runs in parallel with the lens fan-out and costs zero extra wall time.

   if a subagent errors out, times out, or returns nothing usable, retry once with the same lens; if it still fails, proceed with partial coverage and note the missing lens in the review body — do not skip the fan-out entirely on a single subagent failure. each subagent gets:
   - **the absolute \`diffPath\` (and \`incrementalDiffPath\` if available) from step 2's \`${t("checkout_pr")}\` return, named verbatim in the dispatch prompt** (e.g. \`diffPath: /tmp/terramend-XXXX/pr-NNN-SHA.diff\`). the reviewer's baked-in system prompt selects its FIRST action on this token — paraphrasing ("review the diff", "look at this PR") sends it down the \`git diff origin/<base>\` fallback, which fails on shallow GHA checkouts. the subagent \`read\`s those files for scope; it must NOT re-derive the diff via \`git diff\` (bare \`git diff origin/<base>\` is symmetric and pulls in the inverse of any commits that landed on \`<base>\` since the branch forked — pure noise, and the git tool rejects it). reading and codebase exploration are still its job.
   - **only one lens** — never a multi-section "review for X, Y, and Z" prompt
   - **a Task \`description\` set to the lens name** (e.g. \`"security"\`, \`"correctness"\`, \`"billing-subsystem"\`) — the harness reads this field to label the subagent's log lines so parallel runs can be told apart in CI output. without it, every subagent shows up as \`subagent#N\`.
   - if the lens touches external contracts, instruct the subagent to verify load-bearing claims via web search rather than trust training data, and to quote source URLs in its reasoning. action runs are non-interactive — there's no human in the loop to catch "I'm pretty sure Stripe does X."
   - ask the subagent to report findings with file paths and NEW line numbers from the diff so you can anchor inline comments without re-reading the entire diff.

   delegation discipline:
   - do NOT summarize the PR for them (biases toward a validation frame)
   - do NOT hand them a curated reading list (let them discover scope)
   - do NOT pre-shape their output with a finding schema
   - do NOT mention the other lenses (independence is the point — overlapping findings are a strong signal)

6. **aggregate & draft**: when the fan-out lands, merge findings; de-dup overlaps (two lenses catching the same issue = higher-confidence signal); trace each finding yourself before accepting it. drop praise, style preferences, speculative/unverified claims, findings about pre-existing code unrelated to the PR (heuristic: if the finding's root cause lives in lines this PR added or modified, it's in scope; otherwise drop unless the PR plausibly introduced or amplified the regression), and anything not actionable. also drop **bloat-shaped findings** — proposed fixes that would add defensive checks for cases that can't happen, abstractions used once, comments restating obvious code, tests asserting tautologies, or "just-in-case" guards. subagents are fallible and bias toward recommending changes; the bar for an actionable inline comment is sound + correct + elegant. recommending a change that improves only one of the three (or worse, degrades elegance to nominally improve correctness) makes the codebase worse, not better.

   Apply the **Finding precedents** (defined after this checklist, before the body format) to every candidate — a precedent match means drop, unless you have specific evidence the precedent does not apply here.

   **Hunt for non-anchored concerns before drafting.** After collecting your anchored findings, deliberately scan for concerns that have no specific line to point at — typically: deletion / cleanup plans for code the diff replaces or shadows; rollout sequencing (what happens to in-flight state during deploy / revert?); coverage gaps the diff implies but doesn't add; scope questions that only the human can answer (e.g. is the legacy path going away or is this a long-term dual track?); architectural risks the diff opens up that aren't a single-line bug. On substantial PRs (migrations, refactors, multi-file rewrites, version bumps that change runtime semantics), at least one such concern almost always exists; if you can't think of any, your bar is probably too high.

   ${FINDING_VERIFICATION_PASS}

   for surviving findings, draft inline comments with NEW line numbers from the diff — attach a \`<details>Technical details</details>\` block to any inline comment whose fix is non-trivial or has cross-file implications (see Inline technical details in the format below). every comment must be actionable, 2-3 sentences max in the visible part. use GitHub permalink format for code references. for impact-analysis findings (stale references after rename/remove), report them in the review body ordered by severity (runtime breakage > incorrect docs > stale comments) rather than as inline comments unless they're anchored to a specific line.

7. **submit**: ALWAYS submit exactly one review via \`${t("create_pull_request_review")}\`. Do NOT call \`report_progress\` — the review is the final record and the progress comment will be cleaned up automatically.

   note: the first create_pull_request_review submission may error with a one-time diff-coverage nudge listing unread TOC regions. retry the same call to proceed — optionally after reading the listed ranges. the pre-flight will not block again this session.

   The review body is structured as: \`[optional alert blockquote]\` → \`[PR summary using the default format below]\`. Inline comments are passed via the \`comments\` parameter, not in the body.

   The opening callout is what the author sees first — pick the one that matches what you want them to do. Five tiers, from loudest to friendliest:

   - \`[!CAUTION]\` — large red banner. Reads as "this will break something."
   - \`[!IMPORTANT]\` — large purple banner. Reads as "you need to look at this before merging."
   - \`> ℹ️ ...\` — informational blockquote. Reads as "minor suggestions, nothing blocking."
   - \`> ✅ ...\` — green friendly blockquote. Reads as "no concerns, mergeable."

   Two reinforcing levers: callout intensity (above) and \`approved\` (which gates the footer Fix-button affordance — Fix renders on every non-approving review, so \`approved: true\` suppresses it). Wrapping mergeable feedback in \`[!IMPORTANT]\` trains users to click Fix on reviews that don't need fixing. Pick the tier the author's actual next action justifies.

   - **critical issues** (blocks merge — bugs, security, data loss, broken core flows):
     \`approved: false\`. Body opens with \`> [!CAUTION]\\n> This PR introduces ...\`, followed by the PR summary. Include all inline comments via \`comments\`.
   - **must-address non-critical findings** (real consequences if shipped — incorrect behavior in non-critical paths, missing validation on user input, regressions the author should fix before merge):
     \`approved: false\`. Body opens with \`> [!IMPORTANT]\\n> ...\`, followed by the PR summary. Reserve this tier for findings with concrete fallout — do NOT use \`[!IMPORTANT]\` for nits, style preferences, or "consider also" suggestions. Include all inline comments via \`comments\`.
   - **minor suggestions only** (single-line nits, doc/comment polish, defer-able observations, "rough edges"):
     \`approved: false\`. Body opens with \`> ℹ️ No critical issues — minor suggestions inline.\\n\\n\` followed by the PR summary. Include all inline comments via \`comments\`. Vary the wording after the emoji to fit the review (e.g. "Minor suggestions only.", "Two rough edges worth a look."), but always keep the ℹ️ prefix and keep it short.
   - **informational observations** (mergeable as-is, nothing actionable — e.g. prior feedback addressed cleanly, surfacing a minor stale doc reference, calling out something noteworthy without recommending a change):
     \`approved: true\`. Body opens with \`> ✅ No new issues found.\\n\\n\` followed by the PR summary. Do NOT include inline \`comments\` — the ✅ signals "no action needed", which contradicts an actionable anchor; if a point is concrete enough to anchor to a line, downgrade the whole review to "minor suggestions only" (\`approved: false\`) instead.
   - **no actionable issues**:
     \`approved: true\`. Body opens with \`> ✅ No new issues found.\\n\\n\` followed by the PR summary.

${REVIEW_FINDING_PRECEDENTS}

${PR_SUMMARY_FORMAT}`,
    },
    // IncrementalReview shares Review's 0-or-2+ lens pattern AND its body
    // format (PR_SUMMARY_FORMAT), scoped to the incremental delta against the
    // prior terramend review. The "issues must be NEW since the last Terramend
    // review" filter lives at aggregation time (step 8), NOT in the subagent
    // prompt — pushing the filter into subagents matches the canonical anneal
    // anti-pattern of "list known pre-existing failures — don't flag these"
    // and suppresses signal on regressions the new commits amplified. A
    // separate "Prior review feedback" checklist would duplicate the rolling
    // PR summary snapshot's record of what earlier runs already addressed and
    // add noise to the user-facing body. Same opening-callout + per-bullet
    // emoji severity split as Review.
    {
      name: "IncrementalReview",
      description:
        "Re-review a PR after new commits are pushed; focus on new changes since the last review",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **checkout**: call \`${t("checkout_pr")}\` — this returns PR metadata, \`diffPath\` (full diff), and \`incrementalDiffPath\` (changes since last reviewed version, if available). read the diff TOC first and use its line ranges as your coverage checklist.

3. **incremental scope**: if \`incrementalDiffPath\` is present, read it to see what changed since the last review. this is a range-diff that isolates the net changes, filtering out base branch noise. if not present, fall back to reviewing the full PR diff and determine what changed since Terramend's most recent review.

4. **prior feedback — read AND retire it**: fetch previous reviews via \`${t("list_pull_request_reviews")}\`, then call \`${t("get_review_comments")}\` on each prior Terramend review. Each thread renders as a section whose first line is a fenced tag \`comment author=<login> id=<fullDatabaseId> review=<reviewId> thread=<graphqlId>\`; section headers carry \`[RESOLVED]\` / \`[OUTDATED]\` when relevant. For every **open, Terramend-originated** thread, decide and act:

   - **Terramend-originated** means the FIRST \`comment author=...\` tag in the section is \`author=terramend[bot]\`. The \`*\` marker on individual comments is unrelated — it flags whether a comment belongs to the queried review, not whether it is the thread root.
   - **addressed?** read the file at the thread's anchor and judge whether the substantive concern is now resolved by the new commits. Lines being modified isn't enough: reformatting, renaming, or moving the same code elsewhere doesn't address a concern. If the comment raised multiple distinct concerns, ALL must be addressed. The \`[OUTDATED]\` tag means GitHub moved the anchor (line shift, force-push, rename) — it does NOT mean the concern was addressed; re-read the code at its new location before deciding.
   - **if addressed**: call \`${t("reply_to_review_comment")}\` with the root tag's numeric \`id=\` as \`comment_id\` (NOT the \`thread=\` value — that's a separate GraphQL ID used only by resolve) and a one-line body (e.g. \`Addressed in <short-sha>.\`), then call \`${t("resolve_review_thread")}\` with the root tag's \`thread=\` value as \`thread_id\`. Do this BEFORE drafting the new review so the GitHub thread state aligns with the new review by the time it lands.
   - **if uncertain or partially addressed**: leave open. False-positive resolutions erode trust faster than false negatives.
   - **scope**: only retire Terramend-originated threads. Threads from human reviewers belong to those humans to resolve, even if the commit happened to address them.
   - **reaction signal**: comment tags may carry \`reactions=👍N,👎N\` — human votes on the finding. A 👎 on a Terramend-originated root comment is the human telling you the finding was wrong or unwanted: do NOT re-raise that finding class in this review, and treat it as false-positive feedback — when a LEARNINGS file is configured, record the rejected finding class (rule/pattern + why the human rejected it, if discernible) so future reviews stop flagging it. A 👍 confirms the finding class is valued; no action needed beyond noting it. Reactions never override the addressed/unaddressed judgment for retiring threads — a 👍 on an unfixed finding does not make it addressed.

   The remaining open threads feed step 8's dedup filter — anything already flagged and unchanged by the new commits should not be re-raised. The rolling PR summary snapshot is the durable record of retire activity; you don't need to surface it in the review body.

5. **triage**: orient on the *incremental* changes — domain, seams, external contracts, user-facing surfaces. pull as much context as you need to render a confident review: read related files, grep for callers of changed symbols, check tests that exercise the touched paths. **you are the synthesizer.**

   if the incremental changes are **genuinely trivial**, skip the fan-out entirely and jump to step 10's non-substantive path (do NOT submit a review).

   "Genuinely trivial" (skip): formatting/comment tweaks, import reordering, lockfile regen, mechanical rename of import paths, whitespace-only.
   "Looks trivial but isn't" (do NOT skip — same anti-patterns as Review mode): 1-line changes to SQL/regex/auth/billing/permissions/signature-verification code; flipping feature-flag defaults or retry/timeout constants; money/tax/HTTP-method/redirect changes; tightening or loosening a comparison operator; mixed diffs with a semantic line buried in formatting.
   When unsure, treat as non-trivial.

6. **lens decision — 0 or 2+, NEVER 1**.

   The default is **0 lenses**: handle the re-review yourself end-to-end. Most incremental reviews land here — especially thread-reply re-reviews where the user is asking "did you address X?" rather than "review the diff again."

   Dispatch **2+ \`${REVIEWER_AGENT_NAME}\` lenses in parallel** ONLY when ALL of the following are true:
   - the incremental changes are substantive (>5 files changed AND >200 net new lines), OR touch a high-stakes subsystem (auth, billing, payments, schema migration, webhooks, secrets, RBAC, multi-tenant isolation, cron/scheduling)
   - you can name 2+ distinct concrete failure modes the new commits plausibly introduce that warrant independent lenses
   - parallel-orchestrated independent perspectives meaningfully outperform what you'd find solo

   **NEVER dispatch exactly one lens.** Single-lens dispatch adds wall time and cost for no orthogonality benefit. Either go multi-lens (≥2 in parallel) or do the re-review yourself.

   Lens framing follows Review mode: themed lenses (correctness, security, etc.) and subsystem lenses (auth, billing, schema-migration, etc.) — for high-stakes domains lead with the subsystem lens.

7. **fan out (only if step 6 said 2+ lenses)**: dispatch every \`${REVIEWER_AGENT_NAME}\` subagent for this run **IN A SINGLE ASSISTANT TURN, AS MULTIPLE PARALLEL TASK TOOL_USE BLOCKS IN ONE MESSAGE.**

   ⚠️  CRITICAL — PARALLELISM IS THE ONLY REASON LENSES EXIST. ⚠️
   Default tool-call behavior is **serial dispatch**: emit one Task call, await result, emit next, await, etc. This collapses your fan-out into a sequential review where each lens adds N × (orchestrator-think-time + lens-execution-time) to wall time. **YOU MUST OVERRIDE THIS DEFAULT.** Emit ALL of your Task tool_use blocks in the SAME assistant message, BEFORE you read ANY result from ANY of them.

   ✅ Right pattern: one assistant turn with N Task tool_use blocks → wait → N results arrive together → aggregate.
   ❌ Wrong pattern: turn 1 = Task(lens A) → turn 2 (after A's result) = Task(lens B). This is the failure mode.

   You can also include your own \`read\` / \`grep\` / \`webfetch\` calls in the SAME turn as the parallel \`${REVIEWER_AGENT_NAME}\` dispatches.

   if a subagent errors out, times out, or returns nothing usable, retry once with the same lens; if it still fails, proceed with partial coverage and note the missing lens in the review body. each subagent gets:
   - **the absolute diff path(s) from step 2's \`${t("checkout_pr")}\` return, named verbatim in the dispatch prompt.** when \`incrementalDiffPath\` is present, name BOTH (\`incrementalDiffPath: /tmp/.../pr-NNN-SHA-incremental.diff\` then \`diffPath: /tmp/.../pr-NNN-SHA.diff\`) — the reviewer's baked-in prompt reads incremental first and uses full for context; when only \`diffPath\` exists, name it alone. the subagent \`read\`s those files; it must NOT re-derive via \`git diff\` (bare \`git diff origin/<base>\` is symmetric and pulls in the inverse of base-branch progress — pure noise, and the git tool rejects it), and paraphrasing ("review the new commits") sends it down that fallback, which also fails on shallow GHA checkouts. do NOT tell them to skip pre-existing issues — that suppresses regressions the new commits amplified; the "issues must be NEW" filter lives at aggregation time (step 8), not in the subagent prompt.
   - **only one lens** — never a multi-section "review for X, Y, and Z" prompt
   - **a Task \`description\` set to the lens name** — the harness reads this field to label log lines so parallel runs can be told apart.
   - if the lens touches external contracts, instruct the subagent to verify load-bearing claims via web search and quote source URLs.
   - ask the subagent to report findings with file paths and NEW line numbers from the full PR diff so you can anchor inline comments.

   delegation discipline:
   - do NOT summarize the changes for them (biases toward validation frame)
   - do NOT hand them a curated reading list (let them discover scope)
   - do NOT pre-shape their output with a finding schema
   - do NOT mention the other lenses (independence is the point)

8. **aggregate, draft, self-critique**: merge findings (yours + any subagent output if you went multi-lens); de-dup overlaps; trace each finding yourself. drop praise, style preferences, speculative/unverified claims, findings about pre-existing code unrelated to the new commits, anything not actionable, and anything that re-states prior review feedback (heuristic: if the finding's root cause lives in lines the *new commits* added or modified, it's in scope; otherwise drop). also drop **bloat-shaped findings** — proposed fixes that would add defensive checks for cases that can't happen, abstractions used once, comments restating obvious code, tests asserting tautologies, or "just-in-case" guards. subagents are fallible and bias toward recommending changes; the bar for an actionable inline comment is sound + correct + elegant. recommending a change that improves only one of the three (or degrades elegance to nominally improve correctness) makes the codebase worse, not better. To compute "lines the new commits added or modified": if \`incrementalDiffPath\` from step 2 is present, use it directly. Otherwise, take the prior Terramend review's \`commit_id\` (returned alongside each entry from \`${t("list_pull_request_reviews")}\` in step 4) and run \`git diff <prior-review-sha>..HEAD\` to isolate the lines added since that review.

   Apply the **Finding precedents** (defined after this checklist, before the body format) to every candidate — a precedent match means drop, unless you have specific evidence the precedent does not apply here.

   **Hunt for non-anchored concerns before drafting.** After collecting your anchored findings, deliberately scan for concerns that have no specific line to point at — typically: deletion / cleanup plans for code the new commits replace or shadow; rollout sequencing (what happens to in-flight state during deploy / revert?); coverage gaps the new commits imply but don't add; scope questions that only the human can answer (e.g. is the legacy path going away or is this a long-term dual track?); architectural risks the new commits open up that aren't a single-line bug. On substantial incremental diffs (migrations, refactors, multi-file rewrites, version bumps that change runtime semantics), at least one such concern almost always exists; if you can't think of any, your bar is probably too high.

   ${FINDING_VERIFICATION_PASS}

   draft inline comments with NEW line numbers from the full PR diff — attach a \`<details>Technical details</details>\` block to any inline comment whose fix is non-trivial or has cross-file implications (see Inline technical details in the format below). every comment must be actionable, 2-3 sentences max in the visible part.

9. **build the review body**: use the same default format as Review mode (preamble + optional cross-cutting \`### \` sections + optional \`### ℹ️ Nitpicks\` + optional suppressed-findings block) — scoped to the **incremental delta**, not the full PR. The "Reviewed changes" bullets describe what changed since the prior terramend review (each bullet starts with a past-tense verb, e.g. \`- Extracted shared CLI runtime into a single module\`). Do NOT include a separate "Prior review feedback" checklist — that's tracked in the rolling PR summary snapshot for the next agent run, and surfacing it in the user-facing body is noise (changes that addressed prior feedback are already covered by the Reviewed-changes bullets). In some cases you may receive a complete diff for the whole PR instead of an incremental one; when this happens, determine what changed since Terramend's most recent review yourself before drafting bullets.

10. Submit — every run must end with EXACTLY ONE of \`${t("create_pull_request_review")}\` (substantive review) or \`${t("report_progress")}\` (no-review acknowledgement). do NOT call \`create_issue_comment\` for review output.

   Same callout ladder as Review mode — \`[!CAUTION]\` (red, "will break") → \`[!IMPORTANT]\` (purple, "must address before merging") → \`> ℹ️ ...\` (informational, "minor suggestions only") → \`> ✅ ...\` (green friendly, "no concerns"). Same Fix-button lever: the footer renders a Fix button on every non-approving review, so \`approved: true\` suppresses it. Wrapping mergeable feedback in \`[!IMPORTANT]\` trains users to click Fix on reviews that don't need fixing — pick the tier the author's actual next action justifies.

   Follow these rules:
   - note: the first create_pull_request_review submission may error with a one-time diff-coverage nudge listing unread TOC regions. retry the same call to proceed — optionally after reading the listed ranges. the pre-flight will not block again this session.
   - IF NO NEW ISSUES, NON-SUBSTANTIVE CHANGES ONLY (trivial formatting, import reordering, comment tweaks): do NOT submit a review. Instead call \`${t("report_progress")}\` with a 1-2 sentence note explaining no review was warranted (e.g. "No new issues. Changes since last review are formatting-only."). this leaves a visible signal that the run completed.
   - ELSE IF NEW CRITICAL ISSUES (blocks merge — bugs, security, data loss, broken core flows): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens with \`> [!CAUTION]\\n> This PR introduces ...\`, followed by the PR summary using the default format below.
   - ELSE IF NEW MUST-ADDRESS NON-CRITICAL FINDINGS (real consequences if shipped — incorrect behavior, missing validation, regressions the author should fix before merge): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens with \`> [!IMPORTANT]\\n> ...\`, followed by the PR summary using the default format below. Do NOT use this tier for nits, style preferences, or "consider also" suggestions.
   - ELSE IF NEW MINOR SUGGESTIONS ONLY (single-line nits, doc/comment polish, defer-able observations, "rough edges"): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens with \`> ℹ️ No critical issues — minor suggestions inline.\\n\\n\` (vary the wording after ℹ️ to fit the review), followed by the PR summary using the default format below.
   - ELSE IF INFORMATIONAL OBSERVATIONS (mergeable as-is, but worth surfacing — e.g. prior feedback addressed cleanly with one minor stale doc reference, or a noteworthy positive observation): call \`${t("create_pull_request_review")}\` with \`approved: true\`, NO inline comments, and the review body. body opens with \`> ✅ No new issues found.\\n\\n\` (or similar friendly green opener), followed by the PR summary using the default format below. If a point is concrete enough to anchor to a line, downgrade the whole review to "minor suggestions only" (\`approved: false\`) instead — the ✅ signals "no action needed", which contradicts an actionable anchor.
   - ELSE IF NO NEW ISSUES, SUBSTANTIVE CHANGES (new functionality, behavior changes, or fixes to prior review feedback): call \`${t("create_pull_request_review")}\` to create a PR review. If all previous reviews have been properly addressed and no new issues were discovered, set \`approved: true\`. body opens with \`> ✅ No new issues found.\\n\\n\`, followed by the PR summary using the default format below.

${REVIEW_FINDING_PRECEDENTS}

${PR_SUMMARY_FORMAT}`,
    },
    {
      name: "Plan",
      description:
        "Create plans, break down tasks, outline steps, analyze requirements, understand scope of work, or provide task breakdowns",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Analyze the task and gather context:
   - read AGENTS.md and relevant codebase files
   - understand the architecture and constraints

3. Produce a structured, actionable plan with clear milestones.

4. Call \`${t("report_progress")}\` with the plan body. Do NOT set \`target_plan_comment\` — that flag is exclusively for revising an existing plan, and \`${t("select_mode")}\` will route you to a separate PlanEdit checklist when a prior plan comment exists for this issue.`,
    },
    {
      name: "Fix",
      description:
        "Fix CI failures; debug failing tests or builds; investigate and resolve check suite failures",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Checkout the PR branch via \`${t("checkout_pr")}\`.

3. Fetch check suite logs via \`${t("get_check_suite_logs")}\`.

4. **CRITICAL**: verify the failure was INTRODUCED BY THIS PR before fixing. If unrelated, abort and report.

5. Diagnose and fix:
   - read the workflow file, reproduce locally with the EXACT same commands CI runs
   - fix the issue using your native file and shell tools
   - verify the fix by re-running the exact CI command
   - review the diff before committing — verify only the fix is present, no debug artifacts, no unrelated changes. the fix should be clean enough that a senior engineer would approve without hesitation.
   - commit locally via shell (\`git add . && git commit -m "..."\`)

6. Finalize:
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*)
   - call \`${t("report_progress")}\` with the diagnosis and fix summary (or the exact push error if push failed)`,
    },
    {
      name: "ResolveConflicts",
      description: "Resolve merge conflicts in a PR branch against the base branch",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **Setup**:
   - Call \`${t("checkout_pr")}\` to get the PR branch.
   - Call \`${t("get_pull_request")}\` to identify the base branch (e.g., 'main').
   - Call \`${t("git_fetch")}\` to fetch the base branch.

3. **Merge Attempt**:
   - Run \`git merge origin/<base_branch>\` via shell.
   - If it succeeds automatically, confirm a clean working tree, push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*), and call \`${t("report_progress")}\` with a brief success note or the exact push error if push failed — **then stop; do not run steps 4–5.**
   - If it fails (conflicts), resolve them manually (continue to steps 4–5).

4. **Resolve Conflicts**:
   - Run \`git status\` or parse the merge output to find the list of conflicting files.
   - For each conflicting file: read it, find the conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`), understand the code context, and rewrite the file with the correct resolution. Remove all markers.
   - Verify the file syntax is correct after resolution.

5. **Finalize**:
   - Run a final verification (build/test) to ensure the resolution works.
   - \`git add . && git commit -m "resolve merge conflicts"\`
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*)
   - Call \`${t("report_progress")}\` with a summary of what was resolved (or the exact push error if push failed)`,
    },
    {
      name: "Remediate",
      description:
        "Bring a repository's Terraform up to best practice: scan with the deterministic check tools, then open one scoped, reviewable PR per concern that fixes it and proves it fixed (✗→✓).",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **scan**: call \`${t("terraform_scan")}\` to get the best-practice \`concerns\` plus \`groups\` — one group per file, each with a stable \`id\`, its \`file\`, the group \`severity\` (highest in the file), the distinct \`rule_ids\`, and the \`concern_ids\` it covers. If it reports zero concerns, call \`${t("report_progress")}\` with "Terraform already follows best practice — nothing to remediate." and **stop**.

   *Alternative concern source:* if the Assessor (terraform-reviewer) has already produced a \`findings.json\` **or a SARIF report** (Trivy/Checkov/tflint \`-o sarif\`) for this repo (one exists in the workspace, or \`$TERRAMEND_FINDINGS_PATH\` is set), call \`${t("read_findings")}\` instead — it auto-detects the format and returns the **same** \`{concerns, groups}\` shape, so the rest of this checklist is unchanged. Default to \`${t("terraform_scan")}\`; only use \`${t("read_findings")}\` when such a file is present (it returns \`found: false\` otherwise). Note that reviewer-exclusive findings (source \`reviewer\`) can't be re-verified by Terramend's scanners — see the prove-it step.

   *Multi-root repos (§MCP):* \`${t("terraform_validate")}\` and \`${t("terraform_plan")}\` are now **multi-root aware** — they automatically validate/plan **every** Terraform root in the repo (e.g. hepcare's \`terraform/\` + \`terraform/core/\`) and aggregate the result (see \`roots_validated\` / \`roots_planned\`), so you do **not** need to loop per-root yourself. Call \`${t("terraform_roots")}\` only when you want to see the root layout (or fix a concern that lives in one specific root).

3. **pick scope**: act on **one group per PR** (a group is all of one file's concerns — different scanners flag the same defect under different rules, so fixing per-file avoids a flood of near-duplicate PRs). Take the **highest-severity group first**. Unless the task explicitly asks for more, open **at most one PR this run**. Skip groups whose severity is only \`info\` unless asked. Use the \`terraform-best-practices\` skill for how to read each concern and apply the *minimal* fix.

   **Autonomy (§3.9)**: each group carries an \`autonomy\` field — \`auto\` (fix and open a normal PR) or \`needs-human\` (a security finding at/above the \`autonomy_threshold\`, or — once plan runs — a high blast radius). You still fix and open a PR for a \`needs-human\` group, but you MUST add the \`needs-human\` label (\`${t("add_labels")}\`), open the PR with \`approved: false\` framing, and put a prominent **⚠️ Needs human review** callout at the top of the body listing the group's \`autonomy_reasons\`. Never batch a \`needs-human\` group with others.

   **Dependency order & environment twins (§24 / §22)**: when a repo has local modules, \`${t("terraform_module_graph")}\` returns \`dependency_order\` — fix a shared/depended-on module BEFORE its dependents so sequenced PRs don't conflict. \`${t("terraform_roots")}\` returns \`environment_twins\` — parallel \`dev\`/\`staging\`/\`prod\` (or per-region) stacks that differ only by an environment segment; when the fixed file is one twin, note in the PR that the same fix should be offered for its twins (a separate PR per twin, honouring \`max_prs\`).

   **Grouping & batching (§3.11 / §3.10)**: groups default to one-per-file. When a single rule dominates across many files (e.g. "add \`tags\` everywhere"), re-scan with \`group_by: "rule"\` so it becomes ONE coherent group/PR instead of many. The scan's \`batch_plan\` tells you which low-risk groups are \`batchable\` (combine them into the single \`batch_plan.batch_branch\` PR when \`max_prs\` would otherwise be exceeded) and which are \`isolated\` (each gets its own PR for independent review/revert). Still honour \`max_prs\` and never batch a \`needs-human\` group.

   **Comment command (§3.12)**: when this run was triggered by a \`@terramend fix …\` comment, the triggering body is in your prompt — honour the requested scope INSTEAD of "highest-severity group": \`fix #<concern-id>\` → act only on the group containing that concern id; \`fix all <severity>-severity\` → set the scan \`severity_threshold\` to that level and act on those groups (up to \`max_prs\`); \`fix <file>.tf\` → act on that file's group; \`fix all\` → act on the highest-severity groups up to \`max_prs\`. If the comment isn't a recognised fix command, fall back to the default scope. A **strategy suffix** — \`fix #<concern-id> with strategy B\` (or a bare \`strategy B\` reply on a proposal thread) — additionally tells you **which** fix to apply: see §26 in step 4.

4. **for the chosen group**:
   - **base branch**: this run's base branch is resolved deterministically — \`${t("create_pull_request")}\` targets the \`base_branch\` input if set, else the repository's default branch (\`main\`, or \`master\`). You do not choose it; just **omit** the \`base\` argument when opening the PR (below) and it is filled in.
   - **idempotency**: the remediation branch is \`remediate/<group-id>\`. Before doing anything, check whether that branch or an open PR for it already exists (\`${t("git")}\` / \`${t("get_pull_request")}\`). If one exists, update it rather than opening a duplicate.
   - **branch**: create \`remediate/<group-id>\` from the **current HEAD** (the checkout that was just scanned) via \`${t("git")}\` (\`git checkout -b remediate/<group-id>\`). Do NOT switch to a different base first — branching from the scanned checkout keeps the PR diff to exactly your fix.
   - **honest refusal (§29 — decide BEFORE fixing)**: if the group's concerns appear in the scan's \`refusal_candidates\` (the fix needs a human decision — narrowing an IAM wildcard, a KMS key policy, a real ingress CIDR), do **not** guess a fix that could break the stack. Instead open a structured issue (\`${t("create_issue")}\`) describing the concern, why it isn't auto-fixed, and what a human should do, and skip the PR for that group. A proven fix or an honest refusal — never a guessed, unverifiable PR.
   - **propose, then let me steer (§26 — when there's no single right fix)**: distinct from §29 (which refuses a fix a human must *decide*), §26 is for a finding with **2–3 genuinely distinct, defensible fixes** that differ in trade-offs, not correctness (e.g. encrypt with an AWS-managed key **vs** a customer-managed KMS key; a narrow security-group rule **vs** a prefix list **vs** a VPC endpoint). When such a fork exists **and the triggering comment did not already select a strategy**, do **not** silently pick for the reviewer: via \`${t("create_issue_comment")}\` post one short comment listing the options as **A / B / C** — each a single line (what it does + its trade-off) — and ask the reviewer to reply \`@terramend fix #<concern-id> with strategy <A|B|C>\`. Then **skip the PR for this group** this run and note it in your final report (it resumes when the reviewer replies). When the comment **did** select one (\`fix #<id> with strategy B\`, or a bare \`strategy B\` reply on the proposal thread), apply **exactly** that strategy — don't second-guess it. Reserve this for real forks in the road; a fix with one obvious correct answer just gets made.
   - **fix**: edit the group's file(s), using your native file tools. For a by-file group that's the single \`file\`; for a **by-rule group (§3.11)** it's every entry in \`files\` (fix the one rule everywhere it fires). Resolve **every** concern in the group — when the scan's \`co_located\` shows several scanners flagged the same \`file:line\` (§30), they're one underlying defect: write ONE canonical fix and one explanation, not separate edits. **Only touch \`*.tf\` / \`*.tfvars\` files.** Make the smallest changes that clear the concerns — do NOT reformat or refactor unrelated code (see *SYSTEM* surgical-change rules). **Module-source awareness (§4.14):** call \`${t("terraform_module_graph")}\` first — if the concern's file is inside a \`local_module_dir\`, fix it ONCE at the module source (it propagates to all callers; note them in the PR); if the fix would require editing a registry/git/remote module, you can't fix it here — report it (open an issue naming the upstream module + version) instead. **Approved modules (§4.14):** call \`${t("list_modules")}\` and prefer a catalogue module (registry or house, pinned) when the fix is genuinely a module swap — but for a one-line fix on an existing raw resource, fix it in place. **Provider-major awareness (§4.15):** before introducing an argument or block, check \`terraform_validate\`'s \`providers\` list for the pinned \`major\` — argument names and valid blocks differ across majors. After the dir is init-ed (validate/plan ran), you can **verify an argument exists** for the installed provider with \`${t("terraform_provider_schema")}\` (pass the resource type + the arg names you added; it returns any \`unknown_args\` that would break \`plan\`). **Reusing a module?** call \`${t("terraform_module_interface")}\` on its dir to get its real \`variable\` names + which are required, so the \`module\` block you write is correct.
   - **fix QUALITY — a real fix, not a scanner-silencer (enterprise bar)**: the goal is infrastructure that is *actually* safer, not Terraform that merely stops tripping the scanner. Three rules:
     - **Secure defaults, never a hidden-insecure one.** When you parameterise a hardcoded value (§4.13), the new \`variable\`'s \`default\` must be the SECURE choice, or have **no \`default\`** (forcing the operator to set it). NEVER preserve the insecure value as the default — e.g. replacing \`cidr_blocks = ["0.0.0.0/0"]\` with \`var.allowed_cidr_blocks\` *defaulting to \`["0.0.0.0/0"]\`* is not a fix: the deployed behaviour is identical and you've just moved the problem somewhere a scanner may not see it. If the secure value genuinely needs a human decision, this is an honest-refusal (§29) / propose-then-steer (§26) case, not a default-to-insecure.
     - **Optional-input resources must be conditional.** If a fix adds a resource or block that only works when an OPTIONAL input is set (e.g. an HTTPS listener that needs \`var.ssl_certificate_arn\`, which defaults to \`null\`), gate it with \`count\`/\`for_each\` or a \`dynamic\` block so it is NOT emitted — and cannot break \`plan\`/\`apply\` — when the input is unset. Do not write an always-present resource that references a null/empty value, and never claim in the PR that something is "only active when set" unless the HCL actually makes it conditional. Remember \`${t("terraform_validate")}\` can pass on HCL that still fails at \`plan\`/\`apply\` — your claim of conditionality must be in the code, not just the prose.
     - **Modernise, don't perpetuate (§4.15).** Call \`${t("terraform_version_currency")}\` and, when you must add a \`required_providers\`/\`required_version\` block, pin a CURRENT supported major, not an ancient one chosen only to match legacy code. Flag (in the PR body, as a follow-up — not necessarily fixed in this scoped PR) deprecated patterns the scanners don't encode: the archived \`hashicorp/template\` provider + \`data "template_file"\` (modern: the built-in \`templatefile()\` function), \`aws_launch_configuration\` (→ \`aws_launch_template\`), and any provider/module pin that is several majors behind. A best-practice fix should not entrench an EOL provider.
   - **keep the module's tests/examples consistent (§28 — only when you fixed a reusable module)**: if the file(s) you changed live inside a \`local_module_dir\` (from \`${t("terraform_module_graph")}\`) AND your fix changed the module's public interface (added/removed/renamed a \`variable\`, tightened a type), call \`${t("terraform_module_tests")}\` with that module dir. It returns the module's existing \`examples/\` fixtures + \`terraform test\` (\`*.tftest.hcl\`) / Go Terratest files and the \`drift\` per asset — \`missing_required\` (a variable the asset must now set) and \`unknown_set\` (a variable the asset references that no longer exists). Update **exactly** the drifting assets so they match the new interface; **never weaken, delete, or comment out an assertion just to make a test pass** — a fix that breaks a module's contract is the test doing its job, so correct the fix or the fixture, not the assertion. \`examples/\` are \`*.tf\` (always within the push allow-list); native \`*.tftest.hcl\` / Go \`*_test.go\` files are only pushable when the \`terratest\` input is enabled — when it isn't and only those drift, note the needed test update in the PR body for a human rather than leaving the module's own tests broken. Skip this entirely for a one-off raw-resource fix that doesn't touch a module interface.
   - **validate**: call \`${t("terraform_validate")}\`. If it does not pass, fix what it reports or abandon this group — **never open a PR whose validate did not pass**. Its \`providers\` field carries the pinned provider majors (use them as above). It also returns \`unknown_arguments\` (§4.15-next): arguments you wrote that are NOT in the installed provider's schema and would break \`plan\` — treat any entry as a must-fix (correct the argument for the pinned major) even though \`passed\` doesn't gate on it. \`schema_checked: false\` means the schema wasn't available (rely on \`${t("terraform_plan")}\` then).
   - **policy gate (optional, §3.5)**: if the repo ships policy-as-code (a \`policy/\`, \`policies/\`, or \`.conftest\` dir of Rego), call \`${t("policy_check")}\` — it runs \`conftest\` against the plan JSON. It degrades green (\`ok: false\`) when conftest or a policy dir is absent. When it returns \`passed: false\`, treat it exactly like a failed validate: fix the violation (listed in \`failures\`) or label the PR \`needs-human\` and surface it — never push past a policy denial.
   - **plan (safety gate — do this BEFORE pushing)**: call \`${t("terraform_plan")}\`. It auto-skips (returns \`ran: false\`) when no cloud credentials / the terraform CLI are present, or init/plan can't complete — then carry on. When it returns \`ran: true\`, add a one-line **Plan** note to the PR body (e.g. \`Plan: +0 ~1 -0\`) and act on three signals:
     - **destroy/replace (\`has_destroy_or_replace\`)**: treat it as a stop sign — a best-practice remediation should rarely destroy or replace a resource. Any entry in \`stateful_destructive\` (a data-bearing resource: RDS, S3, EBS, a SQL database, …) will be **hard-blocked at \`${t("push_branch")}\`** by a code-level guardrail unless the operator set the \`allow_replace\` input for that address — so do not rely on narration: if the change would destroy/replace a stateful resource and that is not clearly intended, **abandon this group** and report it rather than attempting the push. List the \`destructive\` resources in your report either way.
     - **blast radius (\`blast_radius.tier\`)**: add it to the PR body (e.g. \`Blast radius: low (1 resource)\`). When the tier is \`high\` (more than 10 resources, or the change spans more than one module), add a prominent **⚠️ Large blast radius — review carefully** callout to the PR body so a reviewer knows this is not a one-line change.
     - **idempotency (\`idempotent\`)**: when it is \`false\`, the second plan disagreed with the first — a perpetual-diff smell (a non-deterministic value such as \`timestamp()\`/\`uuid()\`/an unkeyed \`random_*\`). **Prefer to fix the non-determinism or abandon the group**; if you still open the PR, surface \`idempotency_warning\` prominently as a **⚠️ Non-deterministic plan** caveat. (Note: this catches in-config non-determinism only — Terramend never applies, so a provider-normalisation perpetual diff can't be detected here.)
     - **needs-human (\`needs_human\`, §2.6→§3.9)**: when \`true\`, the plan crossed a deterministic escalation line (high blast radius, a stateful destroy/replace, or a non-deterministic plan — see \`needs_human_reasons\`). Add the \`needs-human\` label (\`${t("add_labels")}\`) and a louder callout.
     - **full plan (\`plan_text\`, §1.2)**: when present, attach it to the PR body as a collapsed \`<details><summary>Plan</summary>\\n\\n\\\`\\\`\\\`\\n…\\n\\\`\\\`\\\`\\n</details>\` block so a reviewer can see the exact planned change without re-running it.
   - **commit + push**: \`git add\` only the file you changed, commit with a message naming the file and the key rules (e.g. \`fix(tf): harden main.tf — S3 encryption + block public access\`), then \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*).
   - **open PR — with a COMPLETE body (MANDATORY)**: \`${t("create_pull_request")}\` (omit \`base\` — it resolves to the run's base branch above). The PR body is the primary deliverable a human reviews — open the PR **with a full body**, never a placeholder you intend to fill in later. At an absolute minimum the body MUST explain, in plain English: (a) **what was wrong** — each concern by \`rule_id\` + its \`evidence\`; and (b) **what you changed** to fix each one, and why it's safe. Build it with the **Remediation PR format** at the end of this checklist (status banner → title + badges → \`## What changed\` with the §5.17 *Was / Changed / Safe because* note per concern). ⚠️ \`${t("report_progress")}\` writes the GitHub Actions **job summary**, which is NOT the PR body — a good job summary does **not** substitute for a complete PR body. If you only have time/budget for one, the PR body wins.
   - **prove it (✗→✓)**: call \`${t("terraform_verify_remediation")}\` with the group's \`concern_ids\`. It re-runs the scanners and returns the authoritative \`resolved\` / \`remaining\` sets and a \`verified\` flag — this is the proof, do NOT eyeball a scan or self-report. Then \`${t("update_pull_request_body")}\` to add a "Validation" section built **from that result**: one \`✗ → ✓ <rule_id> resolved\` line per id in \`resolved\`, and list every id in \`remaining\` honestly as still-open. Never mark a concern ✓ unless the tool returned it in \`resolved\`. Act on two more fields it returns:
     - **regressions (§1.4)**: when \`has_regressions\` is true, the fix INTRODUCED new concerns (listed in \`regressions\`) that weren't there before — it traded one defect for another. Add a prominent **⚠️ Regression** callout listing them, add the \`needs-human\` label (\`${t("add_labels")}\`), and prefer reworking the fix to remove the regression before relying on the PR.
     - **confidence (§5.19)**: render the returned \`confidence\` (high/medium/low) as a one-line badge in the PR body (e.g. \`Confidence: high\`) with its \`confidence_reasons\`. It is computed deterministically from the verification evidence (verified + no regressions + plan idempotency + blast radius + cost) — report it verbatim, do NOT inflate it.
   - **per-finding explanation (§5.17)**: in the PR body, give each resolved concern a short three-line note — **Was** (what the scanner flagged, from its \`evidence\`), **Changed** (what your fix did), **Safe because** (why it's correct/non-breaking) — and hyperlink the \`rule_id\` to its documentation. The scan output carries a \`doc_url\` per concern (and \`doc_urls\` per group); use it, falling back to the concern's \`remediation_hint\` when no \`doc_url\` is present.
   - **compliance crosswalk (optional, §23)**: for a security-relevant fix, call \`${t("terraform_compliance_crosswalk")}\` with the group's \`concerns\` to get the UK/general frameworks + controls it touches (NCSC Cloud Principles, Cyber Essentials, NHS DSPT, Secure by Design, CIS, SOC 2). Add a short **## Compliance** note from \`by_framework\`, prefixed "Indicative alignment (crosswalk v{version}) — not an audit verdict." Skip when nothing maps.
   - **prevent recurrence (§21)**: the scan's \`prevention\` map gives a CI guardrail per \`rule_id\` (a Checkov hard-fail entry, a tflint rule, a \`trivy config\` gate, an \`fmt -check\` step). Add a short **🛡️ Prevent recurrence** note to the PR body with the suggested \`mechanism\` + \`snippet\` so the team can stop this class of concern coming back — clearly marked as an optional follow-up, not part of this PR's diff.
   - **cost impact (optional)**: call \`${t("infracost_diff")}\` to estimate the monthly cost change the fix introduces. It auto-skips (returns \`ran: false\`) when \`INFRACOST_API_KEY\` or the infracost CLI is absent — in that case add nothing. When it returns \`ran: true\`, add a one-line **Cost impact** note to the PR body from its result: e.g. \`💰 Cost impact: +$12.40/mo\` for an increase, \`-$3.10/mo\` for a decrease, \`no change\` when \`monthly_delta\` is 0, or \`~$X/mo (baseline unavailable)\` when \`monthly_delta\` is null. When it returns \`needs_human: true\` (§4.16 — the increase crossed the \`cost_increase_block_usd\` threshold), add the \`needs-human\` label (\`${t("add_labels")}\`) and surface \`cost_escalation_reason\` prominently so a large spend increase isn't merged blindly.

5. **guardrails** (always): one scoped PR per group, never a mega-PR spanning multiple files; **never auto-merge** and always leave the PR for human review; never modify files outside \`*.tf\` / \`*.tfvars\`.

6. **finalize**: call \`${t("report_progress")}\` once with a summary — which file/group was fixed, the PR link, and the ✗→✓ result (or the exact tool error if push/PR creation failed).

   **SARIF for code-scanning (optional, §3.5)**: when the workflow has a SARIF upload step (it grants \`security-events: write\` and runs \`github/codeql-action/upload-sarif\` on a \`terramend.sarif\`), call \`${t("terraform_emit_sarif")}\` once at the end so the full scan also lands in the repo's Security tab — complementary to the fix PR, not a replacement for it.

${REMEDIATION_PR_FORMAT}`,
    },
    {
      name: "RefreshRemediation",
      description:
        "Self-heal stale Terramend remediation PRs (§27): when a remediation PR's base branch has moved, re-derive the fix on the current base and force-update it, or close it if the concern is already resolved upstream. Best run on a schedule.",
      prompt: `### Checklist

This mode keeps already-open Terramend remediation PRs healthy. A remediation PR is "the current base + a minimal, proven fix"; when the base advances, the PR's diff is computed against an old base and the concern may have been resolved upstream. This sweep re-derives each stale fix on the **current** base (it never \`git merge\`s the base in — re-deriving avoids conflict resolution and keeps the PR diff to exactly the fix). The run starts checked out on the base/default branch.

1. **task list**: create your task list for this run as your first action.

2. **find stale PRs**: call \`${t("list_remediation_prs")}\`. It returns each open \`remediate/<id>\` / \`terramend/generate-<slug>\` PR with a \`recommended_action\`:
   - \`skip\` — the base hasn't moved; the fix is still current. Do nothing.
   - \`escalate\` — a human pushed commits to the branch; auto-refresh would overwrite their work. Add the \`needs-human\` label (\`${t("add_labels")}\`) and post ONE short comment (\`${t("create_issue_comment")}\`) noting the base moved and a manual rebase is needed. Never touch the branch.
   - \`refresh\` — the base advanced; act on it in step 4.

   If there are zero \`refresh\`/\`escalate\` PRs, call \`${t("report_progress")}\` with "No stale Terramend remediation PRs — all open fixes are current." and **stop**.

3. **scan the current base once**: call \`${t("terraform_scan")}\` (the checkout is on the base). This is the authoritative current-base concern set — you use it both to decide whether a stale PR's concern is already resolved and to re-derive the fix. Note each group's stable \`id\` (it matches the PR branch's \`<id>\`).

4. **for each \`refresh\` PR** (act on at most \`max_prs\` of them this run — process the highest-severity groups first; report the rest as deferred):
   - **do NOT \`${t("checkout_pr")}\`** the stale PR — you are re-deriving from the current base, not editing the old branch. Read the PR with \`${t("get_pull_request")}\` if you need its body/number.
   - **resolved-on-base? → close it**: look for a group in step 3's scan whose \`id\` equals the PR's \`group_id\` (for a by-rule/batch PR, match on the concern ids it covered). If **no** current group/concern corresponds, the concern was already fixed on the base (a human fix, or a base change removed the file) — the PR is redundant. Call \`${t("close_pull_request")}\` with a one-line \`comment\` explaining it's resolved on the base. Do not push anything for this PR.
   - **still present → re-derive the fix on the current base**:
     - **branch**: recreate the remediation branch at the current base HEAD via \`${t("git")}\` (\`git checkout -B remediate/<id>\`) — \`-B\` force-resets it to the just-scanned base so the diff is only your fix.
     - **fix → validate → plan → keep tests consistent (§28) → prove it**: apply the minimal fix for that group exactly as in **Remediate** step 4 (same \`${t("terraform_validate")}\`, \`${t("terraform_plan")}\`, \`${t("terraform_module_tests")}\`, and \`${t("terraform_verify_remediation")}\` gates, and the same guardrails — never open/keep a PR whose validate didn't pass, abandon a group that would destroy a stateful resource, etc.).
     - **force-update the PR branch**: \`${t("push_branch")}\` with \`force: true\` (the PR already exists; force-updating its branch refreshes it in place — do NOT open a second PR). The Terraform-only / secret / destroy guardrails still run at push time.
     - **refresh the body**: \`${t("update_pull_request_body")}\` rebuilt from the fresh \`${t("terraform_verify_remediation")}\` result (the Remediation PR format below), and add a one-line note that it was rebased onto the current base (\`<short-sha>\`) on this run.
   - Honour every Remediate guardrail: one scoped group per PR, never auto-merge, never modify non-\`*.tf\`/\`*.tfvars\` files.

5. **finalize**: call \`${t("report_progress")}\` once with a summary — how many PRs were refreshed, closed-as-resolved, or escalated, with their links (or the exact tool error if a push/close failed).

${REMEDIATION_PR_FORMAT}`,
    },
    {
      name: "GenerateTerraform",
      description:
        "Generate new Terraform from a plain-English requirement (or a description of desired infrastructure) so it starts best-practice: secure defaults, pinned versions, parameterised, validated, and opened as one reviewable PR.",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **understand the requirement**: read the prompt / issue body and restate, in your task list, exactly what infrastructure is being asked for (provider, resources, environment, constraints). If something that materially changes the Terraform is ambiguous (region, sizing, public vs private, naming), make the **most secure, conventional** choice and record the assumption for the PR body — do NOT invent unrequested resources or scope-creep.

3. **branch**: create \`terramend/generate-<short-slug>\` from the **current HEAD** via \`${t("git")}\` (\`git checkout -b terramend/generate-<short-slug>\`; slug from the requirement, e.g. \`terramend/generate-s3-static-site\`). The PR's base branch is resolved deterministically by \`${t("create_pull_request")}\` (the \`base_branch\` input, else the repository's default branch — \`main\`, or \`master\`) — you do not choose it; just omit the \`base\` argument when opening the PR.

4. **generate (best practice from the first line)**: write the Terraform with your native file tools, guided by the \`terraform-best-practices\` skill. Requirements:
   - **Only create \`*.tf\` / \`*.tfvars\` files** (a code-level guardrail blocks the push otherwise). Split conventionally — \`main.tf\` (resources), \`variables.tf\`, \`outputs.tf\`, \`versions.tf\` (pin \`required_version\` + \`required_providers\` with version constraints). Match the repo's existing layout when one exists.
   - **Secure by default, not as an afterthought**: encryption at rest and in transit, block public access, least-privilege IAM (no wildcard actions/resources), IMDSv2, private networking, logging/versioning where supported. No \`0.0.0.0/0\` to admin/database ports. No plaintext secrets.
   - **Parameterise**: expose environment-specific / likely-to-change values as typed \`variable\`s with \`description\`s and safe defaults; use \`locals\` for derived values. Never hardcode magic values.
   - **Prefer modules**: call \`${t("list_modules")}\` first — it returns the operator's \`module_catalogue\` AND \`discovered_house_modules\` (local modules already used in this repo). Build on those (registry, a private git module library, or a house module), using their exact variable names and pinning the \`version\` (a git module's pin is its \`?ref=\`). Otherwise use a well-maintained public registry module (e.g. the \`terraform-aws-modules\` collection, pinned) over hand-rolled resources when one cleanly fits.
   - **Module layout (§28)**: when you generate a **reusable module**, follow the standard layout (\`main.tf\` / \`variables.tf\` (typed + \`description\` + validation) / \`outputs.tf\` / \`versions.tf\` / \`README.md\`). Do **not** generate \`examples/\` fixtures. When building a \`module\` block that consumes an EXISTING module, call \`${t("terraform_module_interface")}\` on its dir first to use its real variable names. When the \`terratest\` input is enabled, also call \`${t("scaffold_terratest")}\` (module name + its dir; pass the module's variables from \`${t("terraform_module_interface")}\`) to generate a plan-only Go Terratest test **and** a Terraform-native \`*.tftest.hcl\` — both plan the module directly — and write the returned files. Terramend never runs the tests (no cloud creds) — note in the PR that they should be run in the user's pipeline.
   - **Tag** resources consistently where the provider supports it.

5. **validate (must pass before any PR)**: call \`${t("terraform_validate")}\` (fmt + validate + tflint). Fix whatever it reports — **never open a PR whose validate did not pass.**

6. **self-scan (the generated code must itself be clean)**: call \`${t("terraform_scan")}\`. Generated Terraform is meant to START best-practice, so the scan should report zero concerns in the files you wrote. If it surfaces any, fix them and re-scan until clean — or, if a concern is a deliberate, justified exception, call it out explicitly in the PR body. Do not ship generated code that trips the scanners.

7. **cost (optional)**: call \`${t("infracost_diff")}\` to estimate the monthly cost of what you're creating. It auto-skips when \`INFRACOST_API_KEY\` / the infracost CLI is absent. When it returns \`ran: true\`, add a one-line **💰 Cost impact** note to the PR body (for new infra the \`monthly_delta\` is the full cost of the addition).

8. **finalize**:
   - confirm a clean working tree (only your new \`*.tf\`/\`*.tfvars\` files), then push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*).
   - open a PR via \`${t("create_pull_request")}\` (omit \`base\` — it resolves to the run's base branch above). Use the **Remediation PR format** conventions (the same status banner + badge row + \`## What changed\` shape, and the body-wide rules) ADAPTED for generation: the body states the requirement, what was generated, the key best-practice choices (security defaults, parameters, modules, pinned versions) and any assumptions; the badge row carries \`Plan\`/\`Cost\` when those tools ran; and in place of the \`## Validation (✗ → ✓)\` section put a \`## Validation\` line stating \`terraform_validate\` passed and \`terraform_scan\` is clean (self-scan: 0 concerns).
   - **never auto-merge** — leave the PR for human review.
   - call \`${t("report_progress")}\` once with the PR link (or the exact tool error if push/PR creation failed).

${REMEDIATION_PR_FORMAT}`,
    },
    {
      name: "Task",
      description:
        "General-purpose tasks that don't fit other modes: answering questions, adding comments, labeling, running ad-hoc commands, or any direct request",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Analyze the task. For simple operations (labeling, commenting, answering questions, running a single command), handle directly — but your answer only reaches the user through \`${t("report_progress")}\` (step 4); raw assistant text is discarded.

3. For substantial work — code changes across multiple files, multi-step investigations:
   - plan your approach before starting
   - use native file and shell tools for local operations
   - use ${terramendMcpName} MCP tools for GitHub/git operations
   - if code changes are needed: review your own diff before committing — verify only intended changes are present, no debug artifacts remain, and the changes are clean enough that a senior engineer would approve without hesitation

4. Finalize:
   - if code changes were made, push to a pull request (new or existing) using \`${t("push_branch")}\` and \`${t("create_pull_request")}\` as needed. \`git status\` must be clean before you finish (see *SYSTEM* Git rules if push fails).
   - call \`${t("report_progress")}\` once with results — include exact tool errors if push or PR creation failed
   - if the task involved labeling, commenting, or other GitHub operations, perform those directly`,
    },
  ];
}

// static export for UI display — uses opencode format as the readable default
export const modes: Mode[] = computeModes("opencode");

/** built-in mode names in canonical casing. used to validate / canonicalize the
 * `mode` action input so a CI run can pin a mode deterministically instead of
 * relying on the agent's prompt-driven `select_mode` choice. mode names are
 * agent-independent (only the embedded tool refs differ per agent), so the
 * opencode-rendered list is the authoritative name set. */
export const BUILTIN_MODE_NAMES: readonly string[] = modes.map((m) => m.name);

/**
 * modes that legitimately never modify the working tree. used by the post-run
 * dirty-tree gate to suppress the "commit and push" nudge — those modes
 * complete by submitting a review (`Review` / `IncrementalReview`) or by
 * posting a Plan comment (`Plan`), not by touching files. any leftover in the
 * tree at end-of-run is incidental tool noise (e.g. a `node_modules/` from a
 * stray install attempt) on an ephemeral worktree; nudging the agent to
 * commit it would produce a spurious PR.
 */
export const NON_COMMITTING_MODES: ReadonlySet<string> = new Set([
  "Review",
  "IncrementalReview",
  "Plan",
]);
