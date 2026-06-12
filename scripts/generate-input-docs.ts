/**
 * Generates `docs/action-inputs.md` from `action.yml`, so the input/output
 * reference can never drift from what the action actually accepts: the
 * manifest is the single source of truth and the doc is a render of it.
 *
 * - regenerate: `pnpm docs:inputs` (or `node scripts/generate-input-docs.ts`)
 * - drift guard: `test/inputDocs.test.ts` re-renders and compares against the
 *   committed file, so CI fails when `action.yml` changes without a re-render.
 *
 * The renderer is exported (not just the CLI side effect) so the drift test
 * exercises the exact same code path that wrote the file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

interface ActionInput {
  description?: string;
  required?: boolean;
  default?: string;
}

interface ActionManifest {
  name?: string;
  description?: string;
  inputs?: Record<string, ActionInput>;
  outputs?: Record<string, { description?: string }>;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const actionYmlPath = join(scriptDir, "..", "action.yml");

/** flatten a description into one markdown table cell (escape pipes, fold newlines). */
function cell(text: string | undefined): string {
  if (!text) return "—";
  return text.replaceAll("|", "\\|").replaceAll(/\s*\n\s*/g, " ").trim();
}

function defaultCell(input: ActionInput): string {
  if (input.default === undefined) return "—";
  return `\`${String(input.default).replaceAll("|", "\\|")}\``;
}

export function renderActionInputDocs(): string {
  const manifest = parse(readFileSync(actionYmlPath, "utf8")) as ActionManifest;
  const inputs = Object.entries(manifest.inputs ?? {});
  const outputs = Object.entries(manifest.outputs ?? {});

  const lines: string[] = [];
  lines.push("# Action inputs & outputs");
  lines.push("");
  lines.push("<!-- GENERATED FILE — do not edit by hand. -->");
  lines.push("<!-- Regenerate with `pnpm docs:inputs` after changing action.yml. -->");
  lines.push("");
  lines.push(
    "The complete reference for [`action.yml`](../action.yml), generated from the manifest",
    "itself so it can't drift. All Terraform inputs are optional; defaults are applied at the",
    'consumer so "unset" stays distinguishable from an explicit value.',
  );
  lines.push("");
  lines.push("## Inputs");
  lines.push("");
  lines.push("| Input | Required | Default | Description |");
  lines.push("| ----- | :------: | ------- | ----------- |");
  for (const [name, input] of inputs) {
    lines.push(
      `| \`${name}\` | ${input.required ? "**yes**" : "no"} | ${defaultCell(input)} | ${cell(input.description)} |`,
    );
  }
  lines.push("");
  lines.push("## Outputs");
  lines.push("");
  lines.push("| Output | Description |");
  lines.push("| ------ | ----------- |");
  for (const [name, output] of outputs) {
    lines.push(`| \`${name}\` | ${cell(output.description)} |`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// pathToFileURL (not a `file://${argv[1]}` template) so the check also works
// on Windows, where argv[1] is a backslashed path with a drive letter.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const outPath = join(scriptDir, "..", "docs", "action-inputs.md");
  writeFileSync(outPath, renderActionInputDocs());
  process.stdout.write(`wrote ${outPath}\n`);
}
