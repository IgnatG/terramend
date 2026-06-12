import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalContext, buildLocalTools } from "#app/mcp/localServer";
import { log, setLogSink } from "#app/utils/log";

afterEach(() => {
  setLogSink("actions");
  vi.restoreAllMocks();
});

describe("buildLocalTools", () => {
  it("exposes exactly the read-only terraform tool set — no GitHub/git/PR/shell surface", () => {
    const ctx = buildLocalContext({ cwd: process.cwd() });
    const names = buildLocalTools(ctx)
      .map((t) => t.name)
      .sort();
    // append-only review gate: a tool that pushes, comments, or opens PRs must
    // never appear here. Update deliberately, with the localServer.ts doc rule.
    expect(names).toEqual([
      "infracost_diff",
      "list_modules",
      "module_extraction_candidates",
      "read_findings",
      "terraform_emit_sarif",
      "terraform_module_graph",
      "terraform_module_interface",
      "terraform_plan",
      "terraform_provider_schema",
      "terraform_roots",
      "terraform_scan",
      "terraform_validate",
      "terraform_verify_remediation",
      "terraform_version_currency",
    ]);
  });
});

describe("buildLocalContext", () => {
  it("builds a cwd-scoped context with initialized tool state and a real tmpdir", () => {
    const ctx = buildLocalContext({
      cwd: "/repo",
      severityThreshold: "medium",
      scanScope: "diff",
      moduleCatalogue: "terraform-aws-modules/vpc/aws ~> 5.0",
    });
    expect(ctx.payload).toMatchObject({
      cwd: "/repo",
      severityThreshold: "medium",
      scanScope: "diff",
      moduleCatalogue: "terraform-aws-modules/vpc/aws ~> 5.0",
    });
    expect(ctx.toolState.backgroundProcesses.size).toBe(0);
    expect(ctx.toolState.usageEntries).toEqual([]);
    expect(existsSync(ctx.tmpdir)).toBe(true);
  });
});

describe("setLogSink", () => {
  it("routes log output to stderr (stdout must stay clean for stdio JSON-RPC)", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    setLogSink("stderr");
    log.info("diagnostic line");
    log.warning("careful");
    log.error("broken");

    const stderrText = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("diagnostic line");
    expect(stderrText).toContain("warning: careful");
    expect(stderrText).toContain("error: broken");
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
