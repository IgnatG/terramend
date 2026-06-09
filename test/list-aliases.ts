/**
 * emits a JSON array of { slug, agent, name } entries for one of two CI matrix
 * jobs. `agent` mirrors the harness the runtime would pick in production
 * (anthropic/* → claude, everything else → opencode).
 *
 * MODE=aliases (default) — every alias. consumed by `models-live`, which runs
 *   the cheap top-level CLI smoke per alias (`test/model-smoke.ts`) to
 *   validate resolution + auth.
 *
 * MODE=flagships — one standard-tier model per provider. consumed by
 *   `providers-live`, which runs the full harness smoke
 *   (`pnpm runtest smoke <agent>`) to validate provider-class tool-calling
 *   (e.g. Gemini schema sanitizer, OpenAI tool-call format). flagship slugs
 *   live in `providers.ts` alongside their per-provider coverage globs.
 *
 * Every keyed alias is smoked — including `openrouter/*` and keyed `opencode/*`
 * passthroughs. They look like routing-layer wrappers but each one is a
 * distinct catalog entry on models.dev (under the `openrouter` / `opencode`
 * provider sections) that can drift independently of the upstream provider
 * mirror — testing the direct google entry tells you nothing about whether
 * the openrouter mirror has the same model id. The only entries pruned are
 * routing slugs (bedrock/byok) whose `resolve` is a sentinel that picks the
 * actual model id from a per-run env var.
 *
 * usage:
 *   node test/list-aliases.ts
 *   MODE=flagships node test/list-aliases.ts
 *   MATRIX_FILTER=gemini node test/list-aliases.ts
 *
 * NOTE: the per-PR-precision matrix lives in `matrix.ts`, which calls into
 * this file. raw invocation here emits the unfiltered matrix.
 */
import { modelAliases } from "#app/models";
import { providers } from "./providers.ts";

export type MatrixEntry = {
  slug: string;
  agent: string;
  name: string;
};

function toMatrixEntry(alias: (typeof modelAliases)[number]): MatrixEntry {
  return {
    slug: alias.slug,
    agent: alias.slug.startsWith("anthropic/") ? "claude" : "opencode",
    // readable display name (GHA renders slashes awkwardly in matrix job titles)
    name: alias.slug.replace("/", "-"),
  };
}

const aliasBySlug = new Map(modelAliases.map((a) => [a.slug, a]));

export function buildAliasMatrix(opts: { filter?: string }): MatrixEntry[] {
  const filter = opts.filter ?? "";
  return modelAliases
    .filter((alias) => {
      if (filter && !alias.slug.toLowerCase().includes(filter)) return false;
      // routing slugs (bedrock/byok) need a per-run env var to pick the actual
      // model — there's no generic smoke test.
      if (alias.routing) return false;
      return true;
    })
    .map(toMatrixEntry);
}

export function buildFlagshipMatrix(opts: { filter?: string }): MatrixEntry[] {
  const filter = opts.filter ?? "";
  return providers
    .map((p) => {
      const alias = aliasBySlug.get(p.flagship);
      if (!alias) {
        throw new Error(
          `list-aliases: flagship "${p.flagship}" missing from modelAliases — update providers.ts`,
        );
      }
      return alias;
    })
    .filter((alias) => !filter || alias.slug.toLowerCase().includes(filter))
    .map(toMatrixEntry);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.env.MODE === "flagships" ? "flagships" : "aliases";
  const filter = process.env.MATRIX_FILTER?.trim().toLowerCase() ?? "";
  const matrix =
    mode === "flagships" ? buildFlagshipMatrix({ filter }) : buildAliasMatrix({ filter });
  process.stdout.write(JSON.stringify(matrix));
}
