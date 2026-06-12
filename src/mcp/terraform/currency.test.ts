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
  checkVersionCurrency,
  classifyCurrency,
  fetchModuleVersions,
  fetchProviderVersions,
  terraformConstraintToRange,
} from "#app/mcp/terraform/currency";
import { TerraformVersionCurrencyTool } from "#app/mcp/terraform/tools";

const tempDirs: string[] = [];

function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "terramend-currency-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function makeCtx(cwd: string): LocalToolContext {
  return {
    payload: { cwd },
    toolState: {},
    tmpdir: makeDir(),
  } as unknown as LocalToolContext;
}

/** stub global fetch with a per-URL dispatcher returning JSON bodies. */
function stubFetch(dispatch: (url: string) => { status: number; body?: unknown } | "reject") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const result = dispatch(String(input));
      if (result === "reject") throw new Error("network down");
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.body,
      } as Response;
    }),
  );
}

function providerBody(versions: string[]): unknown {
  return { versions: versions.map((v) => ({ version: v })) };
}

function moduleBody(versions: string[]): unknown {
  return { modules: [{ versions: versions.map((v) => ({ version: v })) }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("terraformConstraintToRange", () => {
  it.each([
    ["~> 5.0", ">=5.0.0 <6.0.0"],
    ["~> 5.1.2", ">=5.1.2 <5.2.0"],
    ["~> 5", ">=5.0.0 <6.0.0"],
    [">= 1.2, < 2.0", ">=1.2.0 <2.0.0"],
    ["= 5.1.0", "5.1.0"],
    ["5.1.0", "5.1.0"],
    ["v1.2", "1.2.0"],
    ["<= 3", "<=3.0.0"],
  ])("converts %s → %s", (constraint, expected) => {
    expect(terraformConstraintToRange(constraint)).toBe(expected);
  });

  it("skips != comparators but keeps the rest", () => {
    expect(terraformConstraintToRange(">= 1.0, != 1.5")).toBe(">=1.0.0");
  });

  it("returns null for garbage or empty input", () => {
    expect(terraformConstraintToRange("latest")).toBeNull();
    expect(terraformConstraintToRange("")).toBeNull();
    expect(terraformConstraintToRange("~> banana")).toBeNull();
  });
});

describe("classifyCurrency", () => {
  const available = ["4.9.0", "5.0.0", "5.31.0", "6.2.1", "7.0.0-beta1"];

  it("flags a pessimistic pin a major behind (prereleases ignored)", () => {
    const verdict = classifyCurrency({ constraint: "~> 5.0", available });
    expect(verdict).toEqual({
      latest: "6.2.1",
      newestSatisfying: "5.31.0",
      outdated: true,
      majorsBehind: 1,
    });
  });

  it("reports current when the constraint admits the latest", () => {
    const verdict = classifyCurrency({ constraint: ">= 5.0", available });
    expect(verdict).toEqual({
      latest: "6.2.1",
      newestSatisfying: "6.2.1",
      outdated: false,
      majorsBehind: 0,
    });
  });

  it("is never outdated without a constraint (that's `unpinned`, not outdated)", () => {
    const verdict = classifyCurrency({ constraint: null, available });
    expect(verdict).toEqual({
      latest: "6.2.1",
      newestSatisfying: null,
      outdated: false,
      majorsBehind: 0,
    });
  });

  it("degrades green when the registry publishes nothing stable", () => {
    const verdict = classifyCurrency({ constraint: "~> 1.0", available: ["2.0.0-rc1"] });
    expect(verdict).toEqual({
      latest: null,
      newestSatisfying: null,
      outdated: false,
      majorsBehind: 0,
    });
  });

  it("treats an exact old pin as outdated", () => {
    const verdict = classifyCurrency({ constraint: "4.9.0", available });
    expect(verdict.outdated).toBe(true);
    expect(verdict.majorsBehind).toBe(2);
  });
});

describe("registry fetchers", () => {
  it("fetches provider versions from the v1 providers endpoint", async () => {
    stubFetch((url) => {
      expect(url).toBe("https://registry.terraform.io/v1/providers/hashicorp/aws/versions");
      return { status: 200, body: providerBody(["5.0.0", "5.1.0"]) };
    });
    await expect(fetchProviderVersions("hashicorp/aws")).resolves.toEqual({
      status: "ok",
      versions: ["5.0.0", "5.1.0"],
    });
  });

  it("strips the default registry host and rejects other hosts", async () => {
    stubFetch((url) => {
      expect(url).toContain("/v1/providers/hashicorp/aws/versions");
      return { status: 200, body: providerBody(["5.0.0"]) };
    });
    await expect(
      fetchProviderVersions("registry.terraform.io/hashicorp/aws"),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(fetchProviderVersions("tfe.example.com/org/aws")).resolves.toEqual({
      status: "unsupported_source",
      versions: [],
    });
  });

  it("reads the first module record from the modules endpoint", async () => {
    stubFetch((url) => {
      expect(url).toBe(
        "https://registry.terraform.io/v1/modules/terraform-aws-modules/vpc/aws/versions",
      );
      return { status: 200, body: moduleBody(["5.0.0", "5.8.1"]) };
    });
    await expect(fetchModuleVersions("terraform-aws-modules/vpc/aws")).resolves.toEqual({
      status: "ok",
      versions: ["5.0.0", "5.8.1"],
    });
  });

  it("maps 404 / network failure / bad body to per-lookup statuses", async () => {
    stubFetch(() => ({ status: 404 }));
    await expect(fetchProviderVersions("hashicorp/gone")).resolves.toMatchObject({
      status: "not_found",
    });
    stubFetch(() => "reject");
    await expect(fetchProviderVersions("hashicorp/aws")).resolves.toMatchObject({
      status: "error",
    });
    stubFetch(() => ({ status: 200, body: { unexpected: true } }));
    await expect(fetchProviderVersions("hashicorp/aws")).resolves.toMatchObject({
      status: "error",
    });
  });
});

const tf = `
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 4.0"
    }
  }
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "3.0.0"
}

module "unpinned" {
  source = "terraform-aws-modules/s3-bucket/aws"
}

module "local_helper" {
  source = "./modules/helper"
}
`;

describe("checkVersionCurrency", () => {
  it("reports outdated providers + modules, unpinned modules, and skips local modules", async () => {
    const cwd = makeDir({ "main.tf": tf, "modules/helper/main.tf": "" });
    stubFetch((url) => {
      if (url.includes("/v1/providers/hashicorp/aws/"))
        return { status: 200, body: providerBody(["4.67.0", "5.31.0"]) };
      if (url.includes("/v1/modules/terraform-aws-modules/vpc/aws/"))
        return { status: 200, body: moduleBody(["3.0.0", "5.8.1"]) };
      if (url.includes("/v1/modules/terraform-aws-modules/s3-bucket/aws/"))
        return { status: 200, body: moduleBody(["4.1.2"]) };
      throw new Error(`unexpected url: ${url}`);
    });

    const report = await checkVersionCurrency(cwd);

    expect(report.providers).toEqual([
      {
        name: "aws",
        source: "hashicorp/aws",
        constraint: "~> 4.0",
        latest: "5.31.0",
        newest_satisfying: "4.67.0",
        outdated: true,
        majors_behind: 1,
        lookup: "ok",
      },
    ]);
    // local module dropped; registry modules classified.
    expect(report.modules).toHaveLength(2);
    expect(report.modules[0]).toMatchObject({
      name: "vpc",
      version: "3.0.0",
      latest: "5.8.1",
      outdated: true,
      unpinned: false,
      declared_in: "main.tf",
    });
    expect(report.modules[1]).toMatchObject({
      name: "unpinned",
      latest: "4.1.2",
      outdated: false,
      unpinned: true,
    });
    expect(report.outdated_count).toBe(2);
    expect(report.unpinned_count).toBe(1);
    expect(report.lookups_failed).toBe(0);
  });

  it("degrades one failed lookup to its row without hiding the rest", async () => {
    const cwd = makeDir({ "main.tf": tf, "modules/helper/main.tf": "" });
    stubFetch((url) => {
      if (url.includes("/v1/providers/")) return "reject";
      return { status: 200, body: moduleBody(["9.0.0"]) };
    });

    const report = await checkVersionCurrency(cwd);

    expect(report.providers[0]).toMatchObject({ lookup: "error", outdated: false });
    expect(report.modules.every((m) => m.lookup === "ok")).toBe(true);
    expect(report.lookups_failed).toBe(1);
    expect(report.lookups_attempted).toBe(3);
  });
});

describe("TerraformVersionCurrencyTool", () => {
  it("returns the ok envelope with the report", async () => {
    const cwd = makeDir({ "main.tf": tf, "modules/helper/main.tf": "" });
    stubFetch((url) =>
      url.includes("/v1/providers/")
        ? { status: 200, body: providerBody(["4.67.0", "5.31.0"]) }
        : { status: 200, body: moduleBody(["5.8.1"]) },
    );
    const fn = TerraformVersionCurrencyTool(makeCtx(cwd)).execute as (
      p: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const result = await fn({});

    expect(result).toMatchObject({ ok: true, outdated_count: 2, unpinned_count: 1 });
  });

  it("returns the registry_unreachable skip envelope when every lookup fails", async () => {
    const cwd = makeDir({ "main.tf": tf, "modules/helper/main.tf": "" });
    stubFetch(() => "reject");
    const fn = TerraformVersionCurrencyTool(makeCtx(cwd)).execute as (
      p: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const result = await fn({});

    expect(result).toMatchObject({ ok: false, code: "registry_unreachable" });
  });

  it("degrades green on a workspace with nothing to check", async () => {
    const cwd = makeDir({ "main.tf": `resource "null_resource" "x" {}` });
    stubFetch(() => {
      throw new Error("no lookups expected");
    });
    const fn = TerraformVersionCurrencyTool(makeCtx(cwd)).execute as (
      p: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const result = await fn({});

    expect(result).toMatchObject({ ok: true, outdated_count: 0, unpinned_count: 0 });
  });
});
