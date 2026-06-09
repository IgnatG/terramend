import { resolve } from "node:path";
import { config } from "dotenv";

// Mirror vitest.global-setup.ts: global setup runs in a separate process whose
// env mutations don't reach test workers, so this per-worker setup must seed the
// same vars. repo-root .env first (standalone), then a parent-dir .env (nested
// monorepo). dotenv does not override already-set vars, so the repo-root wins.
config({ path: resolve(import.meta.dirname, ".env") });
config({ path: resolve(import.meta.dirname, "../.env") });
