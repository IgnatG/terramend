import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Unwrap the ToolResult envelope so tests assert on the raw object a tool
// returns instead of decoding the encoded MCP text content.
vi.mock("#app/mcp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/mcp/shared")>();
  return {
    ...actual,
    execute: <T, R>(fn: (params: T) => Promise<R>): ((params: T) => Promise<R>) => fn,
  };
});

import type { LocalToolContext } from "#app/mcp/localContext";
import {
  clusterResources,
  findExtractionCandidates,
  ModuleExtractionCandidatesTool,
  matchCluster,
  parseResourceBlocks,
  serviceKeywords,
} from "#app/mcp/moduleExtraction";

const tempDirs: string[] = [];

function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "terramend-extract-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const res = (resourceType: string, name: string) => ({ type: resourceType, name });

describe("parseResourceBlocks", () => {
  it("parses resource headers and ignores nested braces + other block kinds", () => {
    const hcl = `
resource "aws_s3_bucket" "logs" {
  tags = { Name = "logs" }
}
data "aws_caller_identity" "me" {}
module "vpc" { source = "./modules/vpc" }
resource "aws_s3_bucket_versioning" "logs" {
  versioning_configuration { status = "Enabled" }
}
`;
    expect(parseResourceBlocks(hcl)).toEqual([
      res("aws_s3_bucket", "logs"),
      res("aws_s3_bucket_versioning", "logs"),
    ]);
  });
});

describe("clusterResources", () => {
  it("clusters by shared name prefix (≥3 members)", () => {
    const clusters = clusterResources("main.tf", [
      res("aws_s3_bucket", "logs_bucket"),
      res("aws_s3_bucket_versioning", "logs_versioning"),
      res("aws_s3_bucket_public_access_block", "logs_pab"),
      res("aws_instance", "web"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ file: "main.tf", name_prefix: "logs" });
    expect(clusters[0]?.resource_types).toEqual([
      "aws_s3_bucket",
      "aws_s3_bucket_public_access_block",
      "aws_s3_bucket_versioning",
    ]);
  });

  it("falls back to a whole-file cluster for a cohesive multi-type file", () => {
    const clusters = clusterResources("net.tf", [
      res("aws_vpc", "main"),
      res("aws_subnet", "a"),
      res("aws_subnet", "b"),
      res("aws_route_table", "rt"),
      res("aws_internet_gateway", "igw"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ file: "net.tf", name_prefix: null });
  });

  it("ignores small files and single-type piles", () => {
    expect(
      clusterResources("a.tf", [res("aws_s3_bucket", "x"), res("aws_s3_bucket", "y")]),
    ).toEqual([]);
    expect(
      clusterResources("b.tf", [
        res("aws_instance", "a1"),
        res("aws_instance", "b2"),
        res("aws_instance", "c3"),
        res("aws_instance", "d4"),
      ]),
    ).toEqual([]);
  });
});

describe("serviceKeywords / matchCluster", () => {
  it("derives service keywords without provider prefixes", () => {
    expect(serviceKeywords("aws_s3_bucket")).toEqual(["s3", "bucket"]);
    expect(serviceKeywords("google_storage_bucket")).toEqual(["storage", "bucket"]);
  });

  it("ranks a house-module signature match above a catalogue keyword match", () => {
    const cluster = {
      file: "main.tf",
      name_prefix: "logs",
      resources: [res("aws_s3_bucket", "logs"), res("aws_s3_bucket_versioning", "logs")],
      resource_types: ["aws_s3_bucket", "aws_s3_bucket_versioning"],
    };
    const candidates = matchCluster(
      cluster,
      [
        {
          dir: "modules/bucket",
          resourceTypes: ["aws_s3_bucket", "aws_s3_bucket_versioning"],
          requiredVariables: ["bucket_name"],
        },
      ],
      [
        {
          name: "s3-bucket",
          source: "terraform-aws-modules/s3-bucket/aws",
          version: "~> 4.0",
          kind: "registry",
        },
      ],
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      match: "resource_signature",
      source: "./modules/bucket",
      overlap: 1,
      required_variables: ["bucket_name"],
    });
    expect(candidates[1]).toMatchObject({ match: "name_keyword", kind: "registry" });
  });

  it("drops candidates below the overlap floor", () => {
    const cluster = {
      file: "main.tf",
      name_prefix: null,
      resources: [res("aws_vpc", "x"), res("aws_subnet", "y"), res("aws_route_table", "z")],
      resource_types: ["aws_route_table", "aws_subnet", "aws_vpc"],
    };
    const candidates = matchCluster(
      cluster,
      [{ dir: "modules/bucket", resourceTypes: ["aws_s3_bucket"], requiredVariables: [] }],
      [],
    );
    expect(candidates).toEqual([]);
  });
});

const ROOT_TF = `
resource "aws_s3_bucket" "logs_bucket" { bucket = "x" }
resource "aws_s3_bucket_versioning" "logs_versioning" {
  bucket = aws_s3_bucket.logs_bucket.id
}
resource "aws_s3_bucket_public_access_block" "logs_pab" {
  bucket = aws_s3_bucket.logs_bucket.id
}
module "existing" { source = "./modules/bucket" }
`;

const HOUSE_MODULE_TF = `
variable "bucket_name" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}
resource "aws_s3_bucket" "this" { bucket = var.bucket_name }
resource "aws_s3_bucket_versioning" "this" { bucket = aws_s3_bucket.this.id }
resource "aws_s3_bucket_public_access_block" "this" { bucket = aws_s3_bucket.this.id }
`;

describe("findExtractionCandidates", () => {
  it("finds a cluster, matches the house module, and never re-extracts module dirs", () => {
    const cwd = makeDir({
      "main.tf": ROOT_TF,
      "modules/bucket/main.tf": HOUSE_MODULE_TF,
    });

    const found = findExtractionCandidates(cwd, undefined);

    expect(found).toHaveLength(1);
    // all three resources share the prefix, so the cluster covers the whole file.
    expect(found[0]?.cluster).toMatchObject({ file: "main.tf", name_prefix: null });
    expect(found[0]?.candidates[0]).toMatchObject({
      match: "resource_signature",
      source: "./modules/bucket",
      overlap: 1,
      required_variables: ["bucket_name"],
    });
  });

  it("matches catalogue entries by service keyword when no house module fits", () => {
    const cwd = makeDir({
      "main.tf": ROOT_TF.replace(`module "existing" { source = "./modules/bucket" }`, ""),
    });

    const found = findExtractionCandidates(cwd, "terraform-aws-modules/s3-bucket/aws ~> 4.0");

    expect(found).toHaveLength(1);
    expect(found[0]?.candidates[0]).toMatchObject({
      match: "name_keyword",
      source: "terraform-aws-modules/s3-bucket/aws",
      version: "~> 4.0",
    });
  });
});

describe("ModuleExtractionCandidatesTool", () => {
  it("returns the ok envelope with clusters and the verify note", async () => {
    const cwd = makeDir({
      "main.tf": ROOT_TF,
      "modules/bucket/main.tf": HOUSE_MODULE_TF,
    });
    const ctx = {
      payload: { cwd },
      toolState: {},
      tmpdir: makeDir(),
    } as unknown as LocalToolContext;
    const fn = ModuleExtractionCandidatesTool(ctx).execute as (
      p: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const result = await fn({});

    expect(result).toMatchObject({ ok: true, cluster_count: 1, matched_count: 1 });
    expect(String(result.note)).toContain("refactor_safe");
  });

  it("degrades green on a workspace with nothing to extract", async () => {
    const cwd = makeDir({ "main.tf": `resource "aws_instance" "web" {}` });
    const ctx = {
      payload: { cwd },
      toolState: {},
      tmpdir: makeDir(),
    } as unknown as LocalToolContext;
    const fn = ModuleExtractionCandidatesTool(ctx).execute as (
      p: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const result = await fn({});

    expect(result).toMatchObject({ ok: true, cluster_count: 0, matched_count: 0 });
  });
});
