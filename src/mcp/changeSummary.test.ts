import { describe, expect, it } from "vitest";
import { parseBlockAddress, summarizeTerraformResourceDiff } from "#app/mcp/changeSummary";

describe("parseBlockAddress", () => {
  it("parses two-label resource/data blocks into addresses", () => {
    expect(parseBlockAddress('resource "aws_s3_bucket" "logs" {')).toBe("aws_s3_bucket.logs");
    expect(parseBlockAddress('  data "aws_ami" "ubuntu" {')).toBe("data.aws_ami.ubuntu");
  });

  it("parses single-label module/variable/output/provider blocks", () => {
    expect(parseBlockAddress('module "vpc" {')).toBe("module.vpc");
    expect(parseBlockAddress('variable "region" {')).toBe("var.region");
    expect(parseBlockAddress('output "url" {')).toBe("output.url");
    expect(parseBlockAddress('provider "aws" {')).toBe("provider.aws");
  });

  it("returns null for non-block lines", () => {
    expect(parseBlockAddress('  cidr_blocks = ["10.0.0.0/16"]')).toBeNull();
    expect(parseBlockAddress("}")).toBeNull();
    expect(parseBlockAddress('resource "aws_s3_bucket" {')).toBeNull(); // missing name label
  });
});

describe("summarizeTerraformResourceDiff", () => {
  it("collects added/removed block addresses and touched files, ignoring non-tf files", () => {
    const diff = `diff --git a/main.tf b/main.tf
--- a/main.tf
+++ b/main.tf
@@ -1,3 +1,8 @@
+resource "aws_s3_bucket" "logs" {
+  bucket = "x"
+}
-resource "aws_launch_configuration" "web" {
-  image_id = "ami-1"
-}
   cidr_blocks = ["10.0.0.0/16"]
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
+resource "aws_s3_bucket" "not_terraform" {
`;
    const s = summarizeTerraformResourceDiff(diff);
    expect(s.added).toEqual(["aws_s3_bucket.logs"]);
    expect(s.removed).toEqual(["aws_launch_configuration.web"]);
    // the README "resource" line must NOT be counted (not a .tf file)
    expect(s.added).not.toContain("aws_s3_bucket.not_terraform");
    expect(s.files).toEqual(["main.tf"]);
    expect(s.counts).toEqual({ added: 1, removed: 1, files: 1 });
  });

  it("surfaces an in-place block edit as a touched file (not an added/removed address)", () => {
    const diff = `diff --git a/vpc.tf b/vpc.tf
--- a/vpc.tf
+++ b/vpc.tf
@@ -2,3 +2,3 @@ resource "aws_security_group" "db" {
-  description = "old"
+  description = "new"
`;
    const s = summarizeTerraformResourceDiff(diff);
    expect(s.added).toEqual([]);
    expect(s.removed).toEqual([]);
    expect(s.files).toEqual(["vpc.tf"]);
  });

  it("counts a new module addition across a new .tf file", () => {
    const diff = `diff --git a/modules.tf b/modules.tf
--- /dev/null
+++ b/modules.tf
@@ -0,0 +1,4 @@
+module "vpc" {
+  source = "./modules/vpc"
+}
`;
    const s = summarizeTerraformResourceDiff(diff);
    expect(s.added).toEqual(["module.vpc"]);
    expect(s.files).toEqual(["modules.tf"]);
  });

  it("is empty for a diff that touches no Terraform files", () => {
    const diff = `diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -1 +1 @@
+print("hi")
`;
    expect(summarizeTerraformResourceDiff(diff)).toEqual({
      added: [],
      removed: [],
      files: [],
      counts: { added: 0, removed: 0, files: 0 },
    });
  });
});
