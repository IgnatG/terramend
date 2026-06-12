import { spawnSync } from "node:child_process";
import { type } from "arktype";
import type { LocalToolContext } from "#app/mcp/localContext";
import { execute, tool } from "#app/mcp/shared";
import { log } from "#app/utils/cli";
import { resolveEnv } from "#app/utils/secrets";

/**
 * Provider-schema awareness (§4.15 next). A "correct" fix for the wrong provider
 * major just breaks `plan` — argument names and nested blocks differ across
 * majors. After `terraform init`, the installed provider's exact schema is
 * available via `terraform providers schema -json`; this parses it so a fix can
 * be checked against the REAL attributes/blocks for the version in use, not the
 * model's memory of the provider.
 *
 * The schema fetch is cached per `cwd` for the process (schemas don't change
 * within a run) and degrades green (returns `ok: false`) when terraform isn't
 * installed or the dir isn't initialised.
 */

export interface ResourceSchema {
  attributes: Set<string>;
  blocks: Set<string>;
}

/** resourceType → its attribute + nested-block names, across all providers. */
export type ProvidersSchema = Map<string, ResourceSchema>;

interface RawBlock {
  attributes?: Record<string, unknown>;
  block_types?: Record<string, unknown>;
}
interface RawResourceSchema {
  block?: RawBlock;
}
interface RawProviderSchema {
  resource_schemas?: Record<string, RawResourceSchema>;
}
interface RawSchema {
  provider_schemas?: Record<string, RawProviderSchema>;
}

/**
 * Parse `terraform providers schema -json` into a resource-type → {attributes,
 * blocks} map. Merges every provider's `resource_schemas`. Pure; tolerant of a
 * missing/empty schema.
 */
export function parseProvidersSchema(json: string): ProvidersSchema {
  const out: ProvidersSchema = new Map();
  let parsed: RawSchema;
  try {
    parsed = JSON.parse(json || "{}") as RawSchema;
  } catch {
    return out;
  }
  for (const provider of Object.values(parsed.provider_schemas ?? {})) {
    for (const [resourceType, schema] of Object.entries(provider.resource_schemas ?? {})) {
      const attributes = new Set(Object.keys(schema.block?.attributes ?? {}));
      const blocks = new Set(Object.keys(schema.block?.block_types ?? {}));
      const existing = out.get(resourceType);
      if (existing) {
        for (const a of attributes) existing.attributes.add(a);
        for (const b of blocks) existing.blocks.add(b);
      } else {
        out.set(resourceType, { attributes, blocks });
      }
    }
  }
  return out;
}

/**
 * Given a resource type and the argument names a fix introduces, return the ones
 * that are NOT valid attributes or nested blocks for that resource in the
 * installed provider — i.e. names that would break `plan`. Returns `null` for
 * `unknownResourceType` when the schema has no entry for the type (can't judge).
 */
export function unknownArgsForResource(
  schema: ProvidersSchema,
  resourceType: string,
  args: string[],
): { unknownResourceType: boolean; unknown: string[] } {
  const res = schema.get(resourceType);
  if (!res) return { unknownResourceType: true, unknown: [] };
  const unknown = args.filter((a) => !res.attributes.has(a) && !res.blocks.has(a));
  return { unknownResourceType: false, unknown };
}

// per-process cache: cwd → parsed schema (schemas are stable within a run).
const schemaCache = new Map<string, ProvidersSchema | null>();

/** fetch + cache the providers schema for `cwd`. null when unavailable. */
export function loadProvidersSchema(cwd: string): ProvidersSchema | null {
  if (schemaCache.has(cwd)) return schemaCache.get(cwd) ?? null;
  const r = spawnSync("terraform", ["providers", "schema", "-json"], {
    cwd,
    encoding: "utf-8",
    env: resolveEnv("restricted") as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || r.status !== 0 || !r.stdout?.trim()) {
    schemaCache.set(cwd, null);
    return null;
  }
  const parsed = parseProvidersSchema(r.stdout);
  schemaCache.set(cwd, parsed);
  return parsed;
}

/** test-only: clear the per-process schema cache. */
export function _clearProviderSchemaCache(): void {
  schemaCache.clear();
}

export const TerraformProviderSchemaParams = type({
  resource_type: type.string.describe(
    "the Terraform resource type to inspect, e.g. 'aws_s3_bucket'.",
  ),
  "args?": type.string
    .array()
    .describe(
      "optional argument/block names a fix introduces — the tool reports which are NOT valid for the installed provider version.",
    ),
});

export function TerraformProviderSchemaTool(ctx: LocalToolContext) {
  return tool({
    name: "terraform_provider_schema",
    description:
      "Inspect the INSTALLED provider's schema for a resource type (§4.15) so a fix targets the right " +
      "arguments for the pinned provider major. Returns the resource's valid `attributes` and nested " +
      "`blocks`; when you pass `args`, it reports which are `unknown` (would break `plan`). Requires the dir " +
      "to be `terraform init`-ed (run `terraform_validate`/`terraform_plan` first); degrades green " +
      "(`ok: false`) when terraform isn't installed or the schema isn't available. Cached per run.",
    parameters: TerraformProviderSchemaParams,
    execute: execute(async ({ resource_type, args }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const schema = loadProvidersSchema(cwd);
      if (!schema) {
        return {
          ok: false,
          code: "schema_unavailable",
          detail:
            "provider schema unavailable — run terraform_validate/terraform_plan first to init the dir, or terraform isn't installed.",
        };
      }
      const res = schema.get(resource_type);
      if (!res) {
        return {
          ok: false,
          code: "unknown_resource_type",
          detail: `no schema for '${resource_type}' in the installed providers — check the type name and that its provider is required.`,
        };
      }
      const verdict =
        args && args.length > 0 ? unknownArgsForResource(schema, resource_type, args) : null;
      log.info(
        `» terraform_provider_schema(${resource_type}): ${res.attributes.size} attr / ${res.blocks.size} block(s)` +
          (verdict ? `, ${verdict.unknown.length} unknown arg(s)` : ""),
      );
      return {
        ok: true,
        resource_type,
        attributes: [...res.attributes].sort(),
        blocks: [...res.blocks].sort(),
        ...(verdict ? { unknown_args: verdict.unknown } : {}),
      };
    }),
  });
}
