import { describe, expect, it } from "vitest";
import { scaffoldTerraformTest, scaffoldTerratest } from "#app/mcp/terratest";

describe("scaffoldTerratest (§28)", () => {
  it("emits a plan-only Go test + a native test, and no examples/ fixture", () => {
    const s = scaffoldTerratest({ moduleName: "vpc", modulePath: "modules/vpc" });
    const paths = s.files.map((f) => f.path);
    expect(paths).toEqual([
      "test/vpc_test.go",
      "modules/vpc/tests/vpc.tftest.hcl",
    ]);
    expect(paths.some((p) => p.startsWith("examples/"))).toBe(false);
  });

  it("points the Go test's TerraformDir at the module dir (not an example)", () => {
    const s = scaffoldTerratest({ moduleName: "vpc", modulePath: "modules/vpc" });
    const go = s.files.find((f) => f.path === "test/vpc_test.go")!.content;
    // from test/ → up one level → modules/vpc
    expect(go).toContain('TerraformDir: "../modules/vpc"');
    expect(go).not.toContain("examples/");
  });

  it("PascalCases the Go test function and is plan-only (no apply)", () => {
    const s = scaffoldTerratest({ moduleName: "my-cool-vpc", modulePath: "modules/x" });
    const go = s.files.find((f) => f.path.endsWith("_test.go"))!.content;
    expect(go).toContain("func TestMyCoolVpc(t *testing.T)");
    expect(go).toContain("InitAndPlan");
    expect(go).not.toMatch(/InitAndApply|\bApply\b/);
  });

  it("surfaces the module's variables as TODO placeholders in both tests", () => {
    const s = scaffoldTerratest({
      moduleName: "s3",
      modulePath: "modules/s3",
      variables: [{ name: "bucket_name", required: true }, { name: "tags" }],
    });
    const go = s.files.find((f) => f.path === "test/s3_test.go")!.content;
    expect(go).toContain('// "bucket_name": nil, // (required)');
    expect(go).toContain('// "tags": nil, // (optional)');
    const native = s.files.find((f) => f.path === "modules/s3/tests/s3.tftest.hcl")!.content;
    expect(native).toContain("# bucket_name = null # (required)");
    expect(native).toContain("# tags = null # (optional)");
  });

  it("sanitizes a name with odd characters for the path and function", () => {
    const s = scaffoldTerratest({ moduleName: "aws/s3 bucket", modulePath: "modules/s3" });
    const go = s.files.find((f) => f.path.endsWith("_test.go"))!.content;
    expect(go).toContain("func TestAwsS3Bucket(");
    expect(s.files.some((f) => f.path === "test/aws-s3-bucket_test.go")).toBe(true);
  });

  it("bundles a Terraform-native test that plans the module in place", () => {
    const s = scaffoldTerratest({ moduleName: "vpc", modulePath: "modules/vpc" });
    const native = s.files.find((f) => f.path === "modules/vpc/tests/vpc.tftest.hcl")!;
    expect(native.content).toContain("command = plan");
    expect(native.content).not.toContain("examples/");
  });
});

describe("scaffoldTerraformTest (§28 native variant)", () => {
  it("emits a plan-only .tftest.hcl run block inside the module's tests/ dir", () => {
    const f = scaffoldTerraformTest({ moduleName: "my-vpc", modulePath: "modules/my-vpc" });
    expect(f.path).toBe("modules/my-vpc/tests/my-vpc.tftest.hcl");
    expect(f.content).toContain('run "plan_my_vpc"');
    expect(f.content).toContain("command = plan");
    expect(f.content).not.toMatch(/command\s*=\s*apply/);
  });
});
