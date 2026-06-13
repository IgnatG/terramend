import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the subprocess boundary: every scanner / terraform / git / infracost
// invocation funnels through `spawnSync` (via `run()` in terraform/types.ts and
// `loadProvidersSchema`), so one dispatcher fakes the whole toolchain.
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

// Unwrap the ToolResult envelope so tests assert on the raw object a tool
// returns instead of decoding the encoded MCP text content.
vi.mock("#app/mcp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/mcp/shared")>();
  return {
    ...actual,
    execute: <T, R>(fn: (params: T) => Promise<R>): ((params: T) => Promise<R>) => fn,
  };
});

import { _clearProviderSchemaCache } from "#app/mcp/providerSchema";
import type { ToolContext } from "#app/mcp/server";
import { changedTerraformFiles } from "#app/mcp/terraform/scanners";
import {
  InfracostDiffTool,
  ReadFindingsTool,
  TerraformEmitSarifTool,
  TerraformPlanTool,
  TerraformScanTool,
  TerraformValidateTool,
  TerraformVerifyRemediationTool,
} from "#app/mcp/terraform/tools";
import { concernId } from "#app/mcp/terraform/types";
import { parseToolSelection } from "#app/utils/toolSelection";

// --- fake subprocess plumbing ----------------------------------------------

interface FakeSpawnResult {
  status?: number;
  stdout?: string;
  stderr?: string;
  /** simulate the binary being absent from PATH (ENOENT). */
  missing?: boolean;
}

type SpawnDispatch = (cmd: string, args: string[], cwd: string) => FakeSpawnResult;

const MISSING: FakeSpawnResult = { missing: true };
let dispatch: SpawnDispatch = () => MISSING;

const tempDirs: string[] = [];

function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "terramend-tools-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function makeCtx(
  cwd: string,
  over: { payload?: Record<string, unknown>; toolState?: Record<string, unknown> } = {},
): ToolContext {
  return {
    // §1.5 — default these tests to the full toolchain (`tools_enabled: all`) so
    // they exercise every scanner; the licence gate's default (non-permissive
    // tools off) is covered explicitly in the gate tests + toolSelection.test.ts.
    // `over.payload` can override (e.g. pass toolsEnabled: undefined to assert the
    // bare default).
    payload: { cwd, toolsEnabled: parseToolSelection("all"), ...(over.payload ?? {}) },
    toolState: { ...(over.toolState ?? {}) },
    tmpdir: makeDir(),
  } as unknown as ToolContext;
}

type RawToolResult = Record<string, unknown>;

/** call a tool's (identity-mocked) execute and return the raw result object. */
function runTool(
  toolDef: { execute: unknown },
  params: Record<string, unknown> = {},
): Promise<RawToolResult> {
  const fn = toolDef.execute as (p: Record<string, unknown>) => Promise<RawToolResult>;
  return fn(params);
}

/** type-tightened indexed access (keeps `noUncheckedIndexedAccess` happy
 * without non-null assertions). */
function at<T = Record<string, unknown>>(value: unknown, index: number): T {
  if (!Array.isArray(value)) throw new Error(`expected an array, got ${typeof value}`);
  const item = value[index] as T | undefined;
  if (item === undefined) throw new Error(`expected an element at index ${index}`);
  return item;
}

beforeEach(() => {
  dispatch = () => MISSING;
  _clearProviderSchemaCache();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((cmd: unknown, args: unknown, opts: unknown) => {
    const cwd = String((opts as { cwd?: string } | undefined)?.cwd ?? "");
    const r = dispatch(String(cmd), Array.isArray(args) ? (args as string[]) : [], cwd);
    if (r.missing) {
      return {
        error: Object.assign(new Error(`spawn ${String(cmd)} ENOENT`), { code: "ENOENT" }),
        status: null,
        stdout: "",
        stderr: "",
      };
    }
    return { status: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- canned scanner outputs --------------------------------------------------

const FMT_UNFORMATTED: FakeSpawnResult = { status: 3, stdout: "main.tf\n" };
const VALIDATE_ERROR: FakeSpawnResult = {
  status: 1,
  stdout: JSON.stringify({
    diagnostics: [
      {
        severity: "error",
        summary: "Reference to undeclared resource",
        detail: "A managed resource has not been declared.",
        range: { filename: "main.tf", start: { line: 2 } },
      },
    ],
  }),
};
const TFLINT_ISSUE: FakeSpawnResult = {
  status: 2,
  stdout: JSON.stringify({
    issues: [
      {
        rule: { name: "terraform_unused_declarations", severity: "warning" },
        message: 'variable "unused" is declared but not used',
        range: { filename: "main.tf", start: { line: 4 } },
      },
    ],
  }),
};
const TRIVY_CRITICAL: FakeSpawnResult = {
  status: 0,
  stdout: JSON.stringify({
    Results: [
      {
        Target: "main.tf",
        Misconfigurations: [
          {
            AVDID: "AVD-AWS-0001",
            Severity: "CRITICAL",
            Status: "FAIL",
            Message: 'IAM policy allows all actions with "*"',
            CauseMetadata: { StartLine: 2 },
          },
        ],
      },
    ],
  }),
};
const CLEAN_JSON: FakeSpawnResult = { status: 0, stdout: "{}" };

function scannersDispatch(over: Partial<Record<string, FakeSpawnResult>> = {}): SpawnDispatch {
  return (cmd, args) => {
    if (cmd === "terraform" && args[0] === "fmt") return over.fmt ?? FMT_UNFORMATTED;
    if (cmd === "terraform" && args[0] === "init") return over.init ?? { status: 0 };
    if (cmd === "terraform" && args[0] === "validate") return over.validate ?? VALIDATE_ERROR;
    if (cmd === "terraform" && args[0] === "providers") return over.providers ?? MISSING;
    if (cmd === "tflint") return over.tflint ?? TFLINT_ISSUE;
    if (cmd === "trivy") return over.trivy ?? TRIVY_CRITICAL;
    if (cmd === "checkov") return over.checkov ?? MISSING;
    return over.git ?? MISSING;
  };
}

const FMT_CONCERN_ID = concernId("terraform-fmt", "unformatted", "main.tf", null);

// ============================================================================

describe("TerraformScanTool", () => {
  const tf = 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n';

  it("aggregates concerns from every scanner, groups by file, and reports skips", async () => {
    const cwd = makeDir({ "main.tf": tf });
    dispatch = scannersDispatch();
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformScanTool(ctx));

    expect(result).toMatchObject({ ok: true, scanned_dir: cwd, scope: "full", grouping: "file" });
    expect(result.scanners_ran).toEqual(["terraform-fmt", "terraform-validate", "tflint", "trivy"]);
    expect(result.scanners_skipped).toEqual([
      { source: "checkov", reason: "checkov not installed" },
    ]);
    expect(result.summary).toEqual({
      total: 4,
      groups: 1,
      by_severity: { critical: 1, high: 1, medium: 1, low: 1 },
    });
    // sorted by severity: the trivy critical comes first, with a derived doc url.
    expect(at(result.concerns, 0)).toMatchObject({
      severity: "critical",
      source: "trivy",
      doc_url: "https://avd.aquasec.com/misconfig/avd-aws-0001",
    });
    // §1.4 baseline captured severity-unfiltered.
    expect(ctx.toolState.baselineConcernIds).toHaveLength(4);
    // one file-group, escalated by the critical security finding (§3.9).
    expect(at(result.groups, 0)).toMatchObject({
      file: "main.tf",
      severity: "critical",
      concern_count: 4,
      autonomy: "needs-human",
    });
    // §3.10 — the escalated group is isolated, never batched.
    expect(result.batch_plan).toMatchObject({ batchable: [], batch_branch: null });
    // §30 — validate + trivy both flagged main.tf:2.
    expect(result.co_located).toEqual([
      expect.objectContaining({
        file: "main.tf",
        line: 2,
        sources: ["terraform-validate", "trivy"],
      }),
    ]);
    // §29 — the IAM wildcard finding is a refusal candidate.
    expect(result.refusal_candidates).toHaveLength(1);
    // §21 — a preventive control per distinct rule.
    expect(Object.keys(result.prevention as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["trivy:AVD-AWS-0001", "tflint:terraform_unused_declarations"]),
    );
  });

  it("§1.5 licence-gates tflint off by default and reports it as a gated skip", async () => {
    const cwd = makeDir({ "main.tf": tf });
    dispatch = scannersDispatch();
    // a bare run (no tools_enabled) → the default licence gate applies.
    const ctx = makeCtx(cwd, { payload: { toolsEnabled: undefined } });

    const result = await runTool(TerraformScanTool(ctx));

    // tflint (MPL-2.0) is not run; the permissive scanners still are.
    expect(result.scanners_ran).not.toContain("tflint");
    expect(result.scanners_ran).toEqual(
      expect.arrayContaining(["terraform-fmt", "terraform-validate", "trivy"]),
    );
    // it's surfaced as a licence-gated skip + in the tool_selection summary.
    const tflintSkip = (result.scanners_skipped as Array<{ source: string; reason?: string }>).find(
      (s) => s.source === "tflint",
    );
    expect(tflintSkip?.reason).toMatch(/licence-gated/i);
    expect(result.tool_selection).toMatchObject({
      licence_gated: expect.arrayContaining(["tflint"]),
    });
    // the tflint concern is absent from the baseline, so verify stays consistent.
    expect(ctx.toolState.baselineConcernIds).toHaveLength(3);
  });

  it("§1.5 runs tflint when it is the licence-aware opt-in in tools_enabled", async () => {
    const cwd = makeDir({ "main.tf": tf });
    dispatch = scannersDispatch();
    const ctx = makeCtx(cwd, { payload: { toolsEnabled: parseToolSelection("tflint") } });

    const result = await runTool(TerraformScanTool(ctx));

    expect(result.scanners_ran).toContain("tflint");
    // tflint is no longer gated (it was opted in); terraform_mcp still is.
    const gated = (result.tool_selection as { licence_gated: string[] }).licence_gated;
    expect(gated).not.toContain("tflint");
  });

  it("§1.5 disables a permissive scanner when tools_enabled vetoes it", async () => {
    const cwd = makeDir({ "main.tf": tf });
    dispatch = scannersDispatch();
    const ctx = makeCtx(cwd, { payload: { toolsEnabled: parseToolSelection("all, -trivy") } });

    const result = await runTool(TerraformScanTool(ctx));

    expect(result.scanners_ran).not.toContain("trivy");
    const trivySkip = (result.scanners_skipped as Array<{ source: string; reason?: string }>).find(
      (s) => s.source === "trivy",
    );
    expect(trivySkip?.reason).toMatch(/disabled via tools_enabled/);
    expect(result.tool_selection).toMatchObject({ disabled: expect.arrayContaining(["trivy"]) });
  });

  it("filters by the explicit severity_threshold but keeps the baseline unfiltered", async () => {
    const cwd = makeDir({ "main.tf": tf });
    dispatch = scannersDispatch();
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformScanTool(ctx), { severity_threshold: "high" });

    expect(result.summary).toEqual({
      total: 2,
      groups: 1,
      by_severity: { critical: 1, high: 1 },
    });
    expect(ctx.toolState.baselineConcernIds).toHaveLength(4);
  });

  it("falls back to the run's configured severityThreshold when no arg is given", async () => {
    const cwd = makeDir({ "main.tf": tf });
    dispatch = scannersDispatch();
    const ctx = makeCtx(cwd, { payload: { severityThreshold: "critical" } });

    const result = await runTool(TerraformScanTool(ctx));

    expect(result.summary).toMatchObject({ total: 1 });
  });

  it("diff scope falls back to full (with a note) when the base branch is unknown", async () => {
    const cwd = makeDir({ "main.tf": tf });
    dispatch = scannersDispatch(); // git is "missing" → no base ref
    const ctx = makeCtx(cwd, { payload: { scanScope: "diff" } });

    const result = await runTool(TerraformScanTool(ctx));

    expect(result.scope).toBe("full");
    expect(result.scope_note).toMatch(/base branch could not be determined/);
  });

  it("diff scope keeps only concerns in Terraform files changed vs the base", async () => {
    const cwd = makeDir({ "main.tf": tf });
    const scanners = scannersDispatch();
    dispatch = (cmd, args, dir) => {
      if (cmd === "git" && args[0] === "rev-parse" && args.includes("origin/HEAD")) {
        return { status: 0, stdout: "origin/main\n" };
      }
      if (cmd === "git" && args[0] === "merge-base") return { status: 0, stdout: "abc123\n" };
      if (cmd === "git" && args.includes("--show-prefix")) return { status: 0, stdout: "\n" };
      if (cmd === "git" && args[0] === "diff") return { status: 0, stdout: "other.tf\n" };
      return scanners(cmd, args, dir);
    };
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformScanTool(ctx), { scan_scope: "diff" });

    // every concern lives in main.tf, but only other.tf changed → all filtered.
    expect(result.scope).toBe("diff");
    expect(result.summary).toMatchObject({ total: 0, groups: 0 });
    expect(result.scope_note).toBeUndefined();
  });

  it("group_by rule makes one group per rule across files (§3.11)", async () => {
    const cwd = makeDir({ "main.tf": tf });
    dispatch = scannersDispatch();
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformScanTool(ctx), { group_by: "rule" });

    expect(result.grouping).toBe("rule");
    expect(result.groups).toHaveLength(4);
    expect(at(result.groups, 0)).toMatchObject({ grouping: "rule", concern_count: 1 });
  });

  it("degrades a scanner with unparseable output to skipped instead of failing", async () => {
    const cwd = makeDir({ "main.tf": tf });
    dispatch = scannersDispatch({
      fmt: { status: 0 },
      validate: { status: 0, stdout: "%% not json %%" },
      tflint: { status: 0, stdout: "garbage" },
      trivy: { status: 0, stdout: "also garbage" },
    });
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformScanTool(ctx));

    expect(result.scanners_ran).toEqual(["terraform-fmt"]);
    expect(result.scanners_skipped).toEqual(
      expect.arrayContaining([
        { source: "terraform-validate", reason: expect.stringMatching(/could not parse/) },
        { source: "tflint", reason: expect.stringMatching(/could not parse/) },
        { source: "trivy", reason: expect.stringMatching(/could not parse/) },
      ]),
    );
    expect(result.summary).toMatchObject({ total: 0 });
  });

  it("attempts `tflint --init` when the repo ships a .tflint.hcl", async () => {
    const cwd = makeDir({ "main.tf": tf, ".tflint.hcl": 'plugin "aws" {}' });
    dispatch = scannersDispatch({ tflint: CLEAN_JSON });
    const ctx = makeCtx(cwd);

    await runTool(TerraformScanTool(ctx));

    const tflintCalls = spawnSyncMock.mock.calls.filter((call) => call[0] === "tflint");
    expect(tflintCalls.some((call) => (call[1] as string[])[0] === "--init")).toBe(true);
  });
});

describe("TerraformValidateTool", () => {
  const versionsTf = `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
`;

  it("degrades green when no tool is installed, still reporting pinned providers", async () => {
    const cwd = makeDir({
      "versions.tf": versionsTf,
      "main.tf": 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n',
    });
    dispatch = () => MISSING;
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformValidateTool(ctx));

    expect(result).toMatchObject({
      ok: true,
      passed: true,
      checks_ran: [],
      remaining_issues: [],
      schema_checked: false,
      unknown_arguments: [],
      roots_validated: ["."],
    });
    expect(result.providers).toEqual([
      { name: "aws", source: "hashicorp/aws", version: "~> 5.0", major: 5 },
    ]);
  });

  it("fails the gate when fmt still flags a file", async () => {
    const cwd = makeDir({ "main.tf": 'resource "x" "y" {}\n' });
    dispatch = scannersDispatch({ validate: CLEAN_JSON, tflint: CLEAN_JSON });
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformValidateTool(ctx));

    expect(result.passed).toBe(false);
    expect(result.checks_ran).toEqual(["terraform-fmt", "terraform-validate", "tflint"]);
    expect(at(result.remaining_issues, 0)).toMatchObject({
      rule_id: "terraform-fmt:unformatted",
      location: { file: "main.tf" },
    });
  });

  it("fails closed when a root ran but `validate -json` was unparseable", async () => {
    // terraform ran but emitted non-JSON (corrupted .terraform / crash): we
    // genuinely don't know if the root is valid, so `passed` must be false and
    // `validate_incomplete` flagged — never a green pass on an un-validated root.
    const cwd = makeDir({ "main.tf": 'resource "x" "y" {}\n' });
    dispatch = scannersDispatch({
      fmt: { status: 0 },
      validate: { status: 0, stdout: "%% not json %%" },
      tflint: CLEAN_JSON,
    });
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformValidateTool(ctx));

    expect(result.passed).toBe(false);
    expect(result.validate_incomplete).toBe(true);
    expect(result.remaining_issues).toEqual([]);
    // validate didn't cleanly run, so it's absent from checks_ran.
    expect(result.checks_ran).not.toContain("terraform-validate");
  });

  it("cross-checks written arguments against the installed provider schema (§4.15-next)", async () => {
    const cwd = makeDir({
      "main.tf": 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n  bukcet_typo = "y"\n}\n',
    });
    const schema = JSON.stringify({
      provider_schemas: {
        "registry.terraform.io/hashicorp/aws": {
          resource_schemas: {
            aws_s3_bucket: {
              block: { attributes: { bucket: {} }, block_types: { versioning: {} } },
            },
          },
        },
      },
    });
    dispatch = scannersDispatch({
      fmt: { status: 0 },
      validate: CLEAN_JSON,
      tflint: CLEAN_JSON,
      providers: { status: 0, stdout: schema },
    });
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformValidateTool(ctx));

    // the schema cross-check is ADVISORY — `passed` stays green.
    expect(result.passed).toBe(true);
    expect(result.schema_checked).toBe(true);
    expect(result.unknown_arguments).toEqual([
      { resource_type: "aws_s3_bucket", name: "b", file: "main.tf", unknown: ["bukcet_typo"] },
    ]);
  });
});

describe("TerraformVerifyRemediationTool", () => {
  const cleanButFmt = () =>
    scannersDispatch({ validate: CLEAN_JSON, tflint: MISSING, trivy: MISSING });

  it("partitions concern ids into resolved vs remaining against the re-scan", async () => {
    const cwd = makeDir({ "main.tf": "x\n" });
    dispatch = cleanButFmt();
    const ctx = makeCtx(cwd, { toolState: { baselineConcernIds: [FMT_CONCERN_ID] } });

    const result = await runTool(TerraformVerifyRemediationTool(ctx), {
      concern_ids: [FMT_CONCERN_ID, "feedface0000"],
    });

    expect(result).toMatchObject({
      ok: true,
      verified: false,
      resolved_count: 1,
      remaining_count: 1,
      resolved: ["feedface0000"],
      remaining: [FMT_CONCERN_ID],
      has_regressions: false,
      regressions: [],
      confidence: "low",
    });
    expect(result.regressions_note).toBeUndefined();
    expect(result.scanners_ran).toEqual(["terraform-fmt", "terraform-validate"]);
  });

  it("reports a regression when the fix introduced a concern absent from the baseline", async () => {
    const cwd = makeDir({ "main.tf": "x\n" });
    dispatch = cleanButFmt();
    const ctx = makeCtx(cwd, { toolState: { baselineConcernIds: [] } });

    const result = await runTool(TerraformVerifyRemediationTool(ctx), {
      concern_ids: ["gone000000"],
    });

    expect(result).toMatchObject({
      verified: true,
      has_regressions: true,
      regressions: [FMT_CONCERN_ID],
      confidence: "low", // a regression caps confidence at low even when verified
    });
  });

  it("marks regressions unknown (with a note) when no baseline was captured", async () => {
    const cwd = makeDir({ "main.tf": "x\n" });
    dispatch = cleanButFmt();
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformVerifyRemediationTool(ctx), {
      concern_ids: ["gone000000"],
    });

    expect(result).toMatchObject({ verified: true, has_regressions: false, regressions: [] });
    expect(result.regressions_note).toMatch(/no pre-fix baseline/);
    // verified but missing plan/cost evidence → honest medium, not high (§5.19).
    expect(result.confidence).toBe("medium");
  });

  it("is high-confidence only with the full evidence stack (§5.19)", async () => {
    const cwd = makeDir({ "main.tf": "x\n" });
    dispatch = cleanButFmt();
    const ctx = makeCtx(cwd, {
      toolState: {
        baselineConcernIds: [FMT_CONCERN_ID],
        lastIdempotent: true,
        lastBlastTier: "low",
        lastCostDirection: "no-change",
      },
    });

    const result = await runTool(TerraformVerifyRemediationTool(ctx), { concern_ids: [] });

    expect(result).toMatchObject({ verified: true, confidence: "high" });
  });
});

describe("InfracostDiffTool", () => {
  const savedKey = process.env.INFRACOST_API_KEY;

  afterEach(() => {
    if (savedKey === undefined) delete process.env.INFRACOST_API_KEY;
    else process.env.INFRACOST_API_KEY = savedKey;
  });

  it("auto-skips when INFRACOST_API_KEY is unset", async () => {
    delete process.env.INFRACOST_API_KEY;
    const result = await runTool(InfracostDiffTool(makeCtx(makeDir())));
    expect(result).toMatchObject({ ok: false, code: "infracost_key_unset", ran: false });
  });

  it("auto-skips when the infracost CLI is absent", async () => {
    process.env.INFRACOST_API_KEY = "ico-key";
    dispatch = () => MISSING;
    const result = await runTool(InfracostDiffTool(makeCtx(makeDir())));
    expect(result).toMatchObject({ ok: false, code: "infracost_not_installed" });
  });

  it("auto-skips (with the stderr excerpt) when infracost exits non-zero", async () => {
    process.env.INFRACOST_API_KEY = "ico-key";
    dispatch = (cmd) => (cmd === "infracost" ? { status: 1, stderr: "boom: bad key" } : MISSING);
    const result = await runTool(InfracostDiffTool(makeCtx(makeDir())));
    expect(result).toMatchObject({ ok: false, code: "infracost_failed" });
    expect(result.detail).toMatch(/boom: bad key/);
  });

  it("auto-skips when the breakdown output is not JSON", async () => {
    process.env.INFRACOST_API_KEY = "ico-key";
    dispatch = (cmd) => (cmd === "infracost" ? { status: 0, stdout: "not json" } : MISSING);
    const result = await runTool(InfracostDiffTool(makeCtx(makeDir())));
    expect(result).toMatchObject({ ok: false, code: "infracost_parse_error" });
  });

  it("computes the delta vs the base-branch worktree and escalates a big increase", async () => {
    process.env.INFRACOST_API_KEY = "ico-key";
    const current = JSON.stringify({
      currency: "USD",
      totalMonthlyCost: "150",
      projects: [
        {
          breakdown: {
            resources: [
              { name: "aws_db_instance.db", monthlyCost: "120" },
              { name: "aws_instance.web", monthlyCost: "30" },
            ],
          },
        },
      ],
    });
    const baseline = JSON.stringify({ currency: "USD", totalMonthlyCost: "100" });
    dispatch = (cmd, args, dir) => {
      if (cmd === "infracost") {
        const inWorktree = dir.replace(/\\/g, "/").includes("infracost-base-");
        return { status: 0, stdout: inWorktree ? baseline : current };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args.includes("origin/HEAD")) {
        return { status: 0, stdout: "origin/main\n" };
      }
      if (cmd === "git" && args.includes("--show-prefix")) return { status: 0, stdout: "" };
      if (cmd === "git" && args[0] === "worktree") return { status: 0 };
      return MISSING;
    };
    const ctx = makeCtx(makeDir(), { payload: { costIncreaseBlockUsd: 25 } });

    const result = await runTool(InfracostDiffTool(ctx));

    expect(result).toMatchObject({
      ok: true,
      ran: true,
      currency: "USD",
      baseline_monthly_cost: 100,
      current_monthly_cost: 150,
      monthly_delta: 50,
      direction: "increase",
      needs_human: true,
    });
    expect(result.cost_escalation_reason).toMatch(/raises monthly cost by 50/);
    expect(result.top_resource_costs).toEqual([
      { name: "aws_db_instance.db", monthlyCost: 120 },
      { name: "aws_instance.web", monthlyCost: 30 },
    ]);
    expect(result.note).toBeUndefined();
    expect(ctx.toolState.lastCostDirection).toBe("increase");
  });

  it("reports current cost only (with a note) when no baseline is resolvable", async () => {
    process.env.INFRACOST_API_KEY = "ico-key";
    dispatch = (cmd) =>
      cmd === "infracost"
        ? { status: 0, stdout: JSON.stringify({ currency: "USD", totalMonthlyCost: "75" }) }
        : MISSING; // git missing → no base ref
    const ctx = makeCtx(makeDir());

    const result = await runTool(InfracostDiffTool(ctx));

    expect(result).toMatchObject({
      ran: true,
      current_monthly_cost: 75,
      baseline_monthly_cost: null,
      monthly_delta: null,
      direction: "unknown",
      needs_human: false,
    });
    expect(result.note).toMatch(/Baseline cost unavailable/);
    expect(result.top_resource_costs).toBeUndefined();
  });
});

describe("TerraformEmitSarifTool", () => {
  const fmtOnly = () => scannersDispatch({ validate: CLEAN_JSON, tflint: MISSING, trivy: MISSING });

  it("writes a SARIF report to the default path in the workspace", async () => {
    const cwd = makeDir({ "main.tf": "x\n" });
    dispatch = fmtOnly();

    const result = await runTool(TerraformEmitSarifTool(makeCtx(cwd)));

    const target = join(cwd, "terramend.sarif");
    expect(result).toMatchObject({ ok: true, sarif_path: target, result_count: 1, rule_count: 1 });
    const sarif = JSON.parse(readFileSync(target, "utf8")) as {
      version?: string;
      runs?: { results?: { ruleId?: string }[] }[];
    };
    expect(sarif.version).toBe("2.1.0");
    expect(at(at<{ results?: unknown }>(sarif.runs, 0).results, 0)).toMatchObject({
      ruleId: "terraform-fmt:unformatted",
    });
  });

  it("records the emitted path in toolState so the end-of-run emit defers to it", async () => {
    const cwd = makeDir({ "main.tf": "x\n" });
    dispatch = fmtOnly();
    const ctx = makeCtx(cwd);

    await runTool(TerraformEmitSarifTool(ctx), { output_path: "custom.sarif" });

    expect(ctx.toolState.emittedSarifPath).toBe(join(cwd, "custom.sarif"));
  });

  it("resolves a relative output_path against the workspace and an in-workspace absolute one as-is", async () => {
    const cwd = makeDir({ "main.tf": "x\n" });
    dispatch = fmtOnly();

    const rel = await runTool(TerraformEmitSarifTool(makeCtx(cwd)), {
      output_path: "report.sarif",
    });
    expect(rel.sarif_path).toBe(join(cwd, "report.sarif"));

    // an absolute path that stays INSIDE the workspace is honored as-is.
    const absInside = join(cwd, "abs.sarif");
    const abs = await runTool(TerraformEmitSarifTool(makeCtx(cwd)), { output_path: absInside });
    expect(abs.sarif_path).toBe(absInside);
  });

  it("rejects an output_path that escapes the workspace (no arbitrary file write)", async () => {
    const cwd = makeDir({ "main.tf": "x\n" });
    dispatch = fmtOnly();

    // an absolute path in a different directory…
    const outside = join(makeDir(), "abs.sarif");
    await expect(
      runTool(TerraformEmitSarifTool(makeCtx(cwd)), { output_path: outside }),
    ).rejects.toThrow(/escapes the workspace/);

    // …and relative `..` traversal.
    await expect(
      runTool(TerraformEmitSarifTool(makeCtx(cwd)), { output_path: "../escape.sarif" }),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("emits an empty-result report when the threshold filters everything", async () => {
    const cwd = makeDir({ "main.tf": "x\n" });
    dispatch = fmtOnly();

    const result = await runTool(TerraformEmitSarifTool(makeCtx(cwd)), {
      severity_threshold: "high",
    });

    expect(result).toMatchObject({ ok: true, result_count: 0, rule_count: 0 });
  });

  it("degrades to a structured skip when the SARIF file cannot be written", async () => {
    const cwd = makeDir({ "main.tf": "x\n" });
    dispatch = fmtOnly();

    const result = await runTool(TerraformEmitSarifTool(makeCtx(cwd)), {
      output_path: join("no-such-dir", "report.sarif"),
    });

    expect(result).toMatchObject({ ok: false, code: "sarif_write_failed" });
    expect(result.detail).toMatch(/could not write SARIF/);
  });
});

describe("TerraformPlanTool", () => {
  const CRED_KEYS = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_PROFILE",
    "AWS_ROLE_ARN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "ARM_CLIENT_ID",
    "ARM_USE_OIDC",
    "AZURE_CLIENT_ID",
    "GOOGLE_CREDENTIALS",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_OAUTH_ACCESS_TOKEN",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of CRED_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of CRED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const PLAN_JSON = [
    JSON.stringify({
      type: "planned_change",
      change: { action: "create", resource: { addr: "aws_s3_bucket.a" } },
    }),
    JSON.stringify({
      type: "planned_change",
      change: { action: "delete", resource: { addr: "aws_db_instance.db" } },
    }),
    JSON.stringify({ type: "change_summary", changes: { add: 1, change: 0, remove: 1 } }),
  ].join("\n");

  it("auto-skips when no cloud credentials are detected", async () => {
    const result = await runTool(TerraformPlanTool(makeCtx(makeDir({ "main.tf": "x" }))));
    expect(result).toMatchObject({ ok: false, code: "no_cloud_credentials", ran: false });
  });

  it("auto-skips when terraform is not installed", async () => {
    process.env.AWS_ACCESS_KEY_ID = "akia";
    dispatch = () => MISSING;
    const result = await runTool(TerraformPlanTool(makeCtx(makeDir({ "main.tf": "x" }))));
    expect(result).toMatchObject({ ok: false, code: "terraform_not_installed" });
  });

  it("auto-skips with the init error when terraform init fails", async () => {
    process.env.AWS_ACCESS_KEY_ID = "akia";
    dispatch = (cmd, args) =>
      cmd === "terraform" && args[0] === "init"
        ? { status: 1, stderr: "backend init error" }
        : MISSING;
    const result = await runTool(TerraformPlanTool(makeCtx(makeDir({ "main.tf": "x" }))));
    expect(result).toMatchObject({ ok: false, code: "terraform_init_failed" });
    expect(result.detail).toMatch(/backend init error/);
  });

  it("auto-skips when terraform plan fails", async () => {
    process.env.AWS_ACCESS_KEY_ID = "akia";
    dispatch = (cmd, args) => {
      if (cmd === "terraform" && args[0] === "init") return { status: 0 };
      if (cmd === "terraform" && args[0] === "plan") return { status: 1, stderr: "no backend" };
      return MISSING;
    };
    const result = await runTool(TerraformPlanTool(makeCtx(makeDir({ "main.tf": "x" }))));
    expect(result).toMatchObject({ ok: false, code: "terraform_plan_failed" });
  });

  it("plans, re-plans for stability, classifies destroys, and escalates stateful loss", async () => {
    process.env.AWS_ACCESS_KEY_ID = "akia";
    dispatch = (cmd, args) => {
      if (cmd === "terraform" && args[0] === "init") return { status: 0 };
      if (cmd === "terraform" && args[0] === "plan") {
        return args.includes("-json")
          ? { status: 0, stdout: PLAN_JSON }
          : { status: 0, stdout: "Plan: 1 to add, 0 to change, 1 to destroy." };
      }
      return MISSING;
    };
    const ctx = makeCtx(makeDir({ "main.tf": "x" }));

    const result = await runTool(TerraformPlanTool(ctx));

    expect(result).toMatchObject({
      ok: true,
      ran: true,
      roots_planned: ["."],
      to_add: 1,
      to_change: 0,
      to_destroy: 1,
      has_destroy_or_replace: true,
      idempotent: true,
      needs_human: true,
    });
    expect(result.destructive).toEqual([{ address: "aws_db_instance.db", action: "delete" }]);
    expect(result.stateful_destructive).toEqual([
      { address: "aws_db_instance.db", action: "delete", type: "aws_db_instance" },
    ]);
    expect(result.blast_radius).toEqual({ tier: "low", resourceCount: 2, modules: ["root"] });
    expect(result.needs_human_reasons).toEqual([
      "1 stateful resource(s) would be destroyed/replaced",
    ]);
    expect(result.plan_text).toContain("Plan: 1 to add");
    // toolState recorded for the push-time destroy block + confidence label.
    expect(ctx.toolState.plannedDestroy).toMatchObject({
      stateful: [{ address: "aws_db_instance.db", action: "delete", type: "aws_db_instance" }],
    });
    expect(ctx.toolState.lastBlastTier).toBe("low");
    expect(ctx.toolState.lastIdempotent).toBe(true);
  });

  it("flags a non-deterministic plan (second plan disagrees) as needs-human", async () => {
    process.env.AWS_ACCESS_KEY_ID = "akia";
    let jsonPlans = 0;
    const secondPlan = [
      JSON.stringify({
        type: "planned_change",
        change: { action: "create", resource: { addr: "aws_s3_bucket.a" } },
      }),
      JSON.stringify({ type: "change_summary", changes: { add: 1, change: 0, remove: 0 } }),
    ].join("\n");
    dispatch = (cmd, args) => {
      if (cmd === "terraform" && args[0] === "init") return { status: 0 };
      if (cmd === "terraform" && args[0] === "plan") {
        if (!args.includes("-json")) return { status: 0, stdout: "Plan text" };
        jsonPlans++;
        return { status: 0, stdout: jsonPlans === 1 ? PLAN_JSON : secondPlan };
      }
      return MISSING;
    };
    const ctx = makeCtx(makeDir({ "main.tf": "x" }));

    const result = await runTool(TerraformPlanTool(ctx));

    expect(result).toMatchObject({ ran: true, idempotent: false, needs_human: true });
    expect(result.idempotency_warning).toMatch(/not deterministic/);
    expect(result.needs_human_reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/non-deterministic plan/)]),
    );
    expect(ctx.toolState.lastIdempotent).toBe(false);
  });

  it("plans every discovered root and reports the ones that could not plan", async () => {
    process.env.AWS_ACCESS_KEY_ID = "akia";
    const cwd = makeDir({
      "terraform/providers.tf": 'provider "aws" {}\n',
      "terraform/core/providers.tf": 'provider "aws" {}\n',
    });
    const noChanges = JSON.stringify({
      type: "change_summary",
      changes: { add: 0, change: 0, remove: 0 },
    });
    dispatch = (cmd, args, dir) => {
      if (cmd === "terraform" && args[0] === "init") return { status: 0 };
      if (cmd === "terraform" && args[0] === "plan") {
        const inCore = dir.replace(/\\/g, "/").endsWith("/core");
        return inCore
          ? { status: 1, stderr: "core backend unreachable" }
          : { status: 0, stdout: noChanges };
      }
      return MISSING;
    };
    const ctx = makeCtx(cwd);

    const result = await runTool(TerraformPlanTool(ctx));

    expect(result).toMatchObject({
      ran: true,
      roots_planned: ["terraform"],
      to_add: 0,
      has_destroy_or_replace: false,
      needs_human: false,
    });
    expect(result.plan_text).toBeUndefined();
    expect(result.roots_skipped).toEqual([
      { dir: "terraform/core", reason: expect.stringMatching(/terraform plan failed/) },
    ]);
  });
});

describe("ReadFindingsTool", () => {
  const savedPath = process.env.TERRAMEND_FINDINGS_PATH;

  beforeEach(() => {
    delete process.env.TERRAMEND_FINDINGS_PATH;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.TERRAMEND_FINDINGS_PATH;
    else process.env.TERRAMEND_FINDINGS_PATH = savedPath;
  });

  const reviewerReport = JSON.stringify({
    schema_version: "1.0",
    findings: [
      {
        category: "security",
        source: "checkov",
        rule_id: "checkov:CKV_AWS_18",
        state: "verified",
        severity: "high",
        evidence: "S3 bucket has no access logging",
        location: { file: "main.tf", line: 5 },
        remediation_hint: "enable access logging",
      },
      {
        category: "style",
        source: "tflint",
        rule_id: "tflint:terraform_unused_declarations",
        state: "verified",
        severity: "low",
        evidence: "unused variable",
        location: { file: "vpc.tf", line: 3 },
      },
      {
        category: "security",
        source: "checkov",
        rule_id: "checkov:CKV_AWS_99",
        state: "human_only",
        severity: "high",
        location: { file: "main.tf", line: 9 },
      },
    ],
  });

  it("returns found: false (never an error) when no findings.json exists", async () => {
    const cwd = makeDir();
    const result = await runTool(ReadFindingsTool(makeCtx(cwd)));
    expect(result).toMatchObject({
      ok: false,
      code: "findings_not_found",
      found: false,
      concerns: [],
      groups: [],
    });
  });

  it("returns a structured parse-error skip for an unusable findings file", async () => {
    const cwd = makeDir({ "findings.json": '{"schema_version":"1.0","findings":42}' });
    const result = await runTool(ReadFindingsTool(makeCtx(cwd)));
    expect(result).toMatchObject({ ok: false, code: "findings_parse_error", found: false });
  });

  it("loads reviewer findings into the same shape terraform_scan returns", async () => {
    const cwd = makeDir({ "findings.json": reviewerReport });
    const ctx = makeCtx(cwd);

    const result = await runTool(ReadFindingsTool(ctx));

    expect(result).toMatchObject({
      ok: true,
      found: true,
      source_file: join(cwd, "findings.json"),
      grouping: "file",
    });
    expect(result.summary).toEqual({
      total: 2, // the human_only finding is dropped
      groups: 2,
      by_severity: { high: 1, low: 1 },
    });
    expect(at(result.concerns, 0)).toMatchObject({
      source: "checkov",
      severity: "high",
      doc_url: null,
    });
    // §1.4 baseline captured for the later regression diff.
    expect(ctx.toolState.baselineConcernIds).toHaveLength(2);
  });

  it("honours an explicit in-workspace path, by-rule grouping, and the configured threshold", async () => {
    const cwd = makeDir({ "custom.json": reviewerReport });
    const ctx = makeCtx(cwd, { payload: { severityThreshold: "high" } });

    const result = await runTool(ReadFindingsTool(ctx), {
      path: "custom.json",
      group_by: "rule",
    });

    expect(result).toMatchObject({ found: true, grouping: "rule" });
    expect(result.summary).toMatchObject({ total: 1, groups: 1 });
    expect(at(result.groups, 0)).toMatchObject({ grouping: "rule", file: "main.tf" });
  });

  it("rejects a path arg that escapes the workspace (no arbitrary file read)", async () => {
    const outside = makeDir({ "secret.json": reviewerReport });
    const cwd = makeDir();
    await expect(
      runTool(ReadFindingsTool(makeCtx(cwd)), { path: join(outside, "secret.json") }),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("falls back to $TERRAMEND_FINDINGS_PATH when no path arg is given (operator-set, unconfined)", async () => {
    const dir = makeDir({ "elsewhere.json": reviewerReport });
    process.env.TERRAMEND_FINDINGS_PATH = join(dir, "elsewhere.json");
    const result = await runTool(ReadFindingsTool(makeCtx(makeDir())));
    expect(result).toMatchObject({ found: true, source_file: join(dir, "elsewhere.json") });
  });
});

describe("changedTerraformFiles (diff scope plumbing)", () => {
  it("re-bases repo-root diff paths onto a scanned subdirectory", () => {
    dispatch = (cmd, args) => {
      if (cmd !== "git") return MISSING;
      if (args[0] === "rev-parse" && args.includes("origin/HEAD")) {
        return { status: 0, stdout: "origin/main\n" };
      }
      if (args[0] === "merge-base") return { status: 1 }; // falls back to the base ref
      if (args.includes("--show-prefix")) return { status: 0, stdout: "infra/\n" };
      if (args[0] === "diff") {
        return {
          status: 0,
          stdout: "infra/main.tf\ninfra/envs/prod.tfvars\nother/root.tf\nREADME.md\n",
        };
      }
      return MISSING;
    };

    const changed = changedTerraformFiles("/repo/infra");

    expect(changed).toEqual(new Set(["main.tf", "envs/prod.tfvars"]));
  });

  it("returns null when the diff itself fails", () => {
    dispatch = (cmd, args) => {
      if (cmd !== "git") return MISSING;
      if (args[0] === "rev-parse" && args.includes("origin/HEAD")) {
        return { status: 0, stdout: "origin/main\n" };
      }
      if (args[0] === "merge-base") return { status: 0, stdout: "abc\n" };
      if (args[0] === "diff") return { status: 1, stderr: "fatal" };
      return MISSING;
    };

    expect(changedTerraformFiles("/repo")).toBeNull();
  });
});
