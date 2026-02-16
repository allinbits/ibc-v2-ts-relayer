import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
    };
    // Clear console mocks
    vi.spyOn(console, "warn").mockImplementation(() => {
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("default configuration", () => {
    it("should load default config when no env vars are set", async () => {
      process.env = {
      };
      const {
        config,
      } = await import("./index.js");

      expect(config.logging.level).toBe("debug");
      expect(config.logging.errorFile).toBe(path.resolve("error.log"));
      expect(config.logging.combinedFile).toBe(path.resolve("combined.log"));
      expect(config.database.file).toBe(path.resolve("relayer.db"));
      expect(config.relay.pollInterval).toBe(5000);
      expect(config.relay.maxAgeDest).toBe(86400);
      expect(config.relay.maxAgeSrc).toBe(86400);
      expect(config.relay.timeoutBlocks).toBe(2);
      expect(config.relay.timeoutSeconds).toBe(6);
      expect(config.network.maxRetries).toBe(3);
      expect(config.network.retryBackoff).toBe(1000);
      expect(config.network.maxRetryBackoff).toBe(30000);
      expect(config.timing.estimatedBlockTime).toBe(6000);
      expect(config.timing.estimatedIndexerTime).toBe(500);
    });
  });

  describe("logging configuration", () => {
    it("should accept valid log levels", async () => {
      const levels = ["error", "warn", "info", "debug", "verbose"];

      for (const level of levels) {
        vi.resetModules();
        process.env.LOG_LEVEL = level;
        const {
          config,
        } = await import("./index.js");
        expect(config.logging.level).toBe(level);
      }
    });

    it("should use default for invalid log level", async () => {
      process.env.LOG_LEVEL = "invalid";
      const {
        config,
      } = await import("./index.js");

      expect(config.logging.level).toBe("debug");
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("Invalid LOG_LEVEL"),
      );
    });

    it("should handle case-insensitive log levels", async () => {
      process.env.LOG_LEVEL = "ERROR";
      const {
        config,
      } = await import("./index.js");

      expect(config.logging.level).toBe("error");
    });

    it("should accept custom error log file", async () => {
      process.env.ERROR_LOG_FILE = "custom-error.log";
      const {
        config,
      } = await import("./index.js");

      expect(config.logging.errorFile).toBe(path.resolve("custom-error.log"));
    });

    it("should accept custom combined log file", async () => {
      process.env.COMBINED_LOG_FILE = "custom-combined.log";
      const {
        config,
      } = await import("./index.js");

      expect(config.logging.combinedFile).toBe(path.resolve("custom-combined.log"));
    });
  });

  describe("database configuration", () => {
    it("should accept valid database file path", async () => {
      process.env.DB_FILE = "custom.db";
      const {
        config,
      } = await import("./index.js");

      expect(config.database.file).toBe(path.resolve("custom.db"));
    });

    it("should reject path with directory traversal", async () => {
      process.env.DB_FILE = "../etc/passwd";

      await expect(async () => {
        await import("./index.js");
      }).rejects.toThrow("Invalid database path");
    });

    it("should reject system directory paths", async () => {
      process.env.DB_FILE = "/etc/relayer.db";

      await expect(async () => {
        await import("./index.js");
      }).rejects.toThrow("Invalid database path");
    });

    it("should reject /sys/ directory paths", async () => {
      process.env.DB_FILE = "/sys/relayer.db";

      await expect(async () => {
        await import("./index.js");
      }).rejects.toThrow("Invalid database path");
    });

    it("should accept relative paths without traversal", async () => {
      process.env.DB_FILE = "data/relayer.db";
      const {
        config,
      } = await import("./index.js");

      expect(config.database.file).toBe(path.resolve("data/relayer.db"));
    });
  });

  describe("relay configuration", () => {
    it("should accept valid poll interval", async () => {
      process.env.RELAY_POLL_INTERVAL = "10000";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.pollInterval).toBe(10000);
    });

    it("should enforce minimum poll interval", async () => {
      process.env.RELAY_POLL_INTERVAL = "500";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.pollInterval).toBe(5000); // default
      expect(console.warn).toHaveBeenCalled();
    });

    it("should enforce maximum poll interval", async () => {
      process.env.RELAY_POLL_INTERVAL = "100000";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.pollInterval).toBe(60000); // max
      expect(console.warn).toHaveBeenCalled();
    });

    it("should accept valid maxAgeDest", async () => {
      process.env.RELAY_MAX_AGE_DEST = "3600";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.maxAgeDest).toBe(3600);
    });

    it("should enforce minimum maxAgeDest", async () => {
      process.env.RELAY_MAX_AGE_DEST = "30";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.maxAgeDest).toBe(86400); // default
    });

    it("should accept valid maxAgeSrc", async () => {
      process.env.RELAY_MAX_AGE_SRC = "7200";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.maxAgeSrc).toBe(7200);
    });

    it("should accept valid timeout blocks", async () => {
      process.env.RELAY_TIMEOUT_BLOCKS = "5";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.timeoutBlocks).toBe(5);
    });

    it("should enforce maximum timeout blocks", async () => {
      process.env.RELAY_TIMEOUT_BLOCKS = "2000";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.timeoutBlocks).toBe(1000); // max
    });

    it("should accept valid timeout seconds", async () => {
      process.env.RELAY_TIMEOUT_SECONDS = "30";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.timeoutSeconds).toBe(30);
    });

    it("should enforce maximum timeout seconds", async () => {
      process.env.RELAY_TIMEOUT_SECONDS = "5000";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.timeoutSeconds).toBe(3600); // max
    });
  });

  describe("network configuration", () => {
    it("should accept valid max retries", async () => {
      process.env.NETWORK_MAX_RETRIES = "5";
      const {
        config,
      } = await import("./index.js");

      expect(config.network.maxRetries).toBe(5);
    });

    it("should enforce maximum retries", async () => {
      process.env.NETWORK_MAX_RETRIES = "20";
      const {
        config,
      } = await import("./index.js");

      expect(config.network.maxRetries).toBe(10); // max
    });

    it("should accept valid retry backoff", async () => {
      process.env.NETWORK_RETRY_BACKOFF = "2000";
      const {
        config,
      } = await import("./index.js");

      expect(config.network.retryBackoff).toBe(2000);
    });

    it("should enforce minimum retry backoff", async () => {
      process.env.NETWORK_RETRY_BACKOFF = "50";
      const {
        config,
      } = await import("./index.js");

      expect(config.network.retryBackoff).toBe(1000); // default
    });

    it("should enforce maximum retry backoff", async () => {
      process.env.NETWORK_RETRY_BACKOFF = "20000";
      const {
        config,
      } = await import("./index.js");

      expect(config.network.retryBackoff).toBe(10000); // max
    });

    it("should accept valid max retry backoff", async () => {
      process.env.NETWORK_MAX_RETRY_BACKOFF = "60000";
      const {
        config,
      } = await import("./index.js");

      expect(config.network.maxRetryBackoff).toBe(60000);
    });

    it("should enforce minimum max retry backoff", async () => {
      process.env.NETWORK_MAX_RETRY_BACKOFF = "500";
      const {
        config,
      } = await import("./index.js");

      expect(config.network.maxRetryBackoff).toBe(30000); // default
    });

    it("should enforce maximum max retry backoff", async () => {
      process.env.NETWORK_MAX_RETRY_BACKOFF = "200000";
      const {
        config,
      } = await import("./index.js");

      expect(config.network.maxRetryBackoff).toBe(120000); // max
    });
  });

  describe("timing configuration", () => {
    it("should accept valid estimated block time", async () => {
      process.env.ESTIMATED_BLOCK_TIME = "8000";
      const {
        config,
      } = await import("./index.js");

      expect(config.timing.estimatedBlockTime).toBe(8000);
    });

    it("should enforce minimum estimated block time", async () => {
      process.env.ESTIMATED_BLOCK_TIME = "500";
      const {
        config,
      } = await import("./index.js");

      expect(config.timing.estimatedBlockTime).toBe(6000); // default
    });

    it("should enforce maximum estimated block time", async () => {
      process.env.ESTIMATED_BLOCK_TIME = "100000";
      const {
        config,
      } = await import("./index.js");

      expect(config.timing.estimatedBlockTime).toBe(60000); // max
    });

    it("should accept valid estimated indexer time", async () => {
      process.env.ESTIMATED_INDEXER_TIME = "1000";
      const {
        config,
      } = await import("./index.js");

      expect(config.timing.estimatedIndexerTime).toBe(1000);
    });

    it("should enforce maximum estimated indexer time", async () => {
      process.env.ESTIMATED_INDEXER_TIME = "15000";
      const {
        config,
      } = await import("./index.js");

      expect(config.timing.estimatedIndexerTime).toBe(10000); // max
    });

    it("should allow zero estimated indexer time", async () => {
      process.env.ESTIMATED_INDEXER_TIME = "0";
      const {
        config,
      } = await import("./index.js");

      expect(config.timing.estimatedIndexerTime).toBe(0);
    });
  });

  describe("invalid number handling", () => {
    it("should use default for non-numeric values", async () => {
      process.env.RELAY_POLL_INTERVAL = "not a number";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.pollInterval).toBe(5000);
      expect(console.warn).toHaveBeenCalled();
    });

    it("should use default for negative values", async () => {
      process.env.NETWORK_MAX_RETRIES = "-5";
      const {
        config,
      } = await import("./index.js");

      expect(config.network.maxRetries).toBe(3);
    });

    it("should use default for empty strings", async () => {
      process.env.RELAY_TIMEOUT_BLOCKS = "";
      const {
        config,
      } = await import("./index.js");

      expect(config.relay.timeoutBlocks).toBe(2);
    });
  });

  describe("comprehensive config loading", () => {
    it("should load all custom env vars correctly", async () => {
      process.env.LOG_LEVEL = "info";
      process.env.ERROR_LOG_FILE = "errors.log";
      process.env.COMBINED_LOG_FILE = "logs.log";
      process.env.DB_FILE = "mydb.db";
      process.env.RELAY_POLL_INTERVAL = "7500";
      process.env.RELAY_MAX_AGE_DEST = "3600";
      process.env.RELAY_MAX_AGE_SRC = "7200";
      process.env.RELAY_TIMEOUT_BLOCKS = "3";
      process.env.RELAY_TIMEOUT_SECONDS = "10";
      process.env.NETWORK_MAX_RETRIES = "5";
      process.env.NETWORK_RETRY_BACKOFF = "1500";
      process.env.NETWORK_MAX_RETRY_BACKOFF = "45000";
      process.env.ESTIMATED_BLOCK_TIME = "8000";
      process.env.ESTIMATED_INDEXER_TIME = "750";

      const {
        config,
      } = await import("./index.js");

      expect(config.logging.level).toBe("info");
      expect(config.logging.errorFile).toBe(path.resolve("errors.log"));
      expect(config.logging.combinedFile).toBe(path.resolve("logs.log"));
      expect(config.database.file).toBe(path.resolve("mydb.db"));
      expect(config.relay.pollInterval).toBe(7500);
      expect(config.relay.maxAgeDest).toBe(3600);
      expect(config.relay.maxAgeSrc).toBe(7200);
      expect(config.relay.timeoutBlocks).toBe(3);
      expect(config.relay.timeoutSeconds).toBe(10);
      expect(config.network.maxRetries).toBe(5);
      expect(config.network.retryBackoff).toBe(1500);
      expect(config.network.maxRetryBackoff).toBe(45000);
      expect(config.timing.estimatedBlockTime).toBe(8000);
      expect(config.timing.estimatedIndexerTime).toBe(750);
    });
  });
});
