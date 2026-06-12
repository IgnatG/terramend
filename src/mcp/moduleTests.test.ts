import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalToolContext } from "#app/mcp/localContext";
import {
  analyzeModuleTests,
  computeInterfaceDrift,
  discoverModuleTestAssets,
  parseExampleModuleVariables,
  parseGoTestVariables,
  parseNativeTestVariables,
  TerraformModuleTestsTool,
  topLevelAttributeNames,
} from "#app/mcp/moduleTests";

describe("topLevelAttributeNames", () => {
  it("captures top-level attributes and ignores nested-block/object keys", () => {
    const body = `
      bucket_name = "b"
      tags = {
        Name = "x"
        default = "y"
      }
      logging {
        target_bucket = "t"
      }
    `;
    // `logging { … }` is a nested block (no `=`), so it is not an attribute; the
    // nested `Name`/`default`/`target_bucket` keys are stripped with the braces.
    expect(topLevelAttributeNames(body)).toEqual(["bucket_name", "tags"]);
  });

  it("does not treat `==`/`>=` comparisons as assignments", () => {
    const body = `count = var.enabled == true ? 1 : 0`;
    expect(topLevelAttributeNames(body)).toEqual(["count"]);
  });
});

describe("parseExampleModuleVariables", () => {
  const hcl = `
    module "vpc" {
      source = "../../modules/vpc"
      cidr   = "10.0.0.0/16"
      name   = "ex"
      tags   = { env = "dev" }
    }
    module "other" {
      source = "../../modules/other"
      foo    = "bar"
    }
  `;

  it("returns the args of only the module blocks whose source matches, minus meta-args", () => {
    const vars = parseExampleModuleVariables(hcl, (s) => s === "../../modules/vpc");
    expect(vars.sort()).toEqual(["cidr", "name", "tags"]);
    expect(vars).not.toContain("source");
    expect(vars).not.toContain("foo"); // belongs to the non-matching module
  });

  it("returns [] when no module block targets the module", () => {
    expect(parseExampleModuleVariables(hcl, () => false)).toEqual([]);
  });
});

describe("parseNativeTestVariables", () => {
  it("unions variables across the top-level and per-run variables blocks", () => {
    const hcl = `
      variables {
        bucket_name = "b"
      }
      run "plan" {
        command = plan
        variables {
          tags = { env = "dev" }
        }
        assert {
          condition     = output.id != ""
          error_message = "needs id"
        }
      }
    `;
    expect(parseNativeTestVariables(hcl).sort()).toEqual(["bucket_name", "tags"]);
  });
});

describe("parseGoTestVariables", () => {
  it("extracts the Vars map keys, including commented TODO placeholders", () => {
    const go = `
      opts := &terraform.Options{
        TerraformDir: "../modules/s3",
        Vars: map[string]interface{}{
          "bucket_name": "b",
          // "tags": nil, // (optional)
        },
      }
    `;
    expect(parseGoTestVariables(go).sort()).toEqual(["bucket_name", "tags"]);
  });

  it("supports the map[string]any form and returns [] when there's no Vars map", () => {
    expect(parseGoTestVariables(`Vars: map[string]any{ "x": 1 }`)).toEqual(["x"]);
    expect(parseGoTestVariables(`no vars here`)).toEqual([]);
  });
});

describe("computeInterfaceDrift", () => {
  it("flags missing required vars and unknown set vars", () => {
    const d = computeInterfaceDrift({
      setVariables: ["name", "old_name"],
      requiredVariables: ["name", "new_required"],
      variableNames: ["name", "new_required", "tags"],
    });
    expect(d.missing_required).toEqual(["new_required"]);
    expect(d.unknown_set).toEqual(["old_name"]);
  });

  it("is clean when the asset matches the interface", () => {
    const d = computeInterfaceDrift({
      setVariables: ["name", "tags"],
      requiredVariables: ["name"],
      variableNames: ["name", "tags"],
    });
    expect(d.missing_required).toEqual([]);
    expect(d.unknown_set).toEqual([]);
  });
});

describe("discoverModuleTestAssets + analyzeModuleTests (fs)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tf-modtests-"));
    // the module under test: requires `bucket_name`, optional `tags`.
    mkdirSync(join(root, "modules", "s3"), { recursive: true });
    writeFileSync(
      join(root, "modules", "s3", "variables.tf"),
      `variable "bucket_name" { type = string }
       variable "tags" { type = map(string)
         default = {}
       }`,
    );
    // a module-local example that is STALE: it sets a removed `acl` var and
    // omits the required `bucket_name`.
    mkdirSync(join(root, "modules", "s3", "examples", "basic"), { recursive: true });
    writeFileSync(
      join(root, "modules", "s3", "examples", "basic", "main.tf"),
      `module "s3" {
         source = "../../"
         acl    = "private"
         tags   = { env = "dev" }
       }`,
    );
    // a repo-root example that is CONSISTENT (sets the required var).
    mkdirSync(join(root, "examples", "complete"), { recursive: true });
    writeFileSync(
      join(root, "examples", "complete", "main.tf"),
      `module "s3" {
         source      = "../../modules/s3"
         bucket_name = "b"
       }`,
    );
    // a repo-root example for a DIFFERENT module — must be ignored.
    mkdirSync(join(root, "examples", "other"), { recursive: true });
    writeFileSync(
      join(root, "examples", "other", "main.tf"),
      `module "vpc" { source = "../../modules/vpc"\n cidr = "10.0.0.0/16" }`,
    );
    // a native test in the module's tests/ dir, missing the required var.
    mkdirSync(join(root, "modules", "s3", "tests"), { recursive: true });
    writeFileSync(
      join(root, "modules", "s3", "tests", "s3.tftest.hcl"),
      `run "plan" {
         command = plan
         variables {
           tags = {}
         }
       }`,
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers the module's own examples, repo-root examples, and native tests (not sibling modules')", () => {
    const assets = discoverModuleTestAssets(root, "modules/s3");
    const paths = assets.map((a) => a.path).sort();
    expect(paths).toEqual([
      "examples/complete",
      "modules/s3/examples/basic",
      "modules/s3/tests/s3.tftest.hcl",
    ]);
    // the vpc example under examples/other is not attributed to s3.
    expect(paths).not.toContain("examples/other");
  });

  it("computes drift only for the stale assets", () => {
    const report = analyzeModuleTests(root, "modules/s3");
    expect(report.required_variables).toEqual(["bucket_name"]);
    expect(report.variable_names.sort()).toEqual(["bucket_name", "tags"]);

    const byPath = Object.fromEntries(report.drift.map((d) => [d.path, d]));
    // module-local example: unknown `acl`, missing required `bucket_name`.
    expect(byPath["modules/s3/examples/basic"]).toMatchObject({
      missing_required: ["bucket_name"],
      unknown_set: ["acl"],
    });
    // native test: missing the required `bucket_name`.
    expect(byPath["modules/s3/tests/s3.tftest.hcl"]).toMatchObject({
      missing_required: ["bucket_name"],
      unknown_set: [],
    });
    // the consistent repo-root example does not appear in drift.
    expect(byPath["examples/complete"]).toBeUndefined();
  });

  it("returns no assets for a module that ships none", () => {
    mkdirSync(join(root, "modules", "bare"), { recursive: true });
    writeFileSync(join(root, "modules", "bare", "main.tf"), `variable "x" { type = string }`);
    expect(discoverModuleTestAssets(root, "modules/bare")).toEqual([]);
  });
});

describe("TerraformModuleTestsTool", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tf-modtests-tool-"));
    mkdirSync(join(root, "modules", "s3", "examples", "basic"), { recursive: true });
    writeFileSync(
      join(root, "modules", "s3", "variables.tf"),
      `variable "bucket_name" { type = string }`,
    );
    writeFileSync(
      join(root, "modules", "s3", "examples", "basic", "main.tf"),
      `module "s3" { source = "../../"\n acl = "private" }`,
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function run(moduleDir: string): Promise<string> {
    const ctx = { payload: { cwd: root } } as unknown as LocalToolContext;
    const t = TerraformModuleTestsTool(ctx);
    const exec = t.execute as (
      p: unknown,
      c: unknown,
    ) => Promise<{ content: [{ type: "text"; text: string }] }>;
    const result = await exec({ module_dir: moduleDir }, {});
    return result.content[0].text;
  }

  it("reports drift for a stale example and the consistency note", async () => {
    const text = await run("modules/s3");
    expect(text).toContain("ok: true");
    expect(text).toContain("modules/s3/examples/basic");
    expect(text).toContain("bucket_name"); // missing required
    expect(text).toContain("acl"); // unknown set
    expect(text).toContain("never weaken an assertion");
  });

  it("rejects a module dir that escapes the workspace", async () => {
    const text = await run("../../../etc");
    expect(text).toMatch(/Error:|escapes the workspace/);
  });
});
