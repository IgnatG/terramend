import { type } from "arktype";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool } from "#app/mcp/shared";
import { log } from "#app/utils/cli";

/**
 * §28 Terratest scaffolding (opt-in via the `terratest` input). When Terramend
 * GENERATES a reusable module, it can also scaffold a minimal Go
 * [Terratest](https://terratest.gruntwork.io/) smoke test + a Terraform-native
 * `*.tftest.hcl` so the generated infrastructure is testable from the first
 * commit. Both tests plan the module **directly** — Terramend does not generate
 * `examples/` fixtures.
 *
 * Design choices:
 *  - **Plan-only, never apply.** The scaffolded tests run `terraform init` +
 *    `plan` against the module and assert it plans cleanly. Terramend never
 *    applies (no cloud credentials — the sovereignty stance), so the generated
 *    tests mirror that: they're a deployability smoke test the USER runs in their
 *    own pipeline (with creds) for real apply/assert coverage.
 *  - **Pure generation.** The file contents are computed deterministically here
 *    and unit-tested; the agent writes the returned files with its own tools.
 *  - The Go test + native test files fall outside the Terraform-only default
 *    allow-list, so the `terratest` input also widens the push guardrail (see
 *    guardrails.ts).
 */

export interface ScaffoldFile {
  /** repo-relative path to write. */
  path: string;
  content: string;
}

export interface TerratestScaffold {
  files: ScaffoldFile[];
  notes: string[];
}

/** PascalCase a module name for the Go test function (`my-vpc` → `MyVpc`). */
function pascalCase(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return /^[A-Za-z]/.test(pascal) ? pascal : `M${pascal}`;
}

/** compute a repo-relative POSIX path from `fromDir` up to `toPath` — both are
 * repo-relative POSIX paths (e.g. from `test` to `modules/vpc` → `../modules/vpc`). */
function relativeUp(fromDir: string, toPath: string): string {
  const up = fromDir
    .split("/")
    .filter(Boolean)
    .map(() => "..");
  const rel = `${up.join("/")}/${toPath}`.replace(/\/+/g, "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Build a Terratest smoke-test + native test for a generated module. Pure:
 * `moduleName` names the module, `modulePath` is its repo-relative dir, and
 * `variables` (optional) are surfaced as TODO placeholders so the test author
 * fills in real values. Both tests plan the module directly (no `examples/`
 * fixture). Returns the files to write + operator notes.
 */
export function scaffoldTerratest(opts: {
  moduleName: string;
  modulePath: string;
  variables?: { name: string; required?: boolean }[];
}): TerratestScaffold {
  const name = opts.moduleName.replace(/[^A-Za-z0-9_-]/g, "-");
  const fn = pascalCase(name);
  const terraformDir = relativeUp("test", opts.modulePath);
  const variables = opts.variables ?? [];

  const goVarLines = variables
    .map((v) => `\t\t\t// "${v.name}": nil, // ${v.required ? "(required)" : "(optional)"}`)
    .join("\n");
  const goTest = `package test

import (
\t"testing"

\t"github.com/gruntwork-io/terratest/modules/terraform"
\t"github.com/stretchr/testify/require"
)

// Test${fn} is a PLAN-ONLY smoke test for the ${name} module: it runs
// terraform init + plan against the module and asserts it plans cleanly. It
// deliberately does NOT apply, so it creates no real cloud resources. Add
// apply/assert coverage in a pipeline where credentials exist.
func Test${fn}(t *testing.T) {
\tt.Parallel()

\topts := &terraform.Options{
\t\tTerraformDir: "${terraformDir}",
\t\tNoColor:      true,
\t\tVars: map[string]interface{}{
\t\t\t// TODO: set the module's variables and a provider configuration before running.
${goVarLines || "\t\t\t// (no variables detected)"}
\t\t},
\t}

\tout := terraform.InitAndPlan(t, opts)
\trequire.NotEmpty(t, out)
}
`;

  return {
    files: [
      { path: `test/${name}_test.go`, content: goTest },
      // a Terraform-native test too (no Go needed) — the lighter option.
      scaffoldTerraformTest({ moduleName: name, modulePath: opts.modulePath, variables }),
    ],
    notes: [
      "Set the module's variables and a provider configuration before running the tests (the scaffold leaves them as TODO placeholders).",
      `Both tests are plan-only (no apply). Go/Terratest: \`cd test && go test -run Test${fn} -v\`. Native: \`cd ${opts.modulePath} && terraform test\`.`,
      "The native `*.tftest.hcl` needs no Go; the Go test needs a go.mod with terratest + testify.",
    ],
  };
}

/**
 * §28 (native variant) — scaffold a Terraform-native test (Terraform 1.6+) that
 * lives in the module's own `tests/` dir and plans the module in place. Lighter
 * than Terratest: no Go toolchain, just HCL that Terraform runs with
 * `terraform test`. Plan-only `run` block (no apply, so no cloud needed to
 * construct the test). Pure.
 */
export function scaffoldTerraformTest(opts: {
  moduleName: string;
  modulePath: string;
  variables?: { name: string; required?: boolean }[];
}): ScaffoldFile {
  const name = opts.moduleName.replace(/[^A-Za-z0-9_-]/g, "-");
  const varLines = (opts.variables ?? [])
    .map((v) => `    # ${v.name} = null # ${v.required ? "(required)" : "(optional)"}`)
    .join("\n");
  const content = `# Terraform-native test for the ${name} module (Terraform 1.6+).
# Plan-only — asserts the module plans cleanly without applying. Run with:
#   cd ${opts.modulePath} && terraform test
run "plan_${name.replace(/-/g, "_")}" {
  command = plan

  variables {
    # TODO: set the module's variables and a provider configuration before running.
${varLines || "    # (no variables detected)"}
  }

  # add assertions against planned values, e.g.:
  # assert {
  #   condition     = output.id != ""
  #   error_message = "module must expose an id output"
  # }
}
`;
  return { path: `${opts.modulePath}/tests/${name}.tftest.hcl`, content };
}

export const ScaffoldTerratestParams = type({
  module_name: type.string.describe("the generated module's name (e.g. 'vpc')."),
  module_path: type.string.describe("the module's repo-relative dir (e.g. 'modules/vpc')."),
  "variables?": type({ name: "string", "required?": "boolean" })
    .array()
    .describe(
      "optional list of the module's variables, surfaced as TODO placeholders in the tests.",
    ),
});

export function ScaffoldTerratestTool(ctx: ToolContext) {
  return tool({
    name: "scaffold_terratest",
    description:
      "Scaffold a minimal Go Terratest smoke test + a Terraform-native `*.tftest.hcl` for a module you " +
      "GENERATED, so the new infrastructure is testable from the first commit. Both tests plan the module " +
      "directly (Terramend does not generate `examples/` fixtures). Opt-in: only available when the " +
      "`terratest` input is enabled (and that input also widens the push guardrail to allow the test " +
      "files). Returns the file paths + contents to write with your own tools. The tests are PLAN-ONLY " +
      "(never apply — Terramend holds no cloud credentials); they're for the user to run in their pipeline. " +
      "Use it only when generating a reusable module, not for a one-off resource fix.",
    parameters: ScaffoldTerratestParams,
    execute: execute(async ({ module_name, module_path, variables }) => {
      if (!ctx.payload.terratest) {
        return {
          enabled: false,
          reason:
            "terratest scaffolding is opt-in — set the `terratest: true` action input to enable it (it also widens allowed_paths to permit the test files).",
        };
      }
      const scaffold = scaffoldTerratest({
        moduleName: module_name,
        modulePath: module_path,
        variables: variables ?? [],
      });
      log.info(`» scaffold_terratest: ${scaffold.files.length} file(s) for module ${module_name}`);
      return { enabled: true, ...scaffold };
    }),
  });
}
