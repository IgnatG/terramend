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
      // Floor set just below the current baseline (stmts ~92%, branches ~84%,
      // funcs ~92%, lines ~93%) so coverage can't silently backslide. Raise as
      // coverage improves. The residual gap is concentrated in OS-conditional
      // arms (win32/darwin), defensive guards on states the public API can't
      // produce, `satisfies never` exhaustiveness arms, and the test-runner
      // helpers (src/utils/run*.ts) exercised by the integration suites.
      thresholds: {
        statements: 90,
        branches: 82,
        functions: 90,
        lines: 91,
      },
    },
  },
});
