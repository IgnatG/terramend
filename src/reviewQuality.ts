/**
 * Review-quality controls for the Review / IncrementalReview modes: a curated
 * false-positive precedents list and an adversarial per-finding verification
 * pass. Both are embedded into the mode prompts (modes.ts) — the precedents
 * also travel verbatim inside every verification dispatch, since subagents
 * never see the orchestrator's prompt.
 *
 * Provenance: adapted from Anthropic's claude-code-security-review action
 * (MIT) — its hard-exclusion rules, its LLM-judge "PRECEDENTS" list, and the
 * /security-review slash command's refute-subagent pattern. See
 * CLAUDE-CODE-SECURITY-REVIEW-VS-TERRAMEND.md (workspace root) §5.1–5.2 for
 * the comparison that motivated this. Deliberate divergences from upstream:
 *   - CCSR judges findings via sequential direct API calls; we dispatch
 *     parallel read-only reviewfrog subagents (machine-gated, see
 *     agents/subagentToolGates.ts) so verification adds one round of wall
 *     time regardless of finding count.
 *   - CCSR's judge gates on a bare confidence number; we gate on an explicit
 *     verdict (confirmed/refuted/uncertain) plus confidence, because the
 *     verdict is what the orchestrator acts on and the number alone invites
 *     anchoring.
 *   - CCSR drops "secrets stored on disk" findings (handled by a separate
 *     pipeline there). Terramend reviews IaC where a hardcoded credential is
 *     a core finding, so that exclusion is intentionally NOT inherited.
 * Kept as-is from upstream: fail-open semantics (a broken verifier must
 * never silently swallow a true positive) and suppression auditability
 * (excluded findings are listed, never deleted).
 */

import { REVIEWER_AGENT_NAME } from "#app/agents/reviewer";

/**
 * False-positive precedents applied at aggregation time and inside every
 * verification dispatch. Each entry encodes a recurring FP class; a candidate
 * matching one needs specific evidence that the precedent does not apply, or
 * it gets dropped. Ordered: hard exclusions (never post) → general code
 * precedents → Terraform/IaC precedents → the final signal-quality bar.
 */
export const REVIEW_FINDING_PRECEDENTS = `### Finding precedents (false-positive control)

Apply these when deciding whether a candidate finding is worth posting, and include this whole section verbatim in every verification dispatch. Each precedent encodes a recurring false-positive class: a candidate that matches one is dropped unless you have specific evidence the precedent does not apply here.

**Hard exclusions — never post:**

- Denial-of-service / resource-exhaustion concerns without a concrete, cheap-to-trigger attack path: missing rate limiting, "unbounded" loops over trusted input, "could exhaust memory/CPU".
- Theoretical race conditions or timing attacks. Post a race only when it is concretely reachable and concretely harmful.
- Memory-safety findings (buffer overflow, use-after-free, OOB) in memory-safe languages — Rust, Go, JS/TS, Python, Java, HCL.
- Security findings whose anchor is a documentation file — a code snippet in \`.md\`/\`.mdx\` is not an attack surface. (Stale or incorrect docs remain valid *impact* findings; this exclusion is only for treating doc content as exploitable.)
- "Lack of hardening" with no vulnerability: code is not required to implement every best practice, only to avoid concrete flaws.
- Vulnerable-dependency reports based on version strings alone — dependency scanning is a separate pipeline with its own remediation flow.

**General precedents:**

- Environment variables, CLI flags, and workflow-dispatch inputs are operator-trusted. An attack that requires controlling them is invalid.
- A missing permission/auth check in client-side code is not a finding; the server is the enforcement boundary. The same applies to client-side input validation.
- React/Angular-class frameworks escape output by default — an XSS claim needs \`dangerouslySetInnerHTML\`, \`bypassSecurityTrustHtml\`, or an equivalent unsafe API in the diff.
- SSRF requires control of host or protocol; path-only control is not SSRF. Neither SSRF nor path traversal applies to purely client-side code.
- Command injection in shell scripts needs a named untrusted-input path; developer-invoked scripts taking developer-supplied arguments don't qualify.
- Un-sanitized user input reaching logs is log spoofing, not a vulnerability. A logging finding is valid only when it exposes secrets, credentials, or PII.
- UUIDs are unguessable; an attack that requires guessing one is invalid.

**Terraform / IaC precedents:**

- \`0.0.0.0/0\` **egress** is common and usually intentional — flag open **ingress**, or egress only with a concrete exfiltration concern attached.
- Values from \`*.tfvars\`, \`locals\`, and module input variables are operator-trusted; "what if this variable is malicious" is invalid without naming an untrusted writer.
- Missing encryption / versioning / access-logging on resources that demonstrably hold no sensitive data (short-retention log groups, test fixtures, scratch buckets) is ℹ️ at most, never 🚨.
- Unpinned provider or module versions are style feedback for first-party modules; ⚠️ only for third-party module sources, where the unpinned ref is supply-chain surface.
- Do not infer state drift, plan outcomes, or "this will destroy/replace the database" from static HCL — only \`terraform plan\` evidence supports those claims. Without plan evidence, phrase the concern as an open question, not a finding.
- Missing tags and naming-convention deviations are nitpicks, not findings.
- When a deterministic scanner rule covers the same issue (trivy \`AVD-*\`, checkov \`CKV_*\`, tflint), cite the rule id in the finding — that makes it ✗→✓ verifiable downstream instead of an unverifiable reviewer opinion.

**Signal-quality bar** — a surviving candidate must still answer yes to all three: Is there a concrete failure or attack path? Is it a real risk rather than a theoretical best practice? Could the author act on it exactly as written?`;

/**
 * Adversarial verification pass, spliced into the aggregation step of Review
 * and IncrementalReview (between the non-anchored-concern hunt and comment
 * drafting). The 0-or-2+ lens rule does not apply here — that rule buys
 * independence between discovery perspectives; verification is a per-claim
 * judgment with no orthogonality to purchase, so one finding = one dispatch
 * is correct even when there is exactly one finding.
 */
export const FINDING_VERIFICATION_PASS = `**Adversarial verification — required before posting any 🚨/⚠️ finding.** A candidate finding is a hypothesis until an independent pass has tried to kill it; your own trace is not independent, because you found it. For every candidate you intend to post at 🚨 critical or ⚠️ important, dispatch one \`${REVIEWER_AGENT_NAME}\` verification subagent — ALL of them in a single assistant turn as parallel Task tool_use blocks. One candidate = one subagent, and dispatching exactly one is fine here: the 0-or-2+ rule governs discovery lenses, where independence between perspectives is the point; verification is per-claim judgment with no orthogonality to buy. Skip verification only for:

   - ℹ️ informational findings and nitpicks (post on your own judgment), and
   - findings whose evidence is deterministic tool output — a scanner concern id, a failing test, a compiler/type error. Those re-verify mechanically and need no judge.

   Each verification dispatch contains, in order:
   - the absolute \`diffPath\` (and \`incrementalDiffPath\` when available) named verbatim — the reviewer's baked-in system prompt selects its first action on this token;
   - the single finding under test: file, line, intended severity, the claim, and the evidence you collected;
   - the **Finding precedents** section — plus any \`### Finding precedents — org addendum\` section from your instructions — included verbatim (the subagent cannot see your prompt);
   - this charge: "Attempt to REFUTE this finding. Read the actual code — do not trust the claim's description of it. Apply the finding precedents. Report a verdict (\`confirmed\` / \`refuted\` / \`uncertain\`), a confidence score 1–10, and a 2–3 sentence justification quoting the code that decides it. When the attack or failure path is theoretical rather than demonstrated, bias toward \`refuted\`."

   Set the Task \`description\` to \`verify:<file>:<line>\` so parallel verifications are distinguishable in CI logs. Asking for a verdict schema is correct here and does not violate the discovery-lens "no finding schema" discipline — the subagent is judging one claim, not exploring.

   Gate on what comes back:
   - \`refuted\` at confidence ≥ 7 → suppress the finding and record it for the audit trail.
   - \`uncertain\`, or \`refuted\` at lower confidence → re-read the decisive code yourself; either downgrade to ℹ️ with the uncertainty stated, or suppress. Do not post it at 🚨/⚠️.
   - \`confirmed\` → post it; fold the verifier's justification into the comment's technical-details block when it adds evidence.
   - errored / timed out / nothing usable → retry once; if it still fails, KEEP the finding and add \`verification unavailable\` to its technical details. Fail open: a broken verifier must never silently swallow a true positive, and must never block the review.

   Suppressed findings are recorded, never silently deleted — list every one in the \`Suppressed findings\` block at the bottom of the review body (shape defined in the format below): severity, \`file:line\`, the claim in a few words, the refutation in a few words. An unaudited filter eats true positives invisibly; the audit trail is what lets a human catch the filter being wrong.`;

/**
 * Heading under which `fp_filtering_instructions` (the action input carrying
 * org-specific FP precedents) is appended to the Review mode instructions.
 * FINDING_VERIFICATION_PASS names this heading when telling the orchestrator
 * what to include verbatim in each verification dispatch — the two strings
 * are a contract; change them together.
 */
export const FP_PRECEDENTS_ADDENDUM_HEADING = "### Finding precedents — org addendum";

/**
 * Merge the §5.5 action inputs into the per-mode user instructions that
 * `select_mode` appends to the mode prompt (see buildOrchestratorGuidance in
 * mcp/selectMode.ts). Both land on the "Review" key — IncrementalReview
 * inherits Review's instructions via modeInstructionParent. Composes with
 * (never replaces) backend-provided instructions: hosted settings and
 * workflow-file inputs are both repo-owner-controlled surfaces.
 */
export function mergeReviewModeInstructions(
  base: Record<string, string>,
  inputs: { reviewInstructions?: string | undefined; fpFilteringInstructions?: string | undefined },
): Record<string, string> {
  const review = inputs.reviewInstructions?.trim();
  const fp = inputs.fpFilteringInstructions?.trim();
  if (!review && !fp) return base;

  const sections = [base.Review, review];
  if (fp) {
    sections.push(
      `${FP_PRECEDENTS_ADDENDUM_HEADING}\n\nApply these alongside the built-in Finding precedents, and include this whole section verbatim in every verification dispatch.\n\n${fp}`,
    );
  }
  return { ...base, Review: sections.filter(Boolean).join("\n\n") };
}
