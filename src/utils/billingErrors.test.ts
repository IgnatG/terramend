import { describe, expect, it } from "vitest";
import {
  BillingError,
  formatBillingErrorSummary,
  formatTransientErrorSummary,
  TransientError,
} from "#app/utils/billingErrors";

describe("BillingError", () => {
  it("defaults the classification fields", () => {
    const error = new BillingError("payment failed");
    expect(error.name).toBe("BillingError");
    expect(error.message).toBe("payment failed");
    expect(error.code).toBeNull();
    expect(error.declineCode).toBeNull();
    expect(error.needsReauthentication).toBe(false);
  });

  it("keeps the provided classification fields", () => {
    const error = new BillingError("declined", {
      code: "router_requires_card",
      declineCode: "insufficient_funds",
      needsReauthentication: true,
    });
    expect(error.code).toBe("router_requires_card");
    expect(error.declineCode).toBe("insufficient_funds");
    expect(error.needsReauthentication).toBe(true);
  });
});

describe("formatBillingErrorSummary", () => {
  it("renders the add-a-card CTA for router_requires_card", () => {
    const msg = formatBillingErrorSummary(
      new BillingError("x", { code: "router_requires_card" }),
      "acme",
    );
    expect(msg).toContain("**Add a card to start using Terramend Router.**");
    expect(msg).toContain("https://terramend.com/console/acme#model-access");
  });

  it("renders the exhausted-balance CTA for router_balance_exhausted", () => {
    const msg = formatBillingErrorSummary(
      new BillingError("x", { code: "router_balance_exhausted" }),
      "acme",
    );
    expect(msg).toContain("balance is exhausted");
    expect(msg).toContain("https://terramend.com/console/acme#billing");
    expect(msg).toContain("https://terramend.com/console/acme#model-access");
  });

  it("renders the cut-short framing for router_keylimit_exhausted", () => {
    const msg = formatBillingErrorSummary(
      new BillingError("x", { code: "router_keylimit_exhausted" }),
      "acme",
    );
    expect(msg).toContain("cut short");
    expect(msg).toContain("#billing");
  });

  it("renders the monthly-cap framing for router_monthly_limit", () => {
    const msg = formatBillingErrorSummary(
      new BillingError("x", { code: "router_monthly_limit" }),
      "acme",
    );
    expect(msg).toContain("monthly spend limit");
    expect(msg).toContain("#model-access");
  });

  it("renders the 3DS branch with the specific decline code when present", () => {
    const msg = formatBillingErrorSummary(
      new BillingError("x", { needsReauthentication: true, declineCode: "authentication_needed" }),
      "acme",
    );
    expect(msg).toContain("3D Secure");
    expect(msg).toContain("`authentication_needed`");
  });

  it("falls back to authentication_required when 3DS has no decline code", () => {
    const msg = formatBillingErrorSummary(
      new BillingError("x", { needsReauthentication: true }),
      "acme",
    );
    expect(msg).toContain("`authentication_required`");
  });

  it("renders the card-declined branch with the Stripe sub-code", () => {
    const msg = formatBillingErrorSummary(
      new BillingError("x", { declineCode: "lost_card" }),
      "acme",
    );
    expect(msg).toContain("**Your card was declined** (`lost_card`).");
    expect(msg).toContain("#billing");
  });

  it("renders the empty-balance default branch", () => {
    const msg = formatBillingErrorSummary(new BillingError("x"), "acme");
    expect(msg).toContain("**Your Terramend balance is empty.**");
    expect(msg).toContain("https://terramend.com/console/acme#billing");
  });

  it("URL-encodes the owner in the console deep link", () => {
    const msg = formatBillingErrorSummary(new BillingError("x"), "weird org");
    expect(msg).toContain("https://terramend.com/console/weird%20org#billing");
  });
});

describe("TransientError / formatTransientErrorSummary", () => {
  it("names the error class", () => {
    const error = new TransientError("sync in flight");
    expect(error.name).toBe("TransientError");
    expect(error.message).toBe("sync in flight");
  });

  it("frames the failure as temporary and includes the message + console link", () => {
    const msg = formatTransientErrorSummary(new TransientError("usage sync incomplete"), "acme");
    expect(msg).toContain("temporarily unavailable");
    expect(msg).toContain("usage sync incomplete");
    expect(msg).toContain("status.terramend.com");
    expect(msg).toContain("https://terramend.com/console/acme#billing");
  });
});
