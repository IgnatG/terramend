import { resolve } from "node:path";
import { config } from "dotenv";

export default async function setup() {
  // repo-root .env first (standalone), then a parent-dir .env (nested monorepo).
  // dotenv does not override already-set vars, so the repo-root value wins.
  config({ path: resolve(import.meta.dirname, ".env") });
  config({ path: resolve(import.meta.dirname, "../.env") });
}
