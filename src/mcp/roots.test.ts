import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectEnvironmentTwins,
  discoverTerraformRoots,
  isRootModuleHcl,
  TerraformRootsTool,
} from "#app/mcp/roots";
import type { ToolContext } from "#app/mcp/server";

describe("isRootModuleHcl", () => {
  it("detects a provider configuration block (root)", () => {
    expect(isRootModuleHcl('provider "aws" {\n  region = "eu-west-2"\n}')).toEqual({
      hasBackend: false,
      hasProviderConfig: true,
    });
  });

  it("detects a backend block (root)", () => {
    expect(isRootModuleHcl('terraform {\n  backend "s3" {}\n}').hasBackend).toBe(true);
  });

  it("does NOT treat a child module's required_providers as a root", () => {
    const moduleHcl = `terraform {
      required_providers {
        aws = { source = "hashicorp/aws", version = ">= 5.0" }
      }
    }`;
    expect(isRootModuleHcl(moduleHcl)).toEqual({ hasBackend: false, hasProviderConfig: false });
  });
});

describe("discoverTerraformRoots (multi-root, hepcare layout)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tf-roots-"));
    // root #1: terraform/ with backend + provider config
    mkdirSync(join(root, "terraform"), { recursive: true });
    writeFileSync(
      join(root, "terraform", "providers.tf"),
      'terraform {\n  backend "s3" {}\n}\nprovider "aws" {\n  region = "eu-west-2"\n}',
    );
    writeFileSync(join(root, "terraform", "main.tf"), 'resource "aws_s3_bucket" "b" {}');
    // root #2: terraform/core/ with a provider config
    mkdirSync(join(root, "terraform", "core"), { recursive: true });
    writeFileSync(join(root, "terraform", "core", "providers.tf"), 'provider "aws" {}');
    // child module: terraform/modules/x — only required_providers (NOT a root)
    mkdirSync(join(root, "terraform", "modules", "x"), { recursive: true });
    writeFileSync(
      join(root, "terraform", "modules", "x", "versions.tf"),
      'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n  }\n}',
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("finds the two roots and excludes the child module", () => {
    const roots = discoverTerraformRoots(root);
    expect(roots.map((r) => r.dir)).toEqual(["terraform", "terraform/core"]);
    expect(roots[0]).toMatchObject({ hasBackend: true, hasProviderConfig: true });
    expect(roots[1]).toMatchObject({ hasBackend: false, hasProviderConfig: true });
    expect(roots.some((r) => r.dir.includes("modules"))).toBe(false);
  });

  it("returns empty when no provider/backend is configured anywhere", () => {
    const empty = mkdtempSync(join(tmpdir(), "tf-noroot-"));
    writeFileSync(join(empty, "main.tf"), 'resource "aws_s3_bucket" "b" {}');
    expect(discoverTerraformRoots(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("detectEnvironmentTwins (§22)", () => {
  it("groups dev/staging/prod stacks that differ only by an env segment", () => {
    const twins = detectEnvironmentTwins([
      "environments/dev",
      "environments/staging",
      "environments/prod",
    ]);
    expect(twins).toHaveLength(1);
    expect(twins[0]!.pattern).toBe("environments/{env}");
    expect(twins[0]!.members.map((m) => m.environment)).toEqual(["dev", "prod", "staging"]);
  });

  it("matches the LAST env segment so nested paths key correctly", () => {
    const twins = detectEnvironmentTwins(["infra/prod/network", "infra/dev/network"]);
    expect(twins[0]!.pattern).toBe("infra/{env}/network");
    expect(twins[0]!.members.map((m) => m.environment)).toEqual(["dev", "prod"]);
  });

  it("detects per-region twins", () => {
    const twins = detectEnvironmentTwins(["stacks/eu-west-2", "stacks/eu-west-1"]);
    expect(twins[0]!.pattern).toBe("stacks/{env}");
    expect(twins[0]!.members.map((m) => m.environment)).toEqual(["eu-west-1", "eu-west-2"]);
  });

  it("matches a <env>.tfvars filename", () => {
    const twins = detectEnvironmentTwins(["env/dev.tfvars", "env/prod.tfvars"]);
    expect(twins[0]!.pattern).toBe("env/{env}.tfvars");
    expect(twins[0]!.members.map((m) => m.environment)).toEqual(["dev", "prod"]);
  });

  it("does NOT group a single environment (needs ≥2 distinct)", () => {
    expect(detectEnvironmentTwins(["environments/prod"])).toEqual([]);
    // same env twice → still one distinct → not a twin set.
    expect(detectEnvironmentTwins(["a/prod", "a/prod"])).toEqual([]);
  });

  it("ignores paths with no env/region segment", () => {
    expect(detectEnvironmentTwins(["modules/vpc", "modules/s3"])).toEqual([]);
  });
});

describe("TerraformRootsTool", () => {
  async function runRootsTool(cwd: string): Promise<string> {
    const tool = TerraformRootsTool({ payload: { cwd } } as unknown as ToolContext);
    const exec = tool.execute as (
      p: unknown,
      c: unknown,
    ) => Promise<{ content: [{ type: "text"; text: string }] }>;
    const result = await exec({}, {});
    return result.content[0].text;
  }

  let multiRoot: string;
  let twinRoot: string;
  let singleRoot: string;

  beforeAll(() => {
    multiRoot = mkdtempSync(join(tmpdir(), "tf-rootstool-"));
    mkdirSync(join(multiRoot, "core"), { recursive: true });
    writeFileSync(join(multiRoot, "main.tf"), 'provider "aws" {}');
    writeFileSync(join(multiRoot, "core", "main.tf"), 'terraform {\n  backend "s3" {}\n}');

    twinRoot = mkdtempSync(join(tmpdir(), "tf-rootstwin-"));
    for (const env of ["dev", "prod"]) {
      mkdirSync(join(twinRoot, "stacks", env), { recursive: true });
      writeFileSync(join(twinRoot, "stacks", env, "main.tf"), 'provider "aws" {}');
    }

    singleRoot = mkdtempSync(join(tmpdir(), "tf-rootsone-"));
    writeFileSync(join(singleRoot, "main.tf"), 'provider "aws" {}');
  });

  afterAll(() => {
    rmSync(multiRoot, { recursive: true, force: true });
    rmSync(twinRoot, { recursive: true, force: true });
    rmSync(singleRoot, { recursive: true, force: true });
  });

  it("reports multiple roots with the per-root flags and the multi-root note", async () => {
    const text = await runRootsTool(multiRoot);
    expect(text).toContain("root_count: 2");
    expect(text).toContain("has_backend");
    expect(text).toContain("has_provider_config");
    expect(text).toContain("Multiple roots");
    expect(text).toContain("environment_twins: []");
  });

  it("reports environment twins among parallel stacks", async () => {
    const text = await runRootsTool(twinRoot);
    expect(text).toContain("root_count: 2");
    expect(text).toContain("stacks/{env}");
    expect(text).toContain("Detected environment twins");
  });

  it("reports a single root with the single-root note", async () => {
    const text = await runRootsTool(singleRoot);
    expect(text).toContain("root_count: 1");
    expect(text).toContain("Single root (or none detected)");
  });
});
