import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBackendConfigured } from "#app/utils/apiUrl";

describe("isBackendConfigured", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.API_URL;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.API_URL;
    else process.env.API_URL = saved;
  });

  it("is false when API_URL is unset (standalone BYOK — dormant seams no-op)", () => {
    delete process.env.API_URL;
    expect(isBackendConfigured()).toBe(false);
  });

  it("is false for an empty API_URL", () => {
    process.env.API_URL = "";
    expect(isBackendConfigured()).toBe(false);
  });

  it("is true when API_URL points at a real backend (hosted SaaS / local dev)", () => {
    process.env.API_URL = "http://localhost:3000";
    expect(isBackendConfigured()).toBe(true);
  });
});
