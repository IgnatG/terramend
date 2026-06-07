import { describe, expect, it } from "vitest";
import {
  classifyModuleSource,
  collectModuleGraph,
  isInLocalModule,
  type ModuleGraph,
  parseModuleBlocks,
  parseModuleCatalogue,
} from "#app/mcp/modules";

describe("classifyModuleSource", () => {
  it("classifies local paths", () => {
    expect(classifyModuleSource("./modules/vpc")).toBe("local");
    expect(classifyModuleSource("../shared/net")).toBe("local");
    expect(classifyModuleSource("/abs/mod")).toBe("local");
  });

  it("classifies registry shorthand (with and without host)", () => {
    expect(classifyModuleSource("terraform-aws-modules/vpc/aws")).toBe("registry");
    expect(classifyModuleSource("app.terraform.io/acme/vpc/aws")).toBe("registry");
  });

  it("classifies git and remote sources", () => {
    expect(classifyModuleSource("git::https://github.com/acme/mod.git")).toBe("git");
    expect(classifyModuleSource("github.com/acme/mod")).toBe("git");
    expect(classifyModuleSource("git@github.com:acme/mod.git")).toBe("git");
    expect(classifyModuleSource("s3::https://bucket.s3.amazonaws.com/mod.zip")).toBe("remote");
  });

  it("returns unknown for an unparseable source", () => {
    expect(classifyModuleSource("")).toBe("unknown");
    expect(classifyModuleSource("just-a-name")).toBe("unknown");
  });
});

describe("parseModuleCatalogue", () => {
  it("parses name=source version, deriving name and version kind", () => {
    const out = parseModuleCatalogue("vpc=terraform-aws-modules/vpc/aws ~> 5.0");
    expect(out).toEqual([
      { name: "vpc", source: "terraform-aws-modules/vpc/aws", version: "~> 5.0", kind: "registry" },
    ]);
  });

  it("derives a name from a registry source when none is given", () => {
    const [m] = parseModuleCatalogue("terraform-aws-modules/s3-bucket/aws");
    expect(m.name).toBe("s3-bucket");
    expect(m.version).toBeNull();
    expect(m.kind).toBe("registry");
  });

  it("handles local module paths and derives a name from the last segment", () => {
    const [m] = parseModuleCatalogue("./modules/networking");
    expect(m).toMatchObject({ source: "./modules/networking", kind: "local", name: "networking" });
  });

  it("splits newline- and comma-separated entries and dedups", () => {
    const out = parseModuleCatalogue(
      "terraform-aws-modules/vpc/aws ~> 5.0\n./modules/net, terraform-aws-modules/vpc/aws ~> 5.0"
    );
    expect(out).toHaveLength(2);
  });

  it("returns nothing for empty input", () => {
    expect(parseModuleCatalogue(undefined)).toEqual([]);
    expect(parseModuleCatalogue("  \n , ")).toEqual([]);
  });
});

describe("parseModuleBlocks", () => {
  it("parses module name, source, version and classifies the source", () => {
    const hcl = `
      module "vpc" {
        source  = "terraform-aws-modules/vpc/aws"
        version = "~> 5.0"
        cidr    = "10.0.0.0/16"
      }
      module "net" {
        source = "./modules/net"
      }`;
    expect(parseModuleBlocks(hcl)).toEqual([
      { name: "vpc", source: "terraform-aws-modules/vpc/aws", version: "~> 5.0", kind: "registry", declaredIn: "" },
      { name: "net", source: "./modules/net", version: null, kind: "local", declaredIn: "" },
    ]);
  });

  it("brace-matches a block containing a nested map (providers)", () => {
    const hcl = `
      module "a" {
        source    = "./mod"
        providers = { aws = aws.useast1 }
      }`;
    const out = parseModuleBlocks(hcl);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "a", source: "./mod", kind: "local" });
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

  it("matches a file inside a local module dir", () => {
    expect(isInLocalModule("modules/net/vpc.tf", graph)?.dir).toBe("modules/net");
    expect(isInLocalModule("./modules/net/vpc.tf", graph)?.dir).toBe("modules/net");
  });

  it("does not match a file outside any local module dir", () => {
    expect(isInLocalModule("main.tf", graph)).toBeNull();
    expect(isInLocalModule("modules/netx/vpc.tf", graph)).toBeNull();
  });
});

describe("collectModuleGraph (filesystem)", () => {
  it("returns an empty graph for a non-existent dir (best-effort)", () => {
    const g = collectModuleGraph("/definitely/does/not/exist/xyz");
    expect(g).toEqual({ modules: [], localModuleDirs: [], externalCount: 0 });
  });
});
