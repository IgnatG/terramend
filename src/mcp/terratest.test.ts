import { describe, expect, it } from "vitest";
import { scaffoldTerratest } from "#app/mcp/terratest";

describe("scaffoldTerratest (§28)", () => {
  it("emits an example fixture + versions + a plan-only Go test", () => {
    const s = scaffoldTerratest({ moduleName: "vpc", modulePath: "modules/vpc" });
    const paths = s.files.map((f) => f.path);
    expect(paths).toEqual(["examples/vpc/main.tf", "examples/vpc/versions.tf", "test/vpc_test.go"]);
  });

  it("computes the example's relative source back to the module dir", () => {
    const s = scaffoldTerratest({ moduleName: "vpc", modulePath: "modules/vpc" });
    const main = s.files.find((f) => f.path === "examples/vpc/main.tf")!.content;
    // from examples/vpc → up two levels → modules/vpc
    expect(main).toContain('source = "../../modules/vpc"');
    expect(main).toContain('module "vpc"');
  });

  it("PascalCases the Go test function and is plan-only (no apply)", () => {
    const s = scaffoldTerratest({ moduleName: "my-cool-vpc", modulePath: "modules/x" });
    const go = s.files.find((f) => f.path.endsWith("_test.go"))!.content;
    expect(go).toContain("func TestMyCoolVpc(t *testing.T)");
    expect(go).toContain("InitAndPlan");
    expect(go).not.toMatch(/InitAndApply|\bApply\b/);
  });

  it("surfaces the module's variables as TODO placeholders in the example", () => {
    const s = scaffoldTerratest({
      moduleName: "s3",
      modulePath: "modules/s3",
      variables: [{ name: "bucket_name", required: true }, { name: "tags" }],
    });
    const main = s.files.find((f) => f.path === "examples/s3/main.tf")!.content;
    expect(main).toContain("bucket_name = ... (required)");
    expect(main).toContain("tags = ... (optional)");
  });

  it("sanitizes a name with odd characters for the path and function", () => {
    const s = scaffoldTerratest({ moduleName: "aws/s3 bucket", modulePath: "modules/s3" });
    const go = s.files.find((f) => f.path.endsWith("_test.go"))!.content;
    expect(go).toContain("func TestAwsS3Bucket(");
    expect(s.files.some((f) => f.path.startsWith("examples/aws-s3-bucket/"))).toBe(true);
  });
});
