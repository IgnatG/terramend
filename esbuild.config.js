// @ts-check

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

rmSync("./dist", { recursive: true, force: true });
mkdirSync("./dist", { recursive: true });

// Plugin to strip shebangs from output files
/**
 * @type {import("esbuild").Plugin}
 */
const stripShebangPlugin = {
  name: "strip-shebang",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;

      // Strip shebang from the output file
      const outputFile = build.initialOptions.outfile;
      if (outputFile) {
        try {
          const content = readFileSync(outputFile, "utf8");
          // Remove shebang line from the beginning if present
          const withoutShebang = content.startsWith("#!")
            ? content.slice(content.indexOf("\n") + 1)
            : content;
          writeFileSync(outputFile, withoutShebang);
        } catch (error) {
          // File might not exist, ignore
        }
      }
    });
  },
};

/**
 * @type {import("esbuild").BuildOptions}
 */
const sharedConfig = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  minify: false,
  sourcemap: false,
  // Bundle all dependencies — the GitHub Actions runtime has no node_modules.
  // EXCEPTION: these three are optional schema-adapter peers that `xsschema`
  // (reached via fastmcp's `toJsonSchema`) lazily imports ONLY for projects that
  // validate with valibot / effect-schema / sury. Terramend validates with
  // arktype, so they are never loaded at runtime; marking them external stops
  // esbuild from trying to bundle (and failing to resolve) adapter code nothing
  // here uses. They are intentionally NOT declared as dependencies for the same
  // reason — adding them would pull unused, unresolved optional adapters.
  external: ["@valibot/to-json-schema", "effect", "sury"],
  // Provide a proper require shim for CommonJS modules bundled into ESM
  // We use a unique variable name to avoid conflicts with bundled imports
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; import { fileURLToPath as __fileURLToPath } from 'url'; import { dirname as __dirnameFn } from 'path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameFn(__filename);`,
  },
  // Enable tree-shaking to remove unused code
  treeShaking: true,
  // Drop console statements in production (but keep for debugging)
  drop: [],
};

// Build the CLI bundle (published to npm, used by npx). Inherits
// sharedConfig.target ("node24") — the engines.node floor + the action runtime
// baseline; keep all three in lockstep if it ever changes.
await build({
  ...sharedConfig,
  entryPoints: ["./src/cli.ts"],
  outfile: "./dist/cli.mjs",
  plugins: [stripShebangPlugin],
  define: {
    "process.env.CLI_VERSION": JSON.stringify(pkg.version),
  },
});

// Build ESM library entrypoints for programmatic imports
await build({
  ...sharedConfig,
  entryPoints: ["./src/index.ts"],
  outfile: "./dist/index.js",
});

await build({
  ...sharedConfig,
  entryPoints: ["./src/internal/index.ts"],
  outfile: "./dist/internal.js",
});

// prepend shebang after strip (esbuild banner can't guarantee line 1 placement)
const cliPath = "./dist/cli.mjs";
const cliContent = readFileSync(cliPath, "utf8");
writeFileSync(cliPath, `#!/usr/bin/env node\n${cliContent}`);

// copy bundled SKILL.md files into dist/ so the npm-published runtime can read
// them via readFileSync. source-mode runs (TERRAMEND_FORCE_LOCAL_CLI=1) read
// directly from src/skills/ instead. see src/utils/skills.ts.
cpSync("./src/skills", "./dist/skills", { recursive: true });

console.log("» build completed successfully");
