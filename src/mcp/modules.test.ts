import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyModuleSource,
  collectModuleGraph,
  collectModuleInterface,
  dependencyOrderedModuleDirs,
  isInLocalModule,
  ListModulesTool,
  type ModuleGraph,
  moduleDirExists,
  parseModuleBlocks,
  parseModuleCatalogue,
  parseModuleInterface,
  splitModuleSource,
  TerraformModuleGraphTool,
  TerraformModuleInterfaceTool,
  walkTfFiles,
} from "#app/mcp/modules";
import type { ToolContext } from "#app/mcp/server";

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

function makeCtx(payload: { cwd?: string; moduleCatalogue?: string }): ToolContext {
  return { payload } as unknown as ToolContext;
}

// real source strings copied verbatim from the hepcare repo + the UKHSA
// data-integration-terraform-modules library it consumes — these are the
// patterns the parser MUST handle.
const HEPCARE_GIT =
  "git::https://github.com/UKHSA-Internal/data-integration-terraform-modules.git//aws/kms?ref=kms-v0.1.0";
const REGISTRY_SUBMODULE = "terraform-aws-modules/cloudwatch/aws//modules/log-group";

describe("splitModuleSource", () => {
  it("splits a git source into base, subdir, and ref (the version pin)", () => {
    expect(splitModuleSource(HEPCARE_GIT)).toEqual({
      raw: HEPCARE_GIT,
      base: "git::https://github.com/UKHSA-Internal/data-integration-terraform-modules.git",
      subdir: "aws/kms",
      ref: "kms-v0.1.0",
      kind: "git",
    });
  });

  it("splits a registry submodule path without mistaking // for the scheme", () => {
    expect(splitModuleSource(REGISTRY_SUBMODULE)).toMatchObject({
      base: "terraform-aws-modules/cloudwatch/aws",
      subdir: "modules/log-group",
      ref: null,
      kind: "registry",
    });
  });

  it("leaves a plain local/registry source untouched", () => {
    expect(splitModuleSource("./modules/cloudwatch_logs")).toMatchObject({
      base: "./modules/cloudwatch_logs",
      subdir: null,
      ref: null,
      kind: "local",
    });
    expect(splitModuleSource("terraform-aws-modules/vpc/aws")).toMatchObject({
      kind: "registry",
      subdir: null,
    });
  });
});

describe("classifyModuleSource (real-world sources)", () => {
  it("classifies the hepcare git library source as git", () => {
    expect(classifyModuleSource(HEPCARE_GIT)).toBe("git");
  });

  it("classifies a registry submodule path as registry (was previously 'unknown')", () => {
    expect(classifyModuleSource(REGISTRY_SUBMODULE)).toBe("registry");
  });

  it("classifies local, plain registry, git, and remote", () => {
    expect(classifyModuleSource("./modules/vpc")).toBe("local");
    expect(classifyModuleSource("../shared/net")).toBe("local");
    expect(classifyModuleSource("terraform-aws-modules/vpc/aws")).toBe("registry");
    expect(classifyModuleSource("git@github.com:acme/mod.git")).toBe("git");
    expect(classifyModuleSource("s3::https://bucket.s3.amazonaws.com/mod.zip")).toBe("remote");
  });

  it("returns unknown for an unparseable source", () => {
    expect(classifyModuleSource("")).toBe("unknown");
    expect(classifyModuleSource("just-a-name")).toBe("unknown");
  });
});

describe("parseModuleCatalogue (real-world sources)", () => {
  it("parses a git library entry — name from the subdir, version from the ref", () => {
    const [m] = parseModuleCatalogue(HEPCARE_GIT);
    expect(m).toEqual({ name: "kms", source: HEPCARE_GIT, version: "kms-v0.1.0", kind: "git" });
  });

  it("parses name=source version and a registry shorthand", () => {
    expect(parseModuleCatalogue("vpc=terraform-aws-modules/vpc/aws ~> 5.0")).toEqual([
      { name: "vpc", source: "terraform-aws-modules/vpc/aws", version: "~> 5.0", kind: "registry" },
    ]);
    const [s3] = parseModuleCatalogue("terraform-aws-modules/s3-bucket/aws");
    expect(s3).toMatchObject({ name: "s3-bucket", version: null, kind: "registry" });
  });

  it("derives a registry-submodule name from its subdir", () => {
    expect(parseModuleCatalogue(REGISTRY_SUBMODULE)[0]!.name).toBe("log-group");
  });

  it("handles local paths, newline/comma splitting, and dedup", () => {
    const out = parseModuleCatalogue(
      "./modules/networking\nterraform-aws-modules/vpc/aws, ./modules/networking",
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      source: "./modules/networking",
      kind: "local",
      name: "networking",
    });
  });

  it("returns nothing for empty input", () => {
    expect(parseModuleCatalogue(undefined)).toEqual([]);
    expect(parseModuleCatalogue("  \n , ")).toEqual([]);
  });
});

describe("parseModuleBlocks (real-world)", () => {
  it("extracts a git module's ref as its version (no version attribute)", () => {
    const hcl = `module "kms_uploads" {
      source   = "${HEPCARE_GIT}"
      for_each = local.upload_buckets
    }`;
    expect(parseModuleBlocks(hcl)).toEqual([
      {
        name: "kms_uploads",
        source: HEPCARE_GIT,
        version: "kms-v0.1.0",
        subdir: "aws/kms",
        kind: "git",
        declaredIn: "",
      },
    ]);
  });

  it("prefers an explicit version attribute over a ref", () => {
    const hcl = `module "vpc" {
      source  = "terraform-aws-modules/vpc/aws"
      version = "~> 5.0"
    }`;
    expect(parseModuleBlocks(hcl)[0]).toMatchObject({
      version: "~> 5.0",
      kind: "registry",
      subdir: null,
    });
  });

  it("parses a local module and brace-matches a nested map", () => {
    const hcl = `module "a" {
      source    = "./modules/cloudwatch_logs"
      providers = { aws = aws.useast1 }
    }`;
    expect(parseModuleBlocks(hcl)[0]).toMatchObject({
      name: "a",
      source: "./modules/cloudwatch_logs",
      kind: "local",
    });
  });

  it("returns nothing when there are no module blocks", () => {
    expect(parseModuleBlocks('resource "aws_s3_bucket" "b" {}')).toEqual([]);
  });
});

describe("isInLocalModule", () => {
  const graph: ModuleGraph = {
    modules: [],
    localModuleDirs: [{ dir: "modules/net", callers: ["main.tf"] }],
    externalCount: 1,
  };

  it("matches a file inside a local module dir (exact prefix, not substring)", () => {
    expect(isInLocalModule("modules/net/vpc.tf", graph)?.dir).toBe("modules/net");
    expect(isInLocalModule("./modules/net/vpc.tf", graph)?.dir).toBe("modules/net");
    expect(isInLocalModule("modules/network/vpc.tf", graph)).toBeNull();
    expect(isInLocalModule("main.tf", graph)).toBeNull();
  });
});

describe("parseModuleInterface", () => {
  it("parses variables (type, description, required) and outputs", () => {
    const hcl = `
      variable "bucket_name" {
        description = "The bucket name"
        type        = string
      }
      variable "tags" {
        type    = map(string)
        default = {}
      }
      variable "retention_in_days" {
        type = number
        default = 30
        validation {
          condition     = var.retention_in_days > 0
          error_message = "must be positive"
        }
      }
      output "arn" {
        description = "The bucket ARN"
        value       = aws_s3_bucket.this.arn
      }`;
    const iface = parseModuleInterface(hcl);
    expect(iface.variables).toEqual([
      { name: "bucket_name", type: "string", description: "The bucket name", required: true },
      { name: "tags", type: "map(string)", description: null, required: false },
      { name: "retention_in_days", type: "number", description: null, required: false },
    ]);
    expect(iface.outputs).toEqual([{ name: "arn", description: "The bucket ARN" }]);
  });

  it("brace-matches a variable with a nested validation/object type", () => {
    const hcl = `variable "cfg" {
      type = object({ name = string, size = number })
      default = { name = "x", size = 1 }
    }`;
    const iface = parseModuleInterface(hcl);
    expect(iface.variables).toHaveLength(1);
    expect(iface.variables[0]).toMatchObject({ name: "cfg", required: false });
    expect(iface.variables[0]!.type).toContain("object(");
  });

  it("returns empty for HCL with no variables/outputs", () => {
    expect(parseModuleInterface('resource "aws_s3_bucket" "b" {}')).toEqual({
      variables: [],
      outputs: [],
    });
  });

  it("keeps a variable REQUIRED when only a nested object field is named `default`", () => {
    // regression: a `default = string` FIELD inside `object({…})` must not be
    // mistaken for the variable's `default` attribute (which would mark it optional).
    const hcl = `variable "x" {
      type = object({
        enabled = bool
        default = string
      })
    }`;
    expect(parseModuleInterface(hcl).variables[0]).toMatchObject({ name: "x", required: true });
  });

  it("still detects a real top-level default (including an empty object)", () => {
    const hcl = `variable "tags" {
      type    = map(string)
      default = {}
    }`;
    expect(parseModuleInterface(hcl).variables[0]!.required).toBe(false);
  });
});

describe("walkTfFiles + collectModuleGraph (recursive, multi-root)", () => {
  let root: string;

  beforeAll(() => {
    // mimic the hepcare layout: a `terraform/` root with a `core/` subdir root
    // and a `modules/cloudwatch_logs` house module.
    root = mkdtempSync(join(tmpdir(), "tf-modgraph-"));
    mkdirSync(join(root, "core"), { recursive: true });
    mkdirSync(join(root, "modules", "cloudwatch_logs"), { recursive: true });
    mkdirSync(join(root, ".terraform", "modules"), { recursive: true });
    writeFileSync(
      join(root, "api_gateway.tf"),
      `module "api_gateway_logs" { source = "./modules/cloudwatch_logs" }`,
    );
    writeFileSync(
      join(root, "core", "main.tf"),
      `module "bootstrap" { source = "git::https://github.com/x/mods.git//aws/bootstrap?ref=v1" }`,
    );
    writeFileSync(
      join(root, "modules", "cloudwatch_logs", "main.tf"),
      `resource "aws_cloudwatch_log_group" "g" {}`,
    );
    // noise that must be skipped:
    writeFileSync(
      join(root, ".terraform", "modules", "junk.tf"),
      `module "skip" { source = "./nope" }`,
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("walks .tf recursively and skips cache dirs", () => {
    const files = walkTfFiles(root).sort();
    expect(files).toContain("api_gateway.tf");
    expect(files).toContain("core/main.tf");
    expect(files).toContain("modules/cloudwatch_logs/main.tf");
    expect(files.some((f) => f.startsWith(".terraform/"))).toBe(false);
  });

  it("resolves a local module dir and records its caller; classifies the git module external", () => {
    const graph = collectModuleGraph(root);
    expect(graph.localModuleDirs).toEqual([
      { dir: "modules/cloudwatch_logs", callers: ["api_gateway.tf"] },
    ]);
    expect(graph.externalCount).toBe(1); // the git bootstrap module in core/
    // a concern in the house module is fixable at source:
    expect(isInLocalModule("modules/cloudwatch_logs/main.tf", graph)?.callers).toEqual([
      "api_gateway.tf",
    ]);
  });
});

describe("dependencyOrderedModuleDirs (§24)", () => {
  const graph = (
    localModuleDirs: { dir: string; callers: string[] }[],
    modules: { source: string; declaredIn: string; kind?: string }[],
  ): ModuleGraph => ({
    localModuleDirs,
    externalCount: 0,
    modules: modules.map((m) => ({
      name: "m",
      source: m.source,
      version: null,
      subdir: null,
      kind: (m.kind ?? "local") as ModuleGraph["modules"][number]["kind"],
      declaredIn: m.declaredIn,
    })),
  });

  it("orders a depended-on module before its dependent", () => {
    // modules/a calls ../b → a depends on b → b must be fixed first.
    const g = graph(
      [
        { dir: "modules/a", callers: [] },
        { dir: "modules/b", callers: [] },
      ],
      [{ source: "../b", declaredIn: "modules/a/main.tf" }],
    );
    expect(dependencyOrderedModuleDirs(g)).toEqual(["modules/b", "modules/a"]);
  });

  it("breaks ties between independent modules by path", () => {
    const g = graph(
      [
        { dir: "modules/z", callers: [] },
        { dir: "modules/a", callers: [] },
      ],
      [],
    );
    expect(dependencyOrderedModuleDirs(g)).toEqual(["modules/a", "modules/z"]);
  });

  it("ignores module calls declared in a root (not inside a local module)", () => {
    // the call lives in the repo root, so neither module depends on the other.
    const g = graph(
      [
        { dir: "modules/a", callers: ["main.tf"] },
        { dir: "modules/b", callers: ["main.tf"] },
      ],
      [
        { source: "./modules/a", declaredIn: "main.tf" },
        { source: "./modules/b", declaredIn: "main.tf" },
      ],
    );
    expect(dependencyOrderedModuleDirs(g)).toEqual(["modules/a", "modules/b"]);
  });

  it("attributes a block to the MOST-SPECIFIC (nested) owner module", () => {
    // a block in modules/network/subnet calls ../../shared → subnet depends on
    // shared, so shared must precede subnet (the outer modules/network must NOT
    // be credited with the edge).
    const g = graph(
      [
        { dir: "modules/network", callers: [] },
        { dir: "modules/network/subnet", callers: [] },
        { dir: "modules/shared", callers: [] },
      ],
      [{ source: "../../shared", declaredIn: "modules/network/subnet/main.tf" }],
    );
    const order = dependencyOrderedModuleDirs(g);
    expect(order.indexOf("modules/shared")).toBeLessThan(order.indexOf("modules/network/subnet"));
  });

  it("is cycle-safe (appends remaining nodes deterministically)", () => {
    const g = graph(
      [
        { dir: "modules/a", callers: [] },
        { dir: "modules/b", callers: [] },
      ],
      [
        { source: "../b", declaredIn: "modules/a/main.tf" },
        { source: "../a", declaredIn: "modules/b/main.tf" },
      ],
    );
    expect(dependencyOrderedModuleDirs(g)).toEqual(["modules/a", "modules/b"]);
  });

  it("returns an empty list for no local modules", () => {
    expect(dependencyOrderedModuleDirs(graph([], []))).toEqual([]);
  });
});

describe("splitModuleSource (query/ref edge cases)", () => {
  it("decodes a percent-encoded ref", () => {
    expect(splitModuleSource("git::https://h/r.git?ref=v%201").ref).toBe("v 1");
  });

  it("keeps a malformed percent-encoded ref verbatim", () => {
    expect(splitModuleSource("git::https://h/r.git?ref=%E0%A4%A").ref).toBe("%E0%A4%A");
  });

  it("returns a null ref for a query without ref=", () => {
    const parsed = splitModuleSource("git::https://h/r.git?depth=1");
    expect(parsed.ref).toBeNull();
    expect(parsed.base).toBe("git::https://h/r.git");
  });

  it("classifies hg:: as git-family and oci: as remote", () => {
    expect(classifyModuleSource("hg::https://h/r")).toBe("git");
    expect(classifyModuleSource("oci://registry/example/mod")).toBe("remote");
  });

  it("classifies a Windows drive path as local", () => {
    expect(classifyModuleSource("C:\\modules\\vpc")).toBe("local");
  });
});

describe("parseModuleCatalogue (name/version edge cases)", () => {
  it("derives a registry name from a host-prefixed source without a subdir", () => {
    const [m] = parseModuleCatalogue("registry.example.com/ns/netmod/aws");
    expect(m).toMatchObject({ name: "netmod", kind: "registry" });
  });

  it("derives a git name from the repo's last path segment (no subdir)", () => {
    const [m] = parseModuleCatalogue("git::https://github.com/acme/networking.git");
    expect(m).toMatchObject({ name: "networking", kind: "git", version: null });
  });

  it("accepts a >= version constraint after the source", () => {
    const [m] = parseModuleCatalogue("terraform-aws-modules/vpc/aws >= 1.2");
    expect(m).toMatchObject({ version: ">= 1.2", kind: "registry" });
  });

  it("folds non-version trailing words back into the source", () => {
    const [m] = parseModuleCatalogue("foo bar");
    expect(m).toMatchObject({ source: "foo bar", version: null, kind: "unknown" });
  });

  it("does not treat a slashed left-hand side of = as a name", () => {
    const [m] = parseModuleCatalogue("my/bad=./x");
    expect(m).toMatchObject({ source: "my/bad=./x", kind: "unknown" });
  });
});

describe("parseModuleBlocks (malformed HCL)", () => {
  it("stops at an unterminated module block", () => {
    expect(parseModuleBlocks('module "x" {\n  source = "./m"\n')).toEqual([]);
  });

  it("skips a module block without a source", () => {
    expect(parseModuleBlocks('module "x" {\n  for_each = local.things\n}')).toEqual([]);
  });
});

describe("parseModuleInterface (malformed HCL)", () => {
  it("stops at an unterminated variable block", () => {
    expect(parseModuleInterface('variable "x" {\n  type = string\n')).toEqual({
      variables: [],
      outputs: [],
    });
  });
});

describe("walkTfFiles (bounds)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tf-walk-"));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "top.tf"), "");
    writeFileSync(join(root, "a", "mid.tf"), "");
    writeFileSync(join(root, "a", "b", "deep.tf"), "");
    writeFileSync(join(root, "notes.txt"), "");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("respects maxDepth", () => {
    expect(walkTfFiles(root, 0)).toEqual(["top.tf"]);
    const depth1 = walkTfFiles(root, 1).sort();
    expect(depth1).toEqual(["a/mid.tf", "top.tf"]);
  });

  it("respects the file cap", () => {
    expect(walkTfFiles(root, 8, 1)).toHaveLength(1);
  });

  it("returns nothing for an unreadable directory", () => {
    expect(walkTfFiles(join(root, "does-not-exist"))).toEqual([]);
  });
});

describe("module tools + fs helpers", () => {
  let root: string;
  let emptyRoot: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tf-modtools-"));
    emptyRoot = mkdtempSync(join(tmpdir(), "tf-modtools-empty-"));
    mkdirSync(join(root, "modules", "cloudwatch_logs"), { recursive: true });
    mkdirSync(join(root, "modules", "extra"), { recursive: true });
    writeFileSync(join(root, "modules", "extra", "main.tf"), 'resource "aws_sns_topic" "t" {}');
    writeFileSync(
      join(root, "main.tf"),
      `module "logs" { source = "./modules/cloudwatch_logs" }
module "extra" { source = "./modules/extra" }
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
}`,
    );
    writeFileSync(
      join(root, "modules", "cloudwatch_logs", "variables.tf"),
      `variable "name" {
  type        = string
  description = "log group name"
}
variable "retention" {
  type    = number
  default = 30
}
output "arn" {
  description = "log group arn"
  value       = aws_cloudwatch_log_group.g.arn
}`,
    );
    writeFileSync(join(root, "modules", "cloudwatch_logs", "README.md"), "not terraform");
    // a directory named like a .tf file — collectModuleInterface must skip it
    mkdirSync(join(root, "modules", "cloudwatch_logs", "trap.tf"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  describe("moduleDirExists", () => {
    it("is true for an existing directory and false otherwise", () => {
      expect(moduleDirExists(root, "modules/cloudwatch_logs")).toBe(true);
      expect(moduleDirExists(root, "modules/nope")).toBe(false);
      expect(moduleDirExists(root, "main.tf")).toBe(false); // a file, not a dir
    });
  });

  describe("collectModuleInterface", () => {
    it("parses the interface from a module dir, skipping unreadable .tf entries", () => {
      const iface = collectModuleInterface(root, "modules/cloudwatch_logs");
      expect(iface.variables.map((v) => v.name)).toEqual(["name", "retention"]);
      expect(iface.outputs).toEqual([{ name: "arn", description: "log group arn" }]);
    });

    it("returns an empty interface for a missing dir", () => {
      expect(collectModuleInterface(root, "modules/nope")).toEqual({
        variables: [],
        outputs: [],
      });
    });

    it("reads the cwd itself when moduleDir is empty", () => {
      const iface = collectModuleInterface(join(root, "modules", "cloudwatch_logs"), "");
      expect(iface.variables).toHaveLength(2);
    });
  });

  describe("ListModulesTool", () => {
    it("combines the catalogue with discovered house modules", async () => {
      const ctx = makeCtx({
        cwd: root,
        moduleCatalogue: "vpc=terraform-aws-modules/vpc/aws ~> 5.0",
      });
      const result = await runTool(ListModulesTool(ctx), {});

      const text = result.content[0].text;
      expect(result.isError).toBeUndefined();
      expect(text).toContain("configured: true");
      expect(text).toContain("terraform-aws-modules/vpc/aws");
      expect(text).toContain("modules/cloudwatch_logs");
      expect(text).toContain("exists: true");
      expect(text).toContain("Prefer these modules");
    });

    it("falls back to the no-catalogue note when nothing is configured or discovered", async () => {
      const result = await runTool(ListModulesTool(makeCtx({ cwd: emptyRoot })), {});

      const text = result.content[0].text;
      expect(text).toContain("configured: false");
      expect(text).toContain("No catalogue or house modules");
    });
  });

  describe("TerraformModuleGraphTool", () => {
    it("returns the classified blocks, local dirs, and dependency order", async () => {
      const result = await runTool(TerraformModuleGraphTool(makeCtx({ cwd: root })), {});

      const text = result.content[0].text;
      expect(result.isError).toBeUndefined();
      expect(text).toContain("ok: true");
      expect(text).toContain("declared_in");
      expect(text).toContain("main.tf");
      expect(text).toContain("external_module_count: 1");
      expect(text).toContain("modules/cloudwatch_logs");
    });
  });

  describe("TerraformModuleInterfaceTool", () => {
    it("reports the module's variables, outputs, and required inputs", async () => {
      const result = await runTool(TerraformModuleInterfaceTool(makeCtx({ cwd: root })), {
        module_dir: "modules/cloudwatch_logs",
      });

      const text = result.content[0].text;
      expect(result.isError).toBeUndefined();
      expect(text).toContain("ok: true");
      expect(text).toContain("module_dir: modules/cloudwatch_logs");
      expect(text).toContain("required_variables[1]: name");
      expect(text).toContain("arn");
    });
  });
});
