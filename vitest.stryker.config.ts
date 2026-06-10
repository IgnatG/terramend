import { defineConfig } from "vitest/config";

// Vitest config used ONLY by Stryker mutation runs (see stryker.config.json).
// Identical to vitest.config.ts minus coverage (Stryker does its own
// instrumentation) and minus the test files that are red on a Windows dev
// host (POSIX signals, /bin/bash, env-var case) — Stryker refuses to start
// from a non-green baseline. None of the excluded files test the modules
// listed in `mutate`, so the exclusion does not inflate the mutation score.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/.temp/**",
      "**/.pnpm-store/**",
      "**/*.main.test.ts",
      "src/utils/normalizeEnv.test.ts",
      "src/utils/agent.test.ts",
      "src/utils/setup.test.ts",
      "src/utils/subprocess.test.ts",
    ],
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Stryker's instrumentation + 4 concurrent runner processes make
    // individual tests far slower than a plain vitest run; the default 5s
    // timeout produces spurious dry-run failures.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
