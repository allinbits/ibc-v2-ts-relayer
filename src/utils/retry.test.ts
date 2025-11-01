import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as winston from "winston";

import {
  isPermanentError,
  isRetryableError,
  withRetry,
} from "./retry";

describe("withRetry", () => {
  let mockLogger: winston.Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      verbose: vi.fn(),
      debug: vi.fn(),
    } as any;
  });

  it("should return result on first successful attempt", async () => {
    const operation = vi.fn().mockResolvedValue("success");

    const result = await withRetry(operation);

    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and succeed", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockRejectedValueOnce(new Error("Another failure"))
      .mockResolvedValue("success");

    const result = await withRetry(operation, {
      maxRetries: 3,
      initialBackoff: 10,
      logger: mockLogger,
    });

    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });

  it("should throw after max retries exceeded", async () => {
    const error = new Error("Persistent failure");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(operation, {
        maxRetries: 2,
        initialBackoff: 10,
        logger: mockLogger,
      }),
    ).rejects.toThrow("Persistent failure");

    expect(operation).toHaveBeenCalledTimes(3); // Initial + 2 retries
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).toHaveBeenCalledWith("Operation failed after 3 attempts");
  });

  it("should not retry if shouldRetry returns false", async () => {
    const error = new Error("Non-retryable error");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(operation, {
        shouldRetry: () => false,
        logger: mockLogger,
      }),
    ).rejects.toThrow("Non-retryable error");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("should use exponential backoff", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("Failure 1"))
      .mockRejectedValueOnce(new Error("Failure 2"))
      .mockResolvedValue("success");

    await withRetry(operation, {
      maxRetries: 2,
      initialBackoff: 100,
      backoffMultiplier: 2,
      logger: mockLogger,
    });

    // Check that backoff delays were used
    const warnCalls = vi.mocked(mockLogger.warn).mock.calls;
    expect(warnCalls[0][0]).toContain("retrying in 100ms");
    expect(warnCalls[1][0]).toContain("retrying in 200ms");
  });

  it("should cap backoff at maxBackoff", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("Failure 1"))
      .mockRejectedValueOnce(new Error("Failure 2"))
      .mockResolvedValue("success");

    await withRetry(operation, {
      maxRetries: 2,
      initialBackoff: 1000,
      backoffMultiplier: 10,
      maxBackoff: 2000,
      logger: mockLogger,
    });

    const warnCalls = vi.mocked(mockLogger.warn).mock.calls;
    expect(warnCalls[0][0]).toContain("retrying in 1000ms");
    expect(warnCalls[1][0]).toContain("retrying in 2000ms"); // Capped at 2000, not 10000
  });

  it("should work without logger", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("Failure"))
      .mockResolvedValue("success");

    const result = await withRetry(operation, {
      maxRetries: 1,
      initialBackoff: 10,
    });

    expect(result).toBe("success");
  });
});

describe("isRetryableError", () => {
  it("should identify timeout errors as retryable", () => {
    expect(isRetryableError(new Error("Request timeout"))).toBe(true);
    expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("should identify connection errors as retryable", () => {
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("Connection refused"))).toBe(true);
  });

  it("should identify network errors as retryable", () => {
    expect(isRetryableError(new Error("Network error occurred"))).toBe(true);
    expect(isRetryableError(new Error("Fetch failed"))).toBe(true);
  });

  it("should return false for non-Error objects", () => {
    expect(isRetryableError("string error")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it("should return false for unrelated errors", () => {
    expect(isRetryableError(new Error("Invalid input provided"))).toBe(false);
  });
});

describe("isPermanentError", () => {
  it("should identify validation errors as permanent", () => {
    expect(isPermanentError(new Error("Invalid chain ID"))).toBe(true);
    expect(isPermanentError(new Error("Client state does not match"))).toBe(true);
  });

  it("should identify not found errors as permanent", () => {
    expect(isPermanentError(new Error("Connection not found"))).toBe(true);
    expect(isPermanentError(new Error("Client not found"))).toBe(true);
  });

  it("should identify authorization errors as permanent", () => {
    expect(isPermanentError(new Error("Unauthorized access"))).toBe(true);
    expect(isPermanentError(new Error("Forbidden"))).toBe(true);
  });

  it("should return true for non-Error objects", () => {
    expect(isPermanentError("string error")).toBe(true);
    expect(isPermanentError(null)).toBe(true);
    expect(isPermanentError(undefined)).toBe(true);
  });

  it("should return false for network errors", () => {
    expect(isPermanentError(new Error("Connection timeout"))).toBe(false);
    expect(isPermanentError(new Error("Network error"))).toBe(false);
  });
});
