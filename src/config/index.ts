/**
 * Relayer configuration module.
 * Loads and validates configuration from environment variables with sensible defaults.
 */

export type LogLevel = "error" | "warn" | "info" | "debug" | "verbose";

export interface RelayerConfig {
  /** Logging configuration */
  logging: {
    /** Log level (default: "debug") */
    level: LogLevel
    /** Error log file path (default: "error.log") */
    errorFile: string
    /** Combined log file path (default: "combined.log") */
    combinedFile: string
  }

  /** Database configuration */
  database: {
    /** Database file path for SQLite (default: "relayer.db") */
    file: string
  }

  /** Relay loop configuration */
  relay: {
    /** Poll interval in milliseconds (default: 5000) */
    pollInterval: number
    /** Maximum age for destination client in seconds (default: 86400 - 24 hours) */
    maxAgeDest: number
    /** Maximum age for source client in seconds (default: 86400 - 24 hours) */
    maxAgeSrc: number
    /** Timeout threshold in blocks (default: 2) */
    timeoutBlocks: number
    /** Timeout threshold in seconds (default: 6) */
    timeoutSeconds: number
  }

  /** Network retry configuration */
  network: {
    /** Maximum number of retries for network operations (default: 3) */
    maxRetries: number
    /** Initial backoff delay in milliseconds (default: 1000) */
    retryBackoff: number
    /** Maximum backoff delay in milliseconds (default: 30000) */
    maxRetryBackoff: number
  }

  /** Timing estimates */
  timing: {
    /** Estimated block time in milliseconds (default: 6000) */
    estimatedBlockTime: number
    /** Estimated indexer delay in milliseconds (default: 500) */
    estimatedIndexerTime: number
  }
}

const VALID_LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug", "verbose"];

/**
 * Validates and returns a log level from environment variable.
 * @param envValue - The environment variable value
 * @param defaultValue - The default log level to use if invalid
 * @returns A valid LogLevel
 */
function getLogLevel(envValue: string | undefined, defaultValue: LogLevel): LogLevel {
  if (!envValue) {
    return defaultValue;
  }

  const level = envValue.toLowerCase();
  if (VALID_LOG_LEVELS.includes(level as LogLevel)) {
    return level as LogLevel;
  }

  console.warn(`Invalid LOG_LEVEL "${envValue}". Using default: ${defaultValue}`);
  return defaultValue;
}

/**
 * Validates a database file path to prevent directory traversal.
 * @param path - The file path to validate
 * @returns The validated path
 * @throws Error if path contains directory traversal attempts
 */
function validateDbPath(path: string): string {
  if (path.includes("..") || path.startsWith("/etc/") || path.startsWith("/sys/")) {
    throw new Error(`Invalid database path: ${path}. Path traversal or system directories not allowed.`);
  }
  return path;
}

/**
 * Parses a positive integer from an environment variable.
 * @param envValue - The environment variable value
 * @param defaultValue - The default value if parsing fails
 * @param min - Optional minimum value
 * @param max - Optional maximum value
 * @returns The parsed integer or default value
 */
function getPositiveInt(
  envValue: string | undefined,
  defaultValue: number,
  min?: number,
  max?: number,
): number {
  if (!envValue) {
    return defaultValue;
  }

  const parsed = parseInt(envValue, 10);
  if (Number.isNaN(parsed) || parsed < (min ?? 0)) {
    console.warn(`Invalid number "${envValue}". Using default: ${defaultValue}`);
    return defaultValue;
  }

  if (max !== undefined && parsed > max) {
    console.warn(`Value ${parsed} exceeds maximum ${max}. Using maximum.`);
    return max;
  }

  return parsed;
}

/**
 * Loads and validates the relayer configuration from environment variables.
 * @returns Validated RelayerConfig object
 */
function loadConfig(): RelayerConfig {
  return {
    logging: {
      level: getLogLevel(process.env.LOG_LEVEL, "debug"),
      errorFile: process.env.ERROR_LOG_FILE || "error.log",
      combinedFile: process.env.COMBINED_LOG_FILE || "combined.log",
    },
    database: {
      file: validateDbPath(process.env.DB_FILE || "relayer.db"),
    },
    relay: {
      pollInterval: getPositiveInt(process.env.RELAY_POLL_INTERVAL, 5000, 1000, 60000),
      maxAgeDest: getPositiveInt(process.env.RELAY_MAX_AGE_DEST, 86400, 60),
      maxAgeSrc: getPositiveInt(process.env.RELAY_MAX_AGE_SRC, 86400, 60),
      timeoutBlocks: getPositiveInt(process.env.RELAY_TIMEOUT_BLOCKS, 2, 0, 1000),
      timeoutSeconds: getPositiveInt(process.env.RELAY_TIMEOUT_SECONDS, 6, 0, 3600),
    },
    network: {
      maxRetries: getPositiveInt(process.env.NETWORK_MAX_RETRIES, 3, 0, 10),
      retryBackoff: getPositiveInt(process.env.NETWORK_RETRY_BACKOFF, 1000, 100, 10000),
      maxRetryBackoff: getPositiveInt(process.env.NETWORK_MAX_RETRY_BACKOFF, 30000, 1000, 120000),
    },
    timing: {
      estimatedBlockTime: getPositiveInt(process.env.ESTIMATED_BLOCK_TIME, 6000, 1000, 60000),
      estimatedIndexerTime: getPositiveInt(process.env.ESTIMATED_INDEXER_TIME, 500, 0, 10000),
    },
  };
}

// Export singleton config instance
const config = loadConfig();

export default config;

// Also export for backward compatibility
export {
  config,
};
