import { type } from "arktype";
import { log } from "#app/utils/cli";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool } from "#app/mcp/shared";

/**
 * §28 Terratest scaffolding (opt-in via the `terratest` input). When Terramend
 * GENERATES a reusable module, it can also scaffold a minimal Go
 * [Terratest](https://terratest.gruntwork.io/) smoke test + an `examples/`
 * fixture so the generated infrastructure is testable from the first commit.
 *
 * Design choices:
 *  - **Plan-only, never apply.** The scaffolded test runs `terraform init` +
 *    `plan` against the example and asserts it plans cleanly. Terramend never
 *    applies (no cloud credentials — the sovereignty stance), so the generated
 *    test mirrors that: it's a deployability smoke test the USER runs in their
 *    own pipeline (with creds) for real apply/assert coverage.
 *  - **Pure generation.** The file contents are computed deterministically here
 *    and unit-tested; the agent writes the returned files with its own tools.
 *  - The Go test + `examples/` files fall outside the Terraform-only default
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

/** compute the `source` an `examples/<name>` fixture uses to reach the module
 * dir — both are repo-relative POSIX paths. */
function exampleSourcePath(modulePath: string, exampleDir: string): string {
  const up = exampleDir.split("/").filter(Boolean).map(() => "..");
  const rel = `${up.join("/")}/${modulePath}`.replace(/\/+/g, "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Build a Terratest smoke-test + example fixture for a generated module. Pure:
 * `moduleName` names the module, `modulePath` is its repo-relative dir, and
 * `variables` (optional) are surfaced as TODO placeholders in the example so the
 * test author fills in real values. Returns the files to write + operator notes.
 */
export function scaffoldTerratest(opts: {
  moduleName: string;
  modulePath: string;
  variables?: { name: string; required?: boolean }[];
}): TerratestScaffold {
  const name = opts.moduleName.replace(/[^A-Za-z0-9_-]/g, "-");
  const exampleDir = `examples/${name}`;
  const source = exampleSourcePath(opts.modulePath, exampleDir);
  const fn = pascalCase(name);

  const varLines = (opts.variables ?? [])
    .map((v) => `  # ${v.name} = ... ${v.required ? "(required)" : "(optional)"}`)
    .join("\n");
  const exampleMain = `# Example usage of the \`${name}\` module — living documentation AND the fixture
# the Terratest smoke test plans against. Set real values for the module's
# variables and a provider configuration before running the test.

module "${name}" {
  source = "${source}"

${varLines || "  # TODO: set the module's required variables here"}
}
`;

  const exampleVersions = `terraform {
  required_version = ">= 1.3"
}
`;

  const goTest = `package test

import (
\t"testing"

\t"github.com/gruntwork-io/terratest/modules/terraform"
\t"github.com/stretchr/testify/require"
)

// Test${fn} is a PLAN-ONLY smoke test for the ${name} module: it runs
// terraform init + plan against the example fixture and asserts it plans
// cleanly. It deliberately does NOT apply, so it creates no real cloud
// resources. Add apply/assert coverage in a pipeline where credentials exist.
func Test${fn}(t *testing.T) {
\tt.Parallel()

\topts := &terraform.Options{
\t\tTerraformDir: "../${exampleDir}",
\t\tNoColor:      true,
\t}

\tout := terraform.InitAndPlan(t, opts)
\trequire.NotEmpty(t, out)
}
`;

  return {
    files: [
      { path: `${exampleDir}/main.tf`, content: exampleMain },
      { path: `${exampleDir}/versions.tf`, content: exampleVersions },
      { path: `test/${name}_test.go`, content: goTest },
      // a Terraform-native test too (no Go needed) — the lighter option.
      scaffoldTerraformTest({ moduleName: name }),
    ],
    notes: [
      `Set the module's required variables and a provider config in ${exampleDir}/main.tf before running the test.`,
      "Both tests are plan-only (no apply). Go/Terratest: `cd test && go test -run Test" + fn + " -v`. Native: `terraform test`.",
      "The native `tests/*.tftest.hcl` needs no Go; the Go test needs a go.mod with terratest + testify.",
    ],
  };
}

/**
 * §28 (native variant) — scaffold a Terraform-native test (`tests/<name>.tftest.hcl`,
 * Terraform 1.6+). Lighter than Terratest: no Go toolchain, just HCL that
 * Terraform runs with `terraform test`. Plan-only `run` block (no apply, so no
 * cloud needed to construct the test). Pure.
 */
export function scaffoldTerraformTest(opts: { moduleName: string }): ScaffoldFile {
  const name = opts.moduleName.replace(/[^A-Za-z0-9_-]/g, "-");
  const content = `# Terraform-native test for the ${name} module (Terraform 1.6+).
# Plan-only — asserts the example plans cleanly without applying. Run with:
#   terraform test
run "plan_${name.replace(/-/g, "_")}_example" {
  command = plan

  # point at the example fixture as the module under test.
  module {
    source = "./examples/${name}"
  }

  # add assertions against planned values, e.g.:
  # assert {
  #   condition     = output.id != ""
  #   error_message = "module must expose an id output"
  # }
}
`;
  return { path: `tests/${name}.tftest.hcl`, content };
}

export const ScaffoldTerratestParams = type({
  module_name: type.string.describe("the generated module's name (e.g. 'vpc')."),
  module_path: type.string.describe("the module's repo-relative dir (e.g. 'modules/vpc')."),
  "variables?": type({ name: "string", "required?": "boolean" })
    .array()
    .describe("optional list of the module's variables, surfaced as TODO placeholders in the example."),
});

export function ScaffoldTerratestTool(ctx: ToolContext) {
  return tool({
    name: "scaffold_terratest",
    description:
      "Scaffold a minimal Go Terratest smoke test + an `examples/<name>` fixture for a module you GENERATED, " +
      "so the new infrastructure is testable from the first commit. Opt-in: only available when the " +
      "`terratest` input is enabled (and that input also widens the push guardrail to allow the test/example " +
      "files). Returns the file paths + contents to write with your own tools. The test is PLAN-ONLY (never " +
      "applies — Terramend holds no cloud credentials); it's for the user to run in their pipeline. Use it " +
      "only when generating a reusable module, not for a one-off resource fix.",
    parameters: ScaffoldTerratestParams,
    execute: execute(async ({ module_name, module_path, variables }) => {
      if (!ctx.payload.terratest) {
        return {
          enabled: false,
          reason:
            "terratest scaffolding is opt-in — set the `terratest: true` action input to enable it (it also widens allowed_paths to permit the test/example files).",
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
