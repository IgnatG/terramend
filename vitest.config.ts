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
    // test:coverage`) so the default PR run stays fast. Requires the provider:
    // `pnpm add -D @vitest/coverage-v8`.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__fixtures__/**", "src/skills/**"],
      // After a first `pnpm test:coverage` baseline, set thresholds here to
      // prevent backsliding, e.g.:
      // thresholds: { lines: 40, functions: 40, branches: 40, statements: 40 },
    },
  },
});
