/**
 * §3.12 Comment-command interface. A developer can scope a remediation run from
 * a PR/issue comment that mentions the bot:
 *
 *   @terramend fix #3a9f1c2          → fix exactly one concern (by id or short id)
 *   @terramend fix all high-severity → fix every concern at/above a severity
 *   @terramend fix all               → fix everything (still bounded by max_prs)
 *   @terramend fix main.tf           → fix one file's group
 *
 * §26 Propose, then let me steer — when a non-trivial finding has several
 * genuinely distinct valid fixes, Remediate proposes 2–3 labelled strategies in
 * a comment instead of guessing, and the reviewer picks one by replying:
 *
 *   @terramend fix #3a9f1c2 with strategy B   → apply strategy B to that concern
 *   @terramend strategy 2                      → pick strategy 2 (concern from the thread)
 *
 * The parsing is pure + deterministic so the scoping doesn't depend on the
 * model's reading of the comment. The Remediate mode applies the parsed scope
 * (which group(s) to act on, and which strategy) instead of the default
 * "highest-severity group, agent's-choice fix".
 */

export type RemediationCommand =
  | { kind: "concern"; concernRef: string; strategy?: string }
  | { kind: "severity"; severity: Severity }
  | { kind: "file"; file: string }
  // §37 bulk remediation — sweep ONE scanner rule across every file it fires in
  // (one coherent PR via by-rule grouping). e.g. `@terramend fix rule CKV_AWS_23`.
  | { kind: "rule"; ruleId: string }
  // §26 — a bare strategy pick (e.g. an in-thread reply to a proposal); the
  // concern is resolved from the comment thread the run was triggered on.
  | { kind: "strategy"; strategy: string }
  | { kind: "all" };

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type Severity = (typeof SEVERITIES)[number];

/** the bot handles a mention can use (with or without the `[bot]` suffix). */
const MENTION = /@terramend(?:\[bot\])?\b/i;

/**
 * §26 — the canonical phrasing the proposal comment must tell reviewers to reply
 * with. Lives next to the parser that accepts it so the proposal template (in
 * the Remediate prompt) and the parser can never drift apart. `<concern-id>` and
 * `<A|B|C>` are placeholders the agent fills with the real id and the offered
 * strategy labels.
 */
export const STRATEGY_REPLY_HINT = "@terramend fix #<concern-id> with strategy <A|B|C>";

// a strategy label is a single letter (A–Z, normalised to upper) or digit (1–9),
// introduced by `strategy` / `option` / `approach`. The single-char + `\b` bound
// keeps it off prose ("a good strategy overall" has no single-char boundary).
const STRATEGY = /\b(?:strategy|option|approach)\s+#?([A-Za-z]|[1-9])\b/i;

function parseStrategyToken(text: string): string | undefined {
  const m = text.match(STRATEGY);
  if (!m) return undefined;
  const tok = m[1]!;
  return /[A-Za-z]/.test(tok) ? tok.toUpperCase() : tok;
}

/**
 * Parse a `@terramend fix …` command out of a comment body. Returns null when
 * the body isn't a recognised fix command (the run then falls back to its
 * default scope). Tolerant of surrounding prose — it scans for the mention then
 * the `fix` verb and its argument.
 */
export function parseRemediationCommand(body: string | undefined): RemediationCommand | null {
  if (!body) return null;
  if (!MENTION.test(body)) return null;

  // everything after the mention; we keep original case for the file/concern-ref
  // capture (the lower-casing happens per match).
  const afterMention = body.slice(body.search(MENTION));
  const isSeverity = (s: string): s is Severity => (SEVERITIES as readonly string[]).includes(s);

  // §37 bulk — `fix rule <rule-id>` / `fix all rule <rule-id>`. Checked FIRST and
  // gated on the explicit `rule` keyword so a scanner rule id (`CKV_AWS_23`,
  // `terraform_required_version`, `trivy:AVD-AWS-0088`) is never confused with a
  // severity word, a filename, or a hex concern id. Rule ids are case-significant
  // — kept verbatim. The fix sweeps that ONE rule across every file it fires in.
  const rule = afterMention.match(/\bfix\s+(?:all\s+)?rule\s+([A-Za-z][A-Za-z0-9_.:-]+)\b/i);
  if (rule) return { kind: "rule", ruleId: rule[1]! };

  // `fix all <sev>[-severity]` / `fix all` — but a NON-severity word after "all"
  // (prose like "fix all the bugs") is NOT the command: fall through rather than
  // silently treating it as "fix everything".
  const all = afterMention.match(/\bfix\s+all\b(?:\s+([a-z]+)(?:\s*-?\s*severity)?)?/i);
  if (all) {
    const trailing = all[1]?.toLowerCase();
    if (!trailing) return { kind: "all" };
    if (isSeverity(trailing)) return { kind: "severity", severity: trailing };
    // a non-severity word followed "all" → prose, not a command. fall through.
  }

  // `fix <sev>-severity` (without "all")
  const sevOnly = afterMention.match(/\bfix\s+([a-z]+)\s*-?\s*severity\b/i);
  if (sevOnly) {
    const sev = sevOnly[1]!.toLowerCase();
    if (isSeverity(sev)) return { kind: "severity", severity: sev };
  }

  // `fix <path>.tf` / `fix <path>.tfvars` — a specific file's group. Checked
  // BEFORE the concern-id form so an all-hex filename stem (e.g. `deadbeef.tf`)
  // isn't mis-read as a concern id.
  const file = afterMention.match(/\bfix\s+([^\s#]+\.tf(?:vars)?)\b/i);
  if (file) return { kind: "file", file: file[1]! };

  // `fix #<id>` or `fix <id>` — a concern id is hex (content hash, 6–40 chars).
  // §26 — carries an optional strategy label when the comment selects one.
  const concern = afterMention.match(/\bfix\s+#?([0-9a-f]{6,40})\b/i);
  if (concern) {
    const concernRef = concern[1]!.toLowerCase();
    const strategy = parseStrategyToken(afterMention);
    return strategy ? { kind: "concern", concernRef, strategy } : { kind: "concern", concernRef };
  }

  // §26 — a strategy pick with no `fix` verb (e.g. an in-thread reply). If the
  // reviewer still named a `#<id>`, keep it as a scoped concern; otherwise the
  // concern is resolved from the thread the comment lives on.
  const strategy = parseStrategyToken(afterMention);
  if (strategy) {
    const id = afterMention.match(/#([0-9a-f]{6,40})\b/i);
    return id
      ? { kind: "concern", concernRef: id[1]!.toLowerCase(), strategy }
      : { kind: "strategy", strategy };
  }

  return null;
}
