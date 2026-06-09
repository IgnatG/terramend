import { log } from "#app/utils/cli";

function isLocalUrl(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/**
 * resolve the Terramend API base URL.
 *
 * in the action: API_URL is not explicitly set, so this falls back to https://terramend.com.
 * in local dev: API_URL=http://localhost:3000 (from .env).
 *
 * enforces https:// for non-local URLs to prevent cleartext credential transmission.
 */
export function getApiUrl(): string {
  const raw = process.env.API_URL || "https://terramend.com";
  const parsed = new URL(raw);

  if (parsed.protocol !== "https:" && !isLocalUrl(parsed)) {
    throw new Error(
      `API_URL must use https:// (got ${parsed.protocol}). only localhost is exempt.`,
    );
  }

  log.debug(`resolved API_URL: ${raw}`);
  return raw;
}

/**
 * Whether a real Terramend backend is configured.
 *
 * Standalone BYOK runs (the OSS default) leave `API_URL` unset — `getApiUrl`
 * then falls back to the marketing host, which serves no API. The dormant
 * open-core persistence seams (repo learnings, run-field PATCHes) must no-op
 * in that case rather than POST into the void and surface the host's 404 as a
 * CI warning. A real backend — the hosted SaaS, or local dev with
 * `API_URL=http://localhost:3000` — sets `API_URL` explicitly.
 */
export function isBackendConfigured(): boolean {
  return Boolean(process.env.API_URL);
}
