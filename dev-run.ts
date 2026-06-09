// dev-run.ts — developer harness to run the Terramend action against an
// ad-hoc fixture locally, without GitHub. It's a CI emulator for fast manual
// iteration / dogfooding; it is NOT part of the published action or CI.
//
// invoke from the repo root:
//   pnpm dev:run [args…]            # host, in-process — fast iteration (default)
//   pnpm docker dev-run.ts [args…]  # local docker container that mocks GHA
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import arg from "arg";
import { config } from "dotenv";
import type { Inputs } from "#app/main";
import { log } from "#app/utils/cli";
import { run } from "#app/utils/runFixture";
import { defineFixture } from "./test/utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// load .env from the repo root first, then fall back to a parent-dir .env
// (supports running standalone or nested inside a monorepo). dotenv does not
// override already-set vars, so the repo-root value wins.
config({ path: join(__dirname, ".env") });
config({ path: join(__dirname, "..", ".env") });

/**
 * default fixture for ad-hoc `pnpm dev:run` runs. change this freely without
 * affecting any tests — it's only consumed by this script's no-arg path.
 */
export const devFixture = defineFixture(
  {
    prompt: `List every MCP tool you have access to. Call set_output with a JSON array of all tool names you can see.`,
  },
  { localOnly: true },
);

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectExecution) {
  const args = arg({
    "--help": Boolean,
    "--raw": String,
    "-h": "--help",
  });

  if (args["--help"]) {
    log.info(`
Usage: pnpm dev:run            [--raw <input>]   (host, in-process; this entry)
       pnpm docker dev-run.ts  [--raw <input>]   (local docker container that mocks GHA)

Run the Terramend action against an inline fixture.

Options:
  --raw <input>    raw string used as the prompt, or JSON object as full fixture
  -h, --help       show this message

Examples:
  pnpm dev:run
  pnpm dev:run --raw "Hello world"
  pnpm dev:run --raw '{"prompt":"Hi","timeout":"5s"}'
    `);
    process.exit(0);
  }

  if (args["--raw"]) {
    const raw = args["--raw"];
    let input: Inputs | string = raw;
    try {
      input = JSON.parse(raw) as Inputs;
    } catch {
      // not valid JSON — treat as a literal prompt string.
    }
    const result = await run(input);
    process.exit(result.success ? 0 : 1);
  }

  const result = await run(devFixture);
  process.exit(result.success ? 0 : 1);
}
