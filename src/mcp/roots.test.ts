import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverTerraformRoots, isRootModuleHcl } from "#app/mcp/roots";

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
      'terraform {\n  backend "s3" {}\n}\nprovider "aws" {\n  region = "eu-west-2"\n}'
    );
    writeFileSync(join(root, "terraform", "main.tf"), 'resource "aws_s3_bucket" "b" {}');
    // root #2: terraform/core/ with a provider config
    mkdirSync(join(root, "terraform", "core"), { recursive: true });
    writeFileSync(join(root, "terraform", "core", "providers.tf"), 'provider "aws" {}');
    // child module: terraform/modules/x — only required_providers (NOT a root)
    mkdirSync(join(root, "terraform", "modules", "x"), { recursive: true });
    writeFileSync(
      join(root, "terraform", "modules", "x", "versions.tf"),
      'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n  }\n}'
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
