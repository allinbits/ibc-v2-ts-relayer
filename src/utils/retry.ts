import {
  sleep,
} from "@cosmjs/utils";
import * as winston from "winston";

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number
  /** Initial backoff delay in milliseconds (default: 1000) */
  initialBackoff?: number
  /** Maximum backoff delay in milliseconds (default: 30000) */
  maxBackoff?: number
  /** Backoff multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number
  /** Logger instance for logging retry attempts */
  logger?: winston.Logger
  /** Function to determine if an error is retryable (default: all errors are retryable) */
  shouldRetry?: (error: unknown) => boolean
}

const defaultOptions: Required<Omit<RetryOptions, "logger" | "shouldRetry">> = {
  maxRetries: 3,
  initialBackoff: 1000,
  maxBackoff: 30000,
  backoffMultiplier: 2,
};

/**
 * Wraps an async operation with retry logic and exponential backoff.
 *
 * @param operation - The async function to retry
 * @param options - Retry configuration options
 * @returns The result of the operation
 * @throws The last error encountered if all retries fail
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => client.updateClient(clientId, srcClient),
 *   { maxRetries: 5, logger: myLogger }
 * );
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = {
    ...defaultOptions, ...options,
  };
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await operation();
    }
    catch (error) {
      lastError = error;

      // Don't retry if this is the last attempt
      if (attempt === opts.maxRetries) {
        break;
      }

      // Don't retry if the error is not retryable
      if (!shouldRetry(error)) {
        throw error;
      }

      // Calculate backoff delay with exponential growth
      const backoff = Math.min(
        opts.initialBackoff * Math.pow(opts.backoffMultiplier, attempt),
        opts.maxBackoff,
      );

      options.logger?.warn(
        `Operation failed (attempt ${attempt + 1}/${opts.maxRetries + 1}), retrying in ${backoff}ms...`,
        error instanceof Error
          ? {
            message: error.message,
          }
          : error,
      );

      await sleep(backoff);
    }
  }

  // If we get here, all retries failed
  options.logger?.error(`Operation failed after ${opts.maxRetries + 1} attempts`);
  throw lastError;
}

/**
 * Determines if an error is likely a transient network error that should be retried.
 *
 * @param error - The error to check
 * @returns true if the error should be retried
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  // Network-related errors
  const networkErrors = [
    "timeout",
    "econnrefused",
    "econnreset",
    "enotfound",
    "etimedout",
    "network",
    "socket",
    "connection",
    "fetch failed",
    "request failed",
  ];

  return networkErrors.some(errorType => message.includes(errorType));
}

/**
 * Determines if an error is a permanent error that should not be retried.
 *
 * @param error - The error to check
 * @returns true if the error should NOT be retried
 */
export function isPermanentError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true; // Unknown errors should not be retried
  }

  const message = error.message.toLowerCase();

  // Validation and logical errors that won't be fixed by retrying
  const permanentErrors = [
    "invalid",
    "not found",
    "unauthorized",
    "forbidden",
    "bad request",
    "does not match",
    "client state expired",
    "proof verification failed",
    "insufficient",
  ];

  return permanentErrors.some(errorType => message.includes(errorType));
}
