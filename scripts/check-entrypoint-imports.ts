import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Both GHA entrypoints run via `node <file>.ts` against the action checkout
// (no node_modules at that point — the main step installs deps only AFTER
// entry.ts boots, and the post step never gets a node_modules at all). Any
// non-builtin package import in either file's transitive graph crashes the
// step with ERR_MODULE_NOT_FOUND. entryPost.ts also has a regex-based vitest
// guard (entryPost.stdlibOnly.test.ts); this esbuild graph walk is the
// stronger check and covers both. See #834.
const entryPoints = [
  resolve(scriptDir, "../src/entry.ts"),
  resolve(scriptDir, "../src/entryPost.ts"),
];

function isPathImport(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:")
  );
}

async function checkEntrypointImports(): Promise<void> {
  const result = await build({
    entryPoints,
    outdir: resolve(scriptDir, "../.tmp/entrypoint-imports"),
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });

  if (!result.metafile) {
    throw new Error("expected esbuild metafile output");
  }

  const violations: string[] = [];
  const inputPaths = Object.keys(result.metafile.inputs);
  for (const inputPath of inputPaths) {
    const input = result.metafile.inputs[inputPath]!;
    for (const imported of input.imports) {
      if (!imported.external) {
        continue;
      }
      if (isPathImport(imported.path)) {
        continue;
      }
      if (isBuiltin(imported.path)) {
        continue;
      }
      violations.push(`${inputPath} -> ${imported.path}`);
    }
  }

  if (violations.length === 0) {
    console.log("entrypoint import guard passed");
    return;
  }

  console.error("entrypoint import guard failed. non-builtin package imports detected:");
  for (const violation of violations.sort()) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

await checkEntrypointImports();
