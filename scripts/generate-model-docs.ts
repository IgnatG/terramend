/**
 * Generates `docs/models.md` from the alias registry in `src/models.ts`, so
 * the supported-model list in docs can never drift from the code: the catalog
 * is the single source of truth and the doc is a render of it.
 *
 * - regenerate: `pnpm docs:models` (or `node scripts/generate-model-docs.ts`)
 * - drift guard: `test/modelDocs.test.ts` re-renders and compares against the
 *   committed file, so CI fails when `models.ts` changes without a re-render.
 *
 * The renderer is exported (not just the CLI side effect) so the drift test
 * exercises the exact same code path that wrote the file.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ModelAlias, modelAliases, providers } from "#app/models";

function aliasNotes(alias: ModelAlias): string {
  const notes: string[] = [];
  if (alias.preferred) notes.push("**preferred** (auto-select pick)");
  if (alias.isFree) notes.push("free — no API key required");
  if (alias.hidden) notes.push("hidden — internal subagent target, not user-selectable");
  if (alias.fallback) notes.push(`deprecated — resolves via \`${alias.fallback}\``);
  if (alias.routing) notes.push(`routing entry — model id read from env (see below)`);
  if (alias.subagentModel) notes.push(`review subagents run on \`${alias.subagentModel}\``);
  return notes.join("; ");
}

function aliasRows(providerKey: string): string[] {
  return modelAliases
    .filter((a) => a.provider === providerKey)
    .map((a) =>
      [
        "",
        `\`${a.slug}\``,
        a.displayName,
        a.routing ? "_(from env)_" : `\`${a.resolve}\``,
        a.openRouterResolve ? `\`${a.openRouterResolve}\`` : "—",
        aliasNotes(a) || "—",
        "",
      ]
        .join(" | ")
        .trim(),
    );
}

export function renderModelDocs(): string {
  const lines: string[] = [];
  lines.push("# Supported models");
  lines.push("");
  lines.push("<!-- GENERATED FILE — do not edit by hand. -->");
  lines.push("<!-- Regenerate with `pnpm docs:models` after changing src/models.ts. -->");
  lines.push("");
  lines.push(
    "Terramend resolves models through the curated alias registry in",
    "[`src/models.ts`](../src/models.ts). Users select a model by **alias slug**",
    '(e.g. `anthropic/claude-fable`), which resolves to a concrete model id —',
    "so version bumps happen in the catalog, not in every workflow file.",
  );
  lines.push("");
  lines.push("## How model selection works");
  lines.push("");
  lines.push("The effective model for a run is resolved with this priority:");
  lines.push("");
  lines.push("1. **`TERRAMEND_MODEL` env var** — highest priority, an escape hatch that");
  lines.push("   overrides everything (including Bedrock/Vertex routing). Accepts an alias");
  lines.push("   slug or a raw specifier.");
  lines.push("2. **Dispatch payload `model`** — set per-run by `workflow_dispatch` JSON.");
  lines.push("3. **Action input `model:`** — the `with: model:` value in the workflow.");
  lines.push("4. **Repo settings `model`** — the stored per-repo default.");
  lines.push("5. **Auto-select** — when none of the above is set, the agent introspects");
  lines.push("   which models the available API keys can actually route (`opencode models`)");
  lines.push("   and picks the first match: a `preferred` alias if its provider key is");
  lines.push("   present, otherwise the first routable alias in catalog order.");
  lines.push("");
  lines.push("So: **providing only an API key (no model) gets you that provider's");
  lines.push("`preferred` model**; specifying a model explicitly always wins.");
  lines.push("");
  lines.push("Unknown slugs log a warning and fall through to auto-select. If a provider");
  lines.push("key is present but the requested model is not routable with it, the run");
  lines.push("fails loudly with the list of models the key can serve. If **no** key is");
  lines.push("present at all, the run falls back to the free model so it still produces");
  lines.push("value.");
  lines.push("");
  lines.push("### Agent harness routing");
  lines.push("");
  lines.push("- `anthropic/*` models with Claude Code auth (`ANTHROPIC_API_KEY` or");
  lines.push("  `CLAUDE_CODE_OAUTH_TOKEN`) run on the **Claude Code** harness.");
  lines.push("- Everything else runs on the **OpenCode** harness.");
  lines.push("- `TERRAMEND_AGENT=claude|opencode` overrides the routing.");
  lines.push("");

  for (const [key, config] of Object.entries(providers)) {
    lines.push(`## ${config.displayName} (\`${key}/\`)`);
    lines.push("");
    const envBits: string[] = [];
    if (config.envVars.length > 0) {
      envBits.push(`Env vars: ${config.envVars.map((v) => `\`${v}\``).join(", ")}.`);
    }
    if (config.managedCredentials?.length) {
      envBits.push(
        `CLI-managed: ${config.managedCredentials.map((v) => `\`${v}\``).join(", ")}.`,
      );
    }
    if (envBits.length === 0) envBits.push("No credentials required.");
    lines.push(envBits.join(" "));
    lines.push("");
    lines.push("| Slug | Display name | Resolves to | OpenRouter route | Notes |");
    lines.push("| ---- | ------------ | ----------- | ---------------- | ----- |");
    lines.push(...aliasRows(key));
    lines.push("");
  }

  lines.push("## Routing entries (Bedrock / Vertex)");
  lines.push("");
  lines.push("`bedrock/byok` and `vertex/byok` are **routing** aliases: instead of a fixed");
  lines.push("model id, they read the concrete id from a per-run env var —");
  lines.push("`BEDROCK_MODEL_ID` (an AWS Bedrock model id, e.g.");
  lines.push("`eu.anthropic.claude-opus-4-8`) or `VERTEX_MODEL_ID` (a Vertex Model Garden");
  lines.push("id). Anthropic ids route to the Claude Code harness; everything else goes");
  lines.push("through OpenCode's `amazon-bedrock` / `google-vertex` provider.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// pathToFileURL (not a `file://${argv[1]}` template) so the check also works
// on Windows, where argv[1] is a backslashed path with a drive letter.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outPath = join(scriptDir, "..", "docs", "models.md");
  writeFileSync(outPath, renderModelDocs());
  process.stdout.write(`wrote ${outPath}\n`);
}
