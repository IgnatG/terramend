import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyModuleSource,
  collectModuleGraph,
  isInLocalModule,
  type ModuleGraph,
  parseModuleBlocks,
  parseModuleCatalogue,
  parseModuleInterface,
  splitModuleSource,
  walkTfFiles,
} from "#app/mcp/modules";

// real source strings copied verbatim from the hepcare repo + the UKHSA
// data-integration-terraform-modules library it consumes — these are the
// patterns the parser MUST handle.
const HEPCARE_GIT = "git::https://github.com/UKHSA-Internal/data-integration-terraform-modules.git//aws/kms?ref=kms-v0.1.0";
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
    expect(splitModuleSource("terraform-aws-modules/vpc/aws")).toMatchObject({ kind: "registry", subdir: null });
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
    expect(parseModuleCatalogue(REGISTRY_SUBMODULE)[0].name).toBe("log-group");
  });

  it("handles local paths, newline/comma splitting, and dedup", () => {
    const out = parseModuleCatalogue("./modules/networking\nterraform-aws-modules/vpc/aws, ./modules/networking");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ source: "./modules/networking", kind: "local", name: "networking" });
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
      { name: "kms_uploads", source: HEPCARE_GIT, version: "kms-v0.1.0", subdir: "aws/kms", kind: "git", declaredIn: "" },
    ]);
  });

  it("prefers an explicit version attribute over a ref", () => {
    const hcl = `module "vpc" {
      source  = "terraform-aws-modules/vpc/aws"
      version = "~> 5.0"
    }`;
    expect(parseModuleBlocks(hcl)[0]).toMatchObject({ version: "~> 5.0", kind: "registry", subdir: null });
  });

  it("parses a local module and brace-matches a nested map", () => {
    const hcl = `module "a" {
      source    = "./modules/cloudwatch_logs"
      providers = { aws = aws.useast1 }
    }`;
    expect(parseModuleBlocks(hcl)[0]).toMatchObject({ name: "a", source: "./modules/cloudwatch_logs", kind: "local" });
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
    expect(iface.variables[0].type).toContain("object(");
  });

  it("returns empty for HCL with no variables/outputs", () => {
    expect(parseModuleInterface('resource "aws_s3_bucket" "b" {}')).toEqual({ variables: [], outputs: [] });
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
    expect(parseModuleInterface(hcl).variables[0].required).toBe(false);
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
      `module "api_gateway_logs" { source = "./modules/cloudwatch_logs" }`
    );
    writeFileSync(
      join(root, "core", "main.tf"),
      `module "bootstrap" { source = "git::https://github.com/x/mods.git//aws/bootstrap?ref=v1" }`
    );
    writeFileSync(join(root, "modules", "cloudwatch_logs", "main.tf"), `resource "aws_cloudwatch_log_group" "g" {}`);
    // noise that must be skipped:
    writeFileSync(join(root, ".terraform", "modules", "junk.tf"), `module "skip" { source = "./nope" }`);
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
    expect(isInLocalModule("modules/cloudwatch_logs/main.tf", graph)?.callers).toEqual(["api_gateway.tf"]);
  });
});
