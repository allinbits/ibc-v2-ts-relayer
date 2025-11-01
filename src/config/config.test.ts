import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

describe("Configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should use default configuration when no env vars set", async () => {
    delete process.env.LOG_LEVEL;
    delete process.env.DB_FILE;

    const {
      default: config,
    } = await import("./index");

    expect(config.logging.level).toBe("debug");
    expect(config.database.file).toBe("relayer.db");
    expect(config.relay.pollInterval).toBe(5000);
    expect(config.relay.maxAgeDest).toBe(86400);
    expect(config.relay.maxAgeSrc).toBe(86400);
    expect(config.relay.timeoutBlocks).toBe(2);
    expect(config.relay.timeoutSeconds).toBe(6);
    expect(config.network.maxRetries).toBe(3);
  });

  it("should load custom log level from environment", async () => {
    process.env.LOG_LEVEL = "error";

    const {
      default: config,
    } = await import("./index");

    expect(config.logging.level).toBe("error");
  });

  it("should handle case-insensitive log levels", async () => {
    process.env.LOG_LEVEL = "INFO";

    const {
      default: config,
    } = await import("./index");

    expect(config.logging.level).toBe("info");
  });

  it("should use default for invalid log level", async () => {
    process.env.LOG_LEVEL = "invalid";

    const {
      default: config,
    } = await import("./index");

    expect(config.logging.level).toBe("debug");
  });

  it("should load custom database file", async () => {
    process.env.DB_FILE = "custom.db";

    const {
      default: config,
    } = await import("./index");

    expect(config.database.file).toBe("custom.db");
  });

  it("should reject directory traversal in database path", async () => {
    process.env.DB_FILE = "../../../etc/passwd";

    await expect(async () => {
      await import("./index");
    }).rejects.toThrow("Path traversal or system directories not allowed");
  });

  it("should reject system directory paths", async () => {
    process.env.DB_FILE = "/etc/relayer.db";

    await expect(async () => {
      await import("./index");
    }).rejects.toThrow("system directories not allowed");
  });

  it("should load custom relay configuration", async () => {
    process.env.RELAY_POLL_INTERVAL = "10000";
    process.env.RELAY_MAX_AGE_DEST = "43200";
    process.env.RELAY_TIMEOUT_BLOCKS = "5";

    const {
      default: config,
    } = await import("./index");

    expect(config.relay.pollInterval).toBe(10000);
    expect(config.relay.maxAgeDest).toBe(43200);
    expect(config.relay.timeoutBlocks).toBe(5);
  });

  it("should enforce minimum values", async () => {
    process.env.RELAY_POLL_INTERVAL = "500"; // Below minimum of 1000

    const {
      default: config,
    } = await import("./index");

    expect(config.relay.pollInterval).toBe(5000); // Falls back to default
  });

  it("should enforce maximum values", async () => {
    process.env.RELAY_POLL_INTERVAL = "100000"; // Above maximum of 60000

    const {
      default: config,
    } = await import("./index");

    expect(config.relay.pollInterval).toBe(60000); // Capped at maximum
  });

  it("should load network retry configuration", async () => {
    process.env.NETWORK_MAX_RETRIES = "5";
    process.env.NETWORK_RETRY_BACKOFF = "2000";
    process.env.NETWORK_MAX_RETRY_BACKOFF = "60000";

    const {
      default: config,
    } = await import("./index");

    expect(config.network.maxRetries).toBe(5);
    expect(config.network.retryBackoff).toBe(2000);
    expect(config.network.maxRetryBackoff).toBe(60000);
  });

  it("should use default for non-numeric values", async () => {
    process.env.RELAY_POLL_INTERVAL = "not-a-number";

    const {
      default: config,
    } = await import("./index");

    expect(config.relay.pollInterval).toBe(5000); // Falls back to default
  });
});
