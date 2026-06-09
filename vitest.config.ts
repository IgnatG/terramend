import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/.temp/**",
      "**/.pnpm-store/**",
      // *.main.test.ts files run only on main (e.g. catalog drift against
      // models.dev + OpenRouter). run them via `pnpm test:catalog`, which
      // points at vitest.main.config.ts.
      "**/*.main.test.ts",
    ],
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Coverage is opt-in (only collected with `--coverage`, i.e. `pnpm
    // test:coverage`) so the default `pnpm test` run stays fast.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__fixtures__/**", "src/skills/**"],
      // Still emit the report when some tests fail (e.g. the OS-specific suites
      // that only pass on Linux CI) so the threshold gate is always evaluated.
      reportOnFailure: true,
      // Floor set just below the current baseline (stmts ~33%, branches ~28%,
      // funcs ~35%, lines ~33%) so coverage can't silently backslide. Raise as
      // coverage improves. NOTE: the bulk of agent-run behavior is exercised by
      // the integration suites in test/ (currently not wired into CI), so this
      // unit-test floor is deliberately conservative.
      thresholds: {
        statements: 30,
        branches: 25,
        functions: 32,
        lines: 30,
      },
    },
  },
});
