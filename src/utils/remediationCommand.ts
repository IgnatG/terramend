/**
 * §3.12 Comment-command interface. A developer can scope a remediation run from
 * a PR/issue comment that mentions the bot:
 *
 *   @terramend fix #3a9f1c2          → fix exactly one concern (by id or short id)
 *   @terramend fix all high-severity → fix every concern at/above a severity
 *   @terramend fix all               → fix everything (still bounded by max_prs)
 *   @terramend fix main.tf           → fix one file's group
 *
 * The parsing is pure + deterministic so the scoping doesn't depend on the
 * model's reading of the comment. The Remediate mode applies the parsed scope
 * (which group(s) to act on) instead of the default "highest-severity group".
 */

export type RemediationCommand =
  | { kind: "concern"; concernRef: string }
  | { kind: "severity"; severity: Severity }
  | { kind: "file"; file: string }
  | { kind: "all" };

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type Severity = (typeof SEVERITIES)[number];

/** the bot handles a mention can use (with or without the `[bot]` suffix). */
const MENTION = /@terramend(?:\[bot\])?\b/i;

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
  const concern = afterMention.match(/\bfix\s+#?([0-9a-f]{6,40})\b/i);
  if (concern) return { kind: "concern", concernRef: concern[1]!.toLowerCase() };

  return null;
}
