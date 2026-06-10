import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "#app/utils/cli";
import { retry } from "#app/utils/retry";

vi.mock("#app/utils/cli", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn(async () => undefined),
}));

const sleepMock = vi.mocked(sleep);
const logInfoMock = vi.mocked(log.info);

afterEach(() => {
  vi.clearAllMocks();
});

describe("retry", () => {
  it("returns the result on first success without sleeping", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(retry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("retries transient 'fetch failed' errors with default linear backoff", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce("ok");

    await expect(retry(fn)).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenNthCalledWith(1, 1000);
    expect(sleepMock).toHaveBeenNthCalledWith(2, 2000);
    expect(logInfoMock).toHaveBeenCalledWith(
      "» operation failed (attempt 1/3), retrying in 1000ms...",
    );
  });

  it("retries AbortError by name (default shouldRetry)", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce("ok");

    await expect(retry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries ECONNRESET errors (default shouldRetry)", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockResolvedValueOnce("ok");

    await expect(retry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient errors", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(retry(fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("does not retry non-Error rejections (default shouldRetry)", async () => {
    const fn = vi.fn(async () => {
      throw "string failure";
    });
    await expect(retry(fn)).rejects.toBe("string failure");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws the last error after exhausting all attempts", async () => {
    const fn = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(retry(fn, { maxAttempts: 2 })).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(1000);
  });

  it("uses delayMs as a linear backoff base", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValueOnce("ok");

    await expect(retry(fn, { maxAttempts: 3, delayMs: 10, shouldRetry: () => true })).resolves.toBe(
      "ok",
    );

    expect(sleepMock).toHaveBeenNthCalledWith(1, 10);
    expect(sleepMock).toHaveBeenNthCalledWith(2, 20);
  });

  it("honors an explicit delaysMs schedule over maxAttempts", async () => {
    const fn = vi.fn(async () => {
      throw new Error("always");
    });
    await expect(
      retry(fn, { delaysMs: [5, 7], maxAttempts: 99, shouldRetry: () => true }),
    ).rejects.toThrow("always");

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenNthCalledWith(1, 5);
    expect(sleepMock).toHaveBeenNthCalledWith(2, 7);
  });

  it("uses the custom label in the retry log line", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");

    await retry(fn, { label: "token exchange", shouldRetry: () => true });

    expect(logInfoMock).toHaveBeenCalledWith(
      "» token exchange failed (attempt 1/3), retrying in 1000ms...",
    );
  });

  it("passes the thrown error to a custom shouldRetry and stops when it returns false", async () => {
    const error = new Error("fetch failed");
    const shouldRetry = vi.fn(() => false);
    const fn = vi.fn(async () => {
      throw error;
    });

    await expect(retry(fn, { shouldRetry })).rejects.toBe(error);
    expect(shouldRetry).toHaveBeenCalledWith(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
