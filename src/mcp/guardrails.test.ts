import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// the guardrails read git through `$` (#app/utils/shell) and run gitleaks via
// `spawnSync` — both are mocked so no real subprocess executes.
const shellMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("#app/utils/shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/utils/shell")>();
  return { ...actual, $: shellMock };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import {
  assertNoBlockedDestroy,
  assertNoSecretsInDiff,
  assertUnderPrCap,
  DEFAULT_ALLOWED_PATHS,
  enforceProtectedPaths,
  enforceRemediationPaths,
  GENERATE_MODE,
  globToRegex,
  isPathAllowed,
  parseGitleaksReport,
  REMEDIATE_MODE,
  recordRemediationPrOpened,
  resolveAllowedPaths,
  scanDiffForSecrets,
  TERRATEST_ALLOWED_PATHS,
} from "#app/mcp/guardrails";
import type { ToolContext } from "#app/mcp/server";
import { log } from "#app/utils/cli";

describe("globToRegex", () => {
  it("matches **/*.tf at any depth", () => {
    const re = globToRegex("**/*.tf");
    expect(re.test("main.tf")).toBe(true);
    expect(re.test("modules/net/vpc.tf")).toBe(true);
    expect(re.test("main.tfvars")).toBe(false);
    expect(re.test("src/app.ts")).toBe(false);
  });

  it("matches a directory subtree with **", () => {
    const re = globToRegex("modules/**");
    expect(re.test("modules/net/vpc.tf")).toBe(true);
    expect(re.test("modules/x")).toBe(true);
    expect(re.test("other/x.tf")).toBe(false);
  });

  it("single * stays within a path segment", () => {
    const re = globToRegex("*.tf");
    expect(re.test("main.tf")).toBe(true);
    expect(re.test("modules/main.tf")).toBe(false);
  });
});

// Adversarial coverage for the hand-rolled glob compiler — it backs the path
// allow-list and the protected-paths deny-list, so a regex-injection or a
// segment-crossing bypass here would defeat those guardrails.
describe("globToRegex (adversarial / injection)", () => {
  it("escapes regex metacharacters in the glob (no injection from the pattern)", () => {
    // `.` is a literal dot, not 'any char'
    expect(globToRegex("a.tf").test("axtf")).toBe(false);
    expect(globToRegex("a.tf").test("a.tf")).toBe(true);
    // anchors/alternation/group chars from the pattern are treated literally
    const re = globToRegex("a(b|c)$.tf");
    expect(re.test("a(b|c)$.tf")).toBe(true);
    expect(re.test("ab.tf")).toBe(false);
    // `+` is a literal plus, not a regex quantifier
    expect(globToRegex("a+.tf").test("a+.tf")).toBe(true);
    expect(globToRegex("a+.tf").test("aaaa.tf")).toBe(false);
  });

  it("is fully anchored — no partial-match bypass", () => {
    const re = globToRegex("*.tf");
    expect(re.test("main.tf.bak")).toBe(false);
    expect(re.test("evil/main.tf")).toBe(false);
    // a separator anywhere defeats a single-segment glob, so a slash-bearing
    // suffix can't be smuggled past the anchored pattern
    expect(re.test("main.tf/../etc/passwd")).toBe(false);
    expect(re.test("main.tf\n/etc/passwd")).toBe(false);
  });

  it("`*`/`?` never cross a path separator, blocking `../` traversal", () => {
    // single-segment globs reject any path containing a separator…
    expect(isPathAllowed("../secret.tf", ["*.tf"])).toBe(false);
    expect(isPathAllowed("..\\secret.tf", ["*.tf"])).toBe(false); // windows sep normalized then rejected
    expect(isPathAllowed("a/b.tf", ["*.tf"])).toBe(false);
    expect(globToRegex("?.tf").test("/.tf")).toBe(false);
  });

  it("`**` deliberately spans separators (documented power of the deny-list)", () => {
    // protected-paths rely on this: `prod/**` must catch nested files. The
    // safety of the allow-list against `..` does NOT come from `**` globs — it
    // comes from changed-file paths being git-relative (no `..`), which is
    // enforced upstream in changedFilesSinceRunStart.
    expect(isPathAllowed("prod/db/main.tf", ["prod/**"])).toBe(true);
    expect(isPathAllowed("prod/a/b/c/secret", ["prod/**"])).toBe(true);
    expect(isPathAllowed("staging/main.tf", ["prod/**"])).toBe(false);
  });
});

describe("isPathAllowed (default Terraform allow-list)", () => {
  const globs = [...DEFAULT_ALLOWED_PATHS];

  it("allows .tf and .tfvars at any depth", () => {
    expect(isPathAllowed("main.tf", globs)).toBe(true);
    expect(isPathAllowed("modules/net/vpc.tf", globs)).toBe(true);
    expect(isPathAllowed("envs/prod.tfvars", globs)).toBe(true);
  });

  it("rejects anything that isn't Terraform", () => {
    expect(isPathAllowed(".github/workflows/ci.yml", globs)).toBe(false);
    expect(isPathAllowed("src/index.ts", globs)).toBe(false);
    expect(isPathAllowed("README.md", globs)).toBe(false);
  });

  it("normalizes windows separators and leading ./", () => {
    expect(isPathAllowed("modules\\net\\vpc.tf", globs)).toBe(true);
    expect(isPathAllowed("./main.tf", globs)).toBe(true);
  });
});

describe("PR-cap guardrail is scoped to the Terraform-write modes", () => {
  // assertUnderPrCap / recordRemediationPrOpened only read toolState + payload
  // (no git / no I/O), so a minimal cast context exercises the mode gate.
  const ctx = (selectedMode: string | undefined, opened: number, maxPrs = 1) =>
    ({
      toolState: { selectedMode, remediationPrsOpened: opened },
      payload: { maxPrs },
    }) as unknown as ToolContext;

  it("throws at the cap for both Remediate and GenerateTerraform", () => {
    expect(() => assertUnderPrCap(ctx(REMEDIATE_MODE, 1))).toThrow(/PR limit reached/);
    expect(() => assertUnderPrCap(ctx(GENERATE_MODE, 1))).toThrow(/PR limit reached/);
  });

  it("allows opening up to the cap", () => {
    expect(() => assertUnderPrCap(ctx(GENERATE_MODE, 0))).not.toThrow();
    expect(() => assertUnderPrCap(ctx(REMEDIATE_MODE, 0))).not.toThrow();
  });

  it("never engages for non-guarded modes (Build/Review/etc.), even over cap", () => {
    expect(() => assertUnderPrCap(ctx("Build", 5))).not.toThrow();
    expect(() => assertUnderPrCap(ctx(undefined, 5))).not.toThrow();
  });

  it("only counts PRs for guarded modes", () => {
    const guarded = ctx(GENERATE_MODE, 0);
    recordRemediationPrOpened(guarded);
    expect(guarded.toolState.remediationPrsOpened).toBe(1);

    const unguarded = ctx("Build", 0);
    recordRemediationPrOpened(unguarded);
    expect(unguarded.toolState.remediationPrsOpened).toBe(0);
  });
});

describe("destroy-block guardrail (§2.5 — never delete/replace a stateful resource)", () => {
  // assertNoBlockedDestroy reads only toolState.plannedDestroy + payload.allowReplace.
  const ctx = (
    selectedMode: string | undefined,
    plannedDestroy: ToolContext["toolState"]["plannedDestroy"],
    allowReplace?: string[],
  ) =>
    ({
      toolState: { selectedMode, plannedDestroy },
      payload: { allowReplace },
    }) as unknown as ToolContext;

  const statefulDestroy = {
    stateful: [{ address: "aws_db_instance.main", action: "delete", type: "aws_db_instance" }],
    ephemeral: [],
  };

  it("blocks a push that would destroy/replace a stateful resource", () => {
    expect(() => assertNoBlockedDestroy(ctx(REMEDIATE_MODE, statefulDestroy))).toThrow(
      /DESTROY or REPLACE 1 stateful/,
    );
    expect(() => assertNoBlockedDestroy(ctx(GENERATE_MODE, statefulDestroy))).toThrow(
      /aws_db_instance\.main/,
    );
  });

  it("allows the destroy when the operator opted in via allow_replace (address, glob, or *)", () => {
    expect(() =>
      assertNoBlockedDestroy(ctx(REMEDIATE_MODE, statefulDestroy, ["aws_db_instance.main"])),
    ).not.toThrow();
    expect(() =>
      assertNoBlockedDestroy(ctx(REMEDIATE_MODE, statefulDestroy, ["aws_db_instance.*"])),
    ).not.toThrow();
    expect(() => assertNoBlockedDestroy(ctx(REMEDIATE_MODE, statefulDestroy, ["*"]))).not.toThrow();
  });

  it("never engages for ephemeral-only destroys (recreatable resources)", () => {
    const ephemeralOnly = {
      stateful: [],
      ephemeral: [{ address: "aws_instance.web", action: "replace", type: "aws_instance" }],
    };
    expect(() => assertNoBlockedDestroy(ctx(REMEDIATE_MODE, ephemeralOnly))).not.toThrow();
  });

  it("no-ops when no plan ran, or outside a guarded mode", () => {
    expect(() => assertNoBlockedDestroy(ctx(REMEDIATE_MODE, undefined))).not.toThrow();
    expect(() => assertNoBlockedDestroy(ctx("Build", statefulDestroy))).not.toThrow();
    expect(() => assertNoBlockedDestroy(ctx(undefined, statefulDestroy))).not.toThrow();
  });
});

describe("protected-paths guardrail (§2.7) — gating", () => {
  // enforceProtectedPaths reaches git only AFTER the mode + empty-list gates,
  // so these no-op cases exercise the gate without any git I/O.
  const ctx = (selectedMode: string | undefined, protectedPaths?: string[]) =>
    ({
      toolState: { selectedMode },
      payload: { protectedPaths },
    }) as unknown as ToolContext;

  it("no-ops outside a guarded mode (even with protected paths set)", () => {
    expect(() => enforceProtectedPaths(ctx("Build", ["prod/**"]))).not.toThrow();
    expect(() => enforceProtectedPaths(ctx(undefined, ["prod/**"]))).not.toThrow();
  });

  it("no-ops in a guarded mode when no protected paths are configured", () => {
    expect(() => enforceProtectedPaths(ctx(REMEDIATE_MODE, undefined))).not.toThrow();
    expect(() => enforceProtectedPaths(ctx(REMEDIATE_MODE, []))).not.toThrow();
  });

  it("a protected glob matches via the same engine as allowed_paths (inverse semantics)", () => {
    // matching a protected glob means BLOCKED — verify the matcher the guardrail
    // uses (isPathAllowed) behaves as expected for the protected-list direction.
    expect(isPathAllowed("prod/main.tf", ["prod/**"])).toBe(true);
    expect(isPathAllowed("dev/main.tf", ["prod/**"])).toBe(false);
    expect(isPathAllowed("modules/db/main.tf", ["**/db/**"])).toBe(true);
  });
});

describe("scanDiffForSecrets (§2.8)", () => {
  const diff = (...lines: string[]) => lines.join("\n");

  it("flags an inlined AWS access key id on an added line, with file:line", () => {
    const d = diff(
      "diff --git a/main.tf b/main.tf",
      "--- a/main.tf",
      "+++ b/main.tf",
      "@@ -1,2 +1,3 @@",
      ' resource "aws_iam_user" "x" {',
      '+  access_key = "AKIAIOSFODNN7EXAMPLE"',
      " }",
    );
    const hits = scanDiffForSecrets(d);
    expect(hits).toHaveLength(2); // AKIA value pattern + sensitive-assignment
    expect(hits.some((h) => h.rule === "aws-access-key-id")).toBe(true);
    expect(hits[0]?.file).toBe("main.tf");
    expect(hits[0]?.line).toBe(2); // second new-side line in the hunk
  });

  it("flags a hardcoded password literal but NOT a variable reference", () => {
    const literal = diff("+++ b/x.tf", "@@ -0,0 +1 @@", '+  password = "hunter2"');
    expect(scanDiffForSecrets(literal).map((h) => h.rule)).toContain("hardcoded-secret-assignment");

    const ref = diff("+++ b/x.tf", "@@ -0,0 +1 @@", "+  password = var.db_password");
    expect(scanDiffForSecrets(ref)).toEqual([]);

    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal HCL interpolation fixture, not a JS template
    const interp = diff("+++ b/x.tf", "@@ -0,0 +1 @@", '+  password = "${var.db_password}"');
    expect(scanDiffForSecrets(interp)).toEqual([]);
  });

  it("flags a PEM private-key header", () => {
    const d = diff("+++ b/key.tf", "@@ -0,0 +1 @@", '+  key = "-----BEGIN RSA PRIVATE KEY-----"');
    expect(scanDiffForSecrets(d).some((h) => h.rule === "pem-private-key")).toBe(true);
  });

  it("ignores secrets on removed/context lines (only ADDED lines count)", () => {
    const d = diff(
      "+++ b/main.tf",
      "@@ -1,2 +1,1 @@",
      '-  password = "hunter2"', // removed — pre-existing, not this run's doing
      ' resource "x" "y" {}',
    );
    expect(scanDiffForSecrets(d)).toEqual([]);
  });

  it("returns nothing for a clean diff", () => {
    const d = diff("+++ b/main.tf", "@@ -0,0 +1 @@", "+  bucket = var.bucket_name");
    expect(scanDiffForSecrets(d)).toEqual([]);
  });
});

// --- git-backed guardrails (mocked `$` + spawnSync) --------------------------

/** `$` stub that resolves the run-start sha and returns canned git output. */
function gitStub(out: { diffNames?: string; diff?: string; failRevParse?: boolean }) {
  shellMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);
    if (args[0] === "rev-parse") {
      if (out.failRevParse) throw new Error("fatal: unknown revision");
      return "base-sha";
    }
    if (args[0] === "diff" && args[1] === "--name-only") return out.diffNames ?? "";
    if (args[0] === "diff") return out.diff ?? "";
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  });
}

function gitCtx(over: {
  selectedMode?: string;
  payload?: Record<string, unknown>;
  tmpdir?: string;
}): ToolContext {
  return {
    toolState: {
      selectedMode: over.selectedMode ?? REMEDIATE_MODE,
      initialHead: { kind: "branch", name: "main" },
    },
    payload: { ...(over.payload ?? {}) },
    tmpdir: over.tmpdir ?? "",
  } as unknown as ToolContext;
}

beforeEach(() => {
  shellMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation(() => ({
    error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    status: null,
    stdout: "",
    stderr: "",
  }));
});

describe("resolveAllowedPaths", () => {
  it("defaults to Terraform-only globs", () => {
    expect(resolveAllowedPaths(gitCtx({}))).toEqual([...DEFAULT_ALLOWED_PATHS]);
  });

  it("prefers the operator-configured allow-list", () => {
    const ctx = gitCtx({ payload: { allowedPaths: ["infra/**"] } });
    expect(resolveAllowedPaths(ctx)).toEqual(["infra/**"]);
  });

  it("treats an EMPTY configured list as unset (falls back to the default)", () => {
    expect(resolveAllowedPaths(gitCtx({ payload: { allowedPaths: [] } }))).toEqual([
      ...DEFAULT_ALLOWED_PATHS,
    ]);
  });

  it("adds the Terratest scaffold paths only when the terratest input is on (§28)", () => {
    const ctx = gitCtx({ payload: { terratest: true } });
    expect(resolveAllowedPaths(ctx)).toEqual([
      ...DEFAULT_ALLOWED_PATHS,
      ...TERRATEST_ALLOWED_PATHS,
    ]);
  });
});

describe("enforceRemediationPaths (path allow-list at push time)", () => {
  it("passes when every changed file is Terraform", () => {
    gitStub({ diffNames: "main.tf\nmodules/net/vpc.tf\nenvs/prod.tfvars\n" });
    expect(() => enforceRemediationPaths(gitCtx({}))).not.toThrow();
  });

  it("blocks the push when a non-Terraform file changed, listing the violations", () => {
    gitStub({ diffNames: "main.tf\n.github/workflows/ci.yml\n" });
    expect(() => enforceRemediationPaths(gitCtx({}))).toThrow(
      /push blocked.*\.github\/workflows\/ci\.yml/s,
    );
  });

  it("fails closed when the run-start commit can't be established", () => {
    gitStub({ failRevParse: true });
    expect(() => enforceRemediationPaths(gitCtx({}))).toThrow(
      /could not establish the run-start commit/,
    );
  });

  it("never engages outside the Terraform-write modes", () => {
    gitStub({ diffNames: "src/app.ts\n" });
    expect(() => enforceRemediationPaths(gitCtx({ selectedMode: "Build" }))).not.toThrow();
    expect(shellMock).not.toHaveBeenCalled();
  });
});

describe("enforceProtectedPaths (deny-list at push time)", () => {
  it("blocks a push that modified a protected file", () => {
    gitStub({ diffNames: "prod/db/main.tf\nstaging/main.tf\n" });
    const ctx = gitCtx({ payload: { protectedPaths: ["prod/**"] } });
    expect(() => enforceProtectedPaths(ctx)).toThrow(/push blocked.*prod\/db\/main\.tf/s);
  });

  it("passes when no change matched a protected glob", () => {
    gitStub({ diffNames: "staging/main.tf\n" });
    const ctx = gitCtx({ payload: { protectedPaths: ["prod/**"] } });
    expect(() => enforceProtectedPaths(ctx)).not.toThrow();
  });

  it("fails closed on a missing run-start baseline", () => {
    gitStub({ failRevParse: true });
    const ctx = gitCtx({ payload: { protectedPaths: ["prod/**"] } });
    expect(() => enforceProtectedPaths(ctx)).toThrow(/could not establish the run-start commit/);
  });
});

describe("assertNoSecretsInDiff (§2.8 at push time)", () => {
  const cleanDiff = ["+++ b/main.tf", "@@ -0,0 +1 @@", "+  bucket = var.bucket_name"].join("\n");
  const leakyDiff = ["+++ b/main.tf", "@@ -0,0 +1 @@", '+  password = "hunter2"'].join("\n");

  it("passes on a clean diff", () => {
    gitStub({ diff: cleanDiff });
    expect(() => assertNoSecretsInDiff(gitCtx({}))).not.toThrow();
  });

  it("blocks a push whose diff inlines a secret, with file:line and rule", () => {
    gitStub({ diff: leakyDiff });
    expect(() => assertNoSecretsInDiff(gitCtx({}))).toThrow(
      /push blocked.*main\.tf:1 \(hardcoded-secret-assignment\)/s,
    );
  });

  it("fails closed when the baseline is missing and no-ops outside guarded modes", () => {
    gitStub({ failRevParse: true });
    expect(() => assertNoSecretsInDiff(gitCtx({}))).toThrow(/could not establish/);
    expect(() => assertNoSecretsInDiff(gitCtx({ selectedMode: "Review" }))).not.toThrow();
  });

  it("degrades to the built-in scanner when gitleaks is requested but absent", () => {
    gitStub({ diff: cleanDiff });
    // spawnSync default stub is ENOENT — gitleaks "not installed".
    const ctx = gitCtx({ payload: { gitleaks: true } });
    expect(() => assertNoSecretsInDiff(ctx)).not.toThrow();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "gitleaks",
      expect.arrayContaining(["detect"]),
      expect.anything(),
    );
  });

  it("merges gitleaks hits on top of the built-in baseline", () => {
    gitStub({ diff: cleanDiff });
    const dir = mkdtempSync(join(tmpdir(), "terramend-gitleaks-"));
    try {
      spawnSyncMock.mockImplementation((cmd: unknown, args: unknown) => {
        if (cmd !== "gitleaks") throw new Error(`unexpected spawn: ${String(cmd)}`);
        const argv = args as string[];
        const reportPath = argv[argv.indexOf("--report-path") + 1] ?? "";
        writeFileSync(
          reportPath,
          JSON.stringify([{ RuleID: "aws-access-token", File: "main.tf", StartLine: 3 }]),
        );
        return { status: 0, stdout: "", stderr: "" };
      });
      const ctx = gitCtx({ payload: { gitleaks: true }, tmpdir: dir });
      expect(() => assertNoSecretsInDiff(ctx)).toThrow(/main\.tf:3 \(gitleaks:aws-access-token\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a gitleaks run with no report file as a clean scan", () => {
    gitStub({ diff: cleanDiff });
    spawnSyncMock.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
    const dir = mkdtempSync(join(tmpdir(), "terramend-gitleaks-"));
    try {
      const ctx = gitCtx({ payload: { gitleaks: true }, tmpdir: dir });
      expect(() => assertNoSecretsInDiff(ctx)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveMaxPrs default (via assertUnderPrCap)", () => {
  it("caps at one PR per run when max_prs is not configured", () => {
    const ctx = {
      toolState: { selectedMode: REMEDIATE_MODE, remediationPrsOpened: 1 },
      payload: {},
    } as unknown as ToolContext;
    expect(() => assertUnderPrCap(ctx)).toThrow(/at most 1 PR/);
  });
});

// --- mutation-hardening tests ------------------------------------------------
// Added after a Stryker run showed these behaviors could regress silently: the
// earlier tests exercised the right functions but with inputs that couldn't
// distinguish redundant-looking arms (e.g. `*` vs the glob fallback) or never
// observed the side channel (log output, subprocess options, line numbers).

describe("globToRegex `?` semantics", () => {
  it("`?` consumes exactly one non-separator character", () => {
    expect(globToRegex("?.tf").test("a.tf")).toBe(true);
    expect(globToRegex("?.tf").test(".tf")).toBe(false);
    expect(globToRegex("?.tf").test("ab.tf")).toBe(false);
  });
});

describe("destroy-block allowlist arms (§2.5)", () => {
  const ctx = (plannedDestroy: ToolContext["toolState"]["plannedDestroy"], allow?: string[]) =>
    ({
      toolState: { selectedMode: REMEDIATE_MODE, plannedDestroy },
      payload: { allowReplace: allow },
    }) as unknown as ToolContext;

  it("honors the `all` keyword", () => {
    const planned = {
      stateful: [{ address: "aws_db_instance.main", action: "delete", type: "aws_db_instance" }],
      ephemeral: [],
    };
    expect(() => assertNoBlockedDestroy(ctx(planned, ["all"]))).not.toThrow();
  });

  it("`*` allows an address the glob engine cannot match (slash inside an index key)", () => {
    // globToRegex("*") compiles to [^/]* — it does NOT match an address whose
    // for_each key contains a slash. only the literal `*` arm covers it, so
    // this input distinguishes that arm from the glob fallback.
    const planned = {
      stateful: [
        { address: 'aws_s3_bucket.b["logs/prod"]', action: "delete", type: "aws_s3_bucket" },
      ],
      ephemeral: [],
    };
    expect(() => assertNoBlockedDestroy(ctx(planned, ["*"]))).not.toThrow();
    expect(() => assertNoBlockedDestroy(ctx(planned, ["aws_db_instance.*"]))).toThrow(
      /DESTROY or REPLACE/,
    );
  });

  it("a non-matching allowlist still blocks", () => {
    const planned = {
      stateful: [{ address: "aws_db_instance.main", action: "delete", type: "aws_db_instance" }],
      ephemeral: [],
    };
    expect(() => assertNoBlockedDestroy(ctx(planned, ["aws_s3_bucket.other"]))).toThrow(
      /aws_db_instance\.main/,
    );
  });

  it("the empty-stateful early return skips the gate entirely (no ok-log)", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      assertNoBlockedDestroy(ctx({ stateful: [], ephemeral: [] }));
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("run-start baseline resolution (branch vs detached head)", () => {
  it("resolves a branch head via its name and pins {log: false} on both git calls", () => {
    gitStub({ diffNames: "main.tf\n" });
    enforceRemediationPaths(gitCtx({}));
    expect(shellMock).toHaveBeenCalledWith("git", ["rev-parse", "main"], { log: false });
    expect(shellMock).toHaveBeenCalledWith("git", ["diff", "--name-only", "base-sha", "HEAD"], {
      log: false,
    });
  });

  it("resolves a detached head via its sha", () => {
    gitStub({ diffNames: "main.tf\n" });
    const ctx = {
      toolState: {
        selectedMode: REMEDIATE_MODE,
        initialHead: { kind: "detached", sha: "abc123" },
      },
      payload: {},
      tmpdir: "",
    } as unknown as ToolContext;
    enforceRemediationPaths(ctx);
    expect(shellMock).toHaveBeenCalledWith("git", ["rev-parse", "abc123"], { log: false });
  });

  it("trims whitespace-padded filenames from git output before matching", () => {
    gitStub({ diffNames: "  main.tf  \n\n  modules/net/vpc.tf\n" });
    expect(() => enforceRemediationPaths(gitCtx({}))).not.toThrow();
  });
});

describe("scanDiffForSecrets line attribution (§2.8)", () => {
  it("tracks multi-digit hunk starts and advances only on added/context lines", () => {
    const d = [
      "+++ b/main.tf",
      "@@ -50,4 +100,5 @@",
      " context line",
      '-password = "old"',
      '+password = "new1"',
      " another context",
      '+api_key = "literalvalue"',
    ].join("\n");
    const hits = scanDiffForSecrets(d);
    expect(hits.map((h) => ({ file: h.file, line: h.line }))).toEqual([
      { file: "main.tf", line: 101 },
      { file: "main.tf", line: 103 },
    ]);
  });

  it("attributes a /dev/null new-side header as (deleted)", () => {
    // git never emits added lines under /dev/null, but the parser is pure and
    // fed external text — pin the labeling rather than leave it dead.
    const d = ["+++ /dev/null", "@@ -1,1 +0,0 @@", '+password = "x"'].join("\n");
    const hits = scanDiffForSecrets(d);
    expect(hits[0]?.file).toBe("(deleted)");
  });

  it("strips CRLF from header and content lines", () => {
    const d = ["+++ b/main.tf\r", "@@ -0,0 +1 @@\r", '+password = "x"\r'].join("\n");
    const hits = scanDiffForSecrets(d);
    expect(hits[0]?.file).toBe("main.tf");
  });
});

describe("scanWithGitleaks subprocess contract", () => {
  it("does not spawn gitleaks at all when the input is off", () => {
    gitStub({ diff: ["+++ b/main.tf", "@@ -0,0 +1 @@", "+  bucket = var.b"].join("\n") });
    assertNoSecretsInDiff(gitCtx({}));
    expect(spawnSyncMock).not.toHaveBeenCalled();
    // the diff itself is read with logging suppressed (restricted surface)
    expect(shellMock).toHaveBeenCalledWith("git", ["diff", "base-sha", "HEAD"], { log: false });
  });

  it("runs from payload.cwd (falling back to process.cwd()) with the capped buffer", () => {
    gitStub({ diff: ["+++ b/main.tf", "@@ -0,0 +1 @@", "+  bucket = var.b"].join("\n") });
    const warnSpy = vi.spyOn(log, "warning").mockImplementation(() => {});
    try {
      assertNoSecretsInDiff(gitCtx({ payload: { gitleaks: true } }));
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "gitleaks",
        expect.arrayContaining(["detect"]),
        expect.objectContaining({
          cwd: process.cwd(),
          encoding: "utf-8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
      // ENOENT (default stub) → the "not installed" degrade message
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not installed"));

      assertNoSecretsInDiff(gitCtx({ payload: { gitleaks: true, cwd: "/custom/dir" } }));
      expect(spawnSyncMock).toHaveBeenLastCalledWith(
        "gitleaks",
        expect.anything(),
        expect.objectContaining({ cwd: "/custom/dir" }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("distinguishes a non-ENOENT spawn failure in the degrade message", () => {
    gitStub({ diff: ["+++ b/main.tf", "@@ -0,0 +1 @@", "+  bucket = var.b"].join("\n") });
    spawnSyncMock.mockImplementation(() => ({
      error: new Error("EACCES: permission denied"),
      status: null,
      stdout: "",
      stderr: "",
    }));
    const warnSpy = vi.spyOn(log, "warning").mockImplementation(() => {});
    try {
      assertNoSecretsInDiff(gitCtx({ payload: { gitleaks: true } }));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not run"));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("not installed"));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("parseGitleaksReport (§2.8 — optional gitleaks engine)", () => {
  it("maps gitleaks findings to SecretHit with a gitleaks: rule prefix", () => {
    const report = JSON.stringify([
      { RuleID: "aws-access-token", File: "main.tf", StartLine: 12, Description: "AWS" },
      { RuleID: "generic-api-key", File: "modules/db/main.tf", StartLine: 4 },
    ]);
    expect(parseGitleaksReport(report)).toEqual([
      { file: "main.tf", line: 12, rule: "gitleaks:aws-access-token" },
      { file: "modules/db/main.tf", line: 4, rule: "gitleaks:generic-api-key" },
    ]);
  });

  it("tolerates an empty report, empty string, and malformed JSON", () => {
    expect(parseGitleaksReport("[]")).toEqual([]);
    expect(parseGitleaksReport("")).toEqual([]);
    expect(parseGitleaksReport("not json")).toEqual([]);
    expect(parseGitleaksReport(JSON.stringify({ not: "an array" }))).toEqual([]);
  });

  it("defaults missing fields rather than throwing", () => {
    expect(parseGitleaksReport(JSON.stringify([{}]))).toEqual([
      { file: "(unknown)", line: 0, rule: "gitleaks:secret" },
    ]);
  });

  it("treats EMPTY-string fields as missing (not as a real file/rule)", () => {
    expect(parseGitleaksReport(JSON.stringify([{ File: "", RuleID: "", StartLine: 2 }]))).toEqual([
      { file: "(unknown)", line: 2, rule: "gitleaks:secret" },
    ]);
  });
});
