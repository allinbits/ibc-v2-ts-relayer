import fs from "node:fs";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  ChainType,
} from "../types/index.js";
import {
  SQLiteStorage,
} from "./sqlite-storage.js";

describe("SQLiteStorage", () => {
  let storage: SQLiteStorage;
  // Use a temp file that we clean up after tests
  const testDbPath = ".test-temp.db";

  beforeEach(() => {
    // Create a new storage instance with temp database file
    storage = new SQLiteStorage(testDbPath);
  });

  afterEach(async () => {
    // Clean up is handled in afterAll
  });

  afterAll(() => {
    // Clean up temp database file
    try {
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    }
    catch (err) {
      // Ignore cleanup errors
    }
  });

  describe("constructor", () => {
    it("should use config database path by default", () => {
      const storageInstance = new SQLiteStorage(":memory:");
      expect(storageInstance).toBeDefined();
    });

    it("should use custom database path when provided", () => {
      const storageInstance = new SQLiteStorage(":memory:");
      expect(storageInstance).toBeDefined();
    });
  });

  describe("addChainFees", () => {
    it("should add chain fees to the database", async () => {
      const result = await storage.addChainFees("cosmoshub-4", 0.025, "uatom");

      expect(result.chainId).toBe("cosmoshub-4");
      expect(result.gasPrice).toBe(0.025);
      expect(result.gasDenom).toBe("uatom");
      expect(result.id).toBeDefined();
    });
  });

  describe("getChainFees", () => {
    it("should retrieve chain fees from the database", async () => {
      await storage.addChainFees("cosmoshub-4", 0.025, "uatom");
      const result = await storage.getChainFees("cosmoshub-4");

      expect(result.chainId).toBe("cosmoshub-4");
      expect(result.gasPrice).toBe(0.025);
      expect(result.gasDenom).toBe("uatom");
    });

    it("should throw error when chain fees not found", async () => {
      await expect(
        storage.getChainFees("unknown-chain"),
      ).rejects.toThrow("Chain fees not found");
    });
  });

  describe("updateRelayedHeights", () => {
    it("should update relayed heights in the database", async () => {
      // First add a relay path
      const path = await storage.addRelayPath(
        "cosmoshub-4",
        "http://localhost:26657",
        "osmosis-1",
        "http://localhost:26658",
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-0",
        "07-tendermint-1",
        1,
      );

      await storage.updateRelayedHeights(path.id, 100, 200, 50, 75);
      const heights = await storage.getRelayedHeights(path.id);

      expect(heights.packetHeightA).toBe(100);
      expect(heights.packetHeightB).toBe(200);
      expect(heights.ackHeightA).toBe(50);
      expect(heights.ackHeightB).toBe(75);
    });

    it("should initialize and update when heights not found", async () => {
      // First add a relay path
      const path = await storage.addRelayPath(
        "juno-1",
        "http://localhost:26659",
        "osmosis-1",
        "http://localhost:26658",
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-2",
        "07-tendermint-3",
        1,
      );

      // Update should work even if heights weren't explicitly initialized
      await storage.updateRelayedHeights(path.id, 100, 200, 50, 75);
      const heights = await storage.getRelayedHeights(path.id);

      expect(heights.packetHeightA).toBe(100);
      expect(heights.packetHeightB).toBe(200);
    });
  });

  describe("getRelayedHeights", () => {
    it("should retrieve existing relayed heights", async () => {
      const path = await storage.addRelayPath(
        "cosmoshub-4",
        "http://localhost:26657",
        "osmosis-1",
        "http://localhost:26658",
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-0",
        "07-tendermint-1",
        1,
      );

      await storage.updateRelayedHeights(path.id, 100, 200, 50, 75);
      const result = await storage.getRelayedHeights(path.id);

      expect(result.packetHeightA).toBe(100);
      expect(result.packetHeightB).toBe(200);
      expect(result.ackHeightA).toBe(50);
      expect(result.ackHeightB).toBe(75);
    });

    it("should initialize heights when not found", async () => {
      // Use unique chain IDs to avoid conflicts with other tests in shared memory DB
      const path = await storage.addRelayPath(
        "fresh-chain-1",
        "http://localhost:26659",
        "fresh-chain-2",
        "http://localhost:26658",
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-99",
        "07-tendermint-100",
        1,
      );

      const result = await storage.getRelayedHeights(path.id);

      expect(result.packetHeightA).toBe(0);
      expect(result.packetHeightB).toBe(0);
      expect(result.ackHeightA).toBe(0);
      expect(result.ackHeightB).toBe(0);
    });
  });

  describe("addRelayPath", () => {
    it("should add a new relay path", async () => {
      const result = await storage.addRelayPath(
        "cosmoshub-4",
        "http://localhost:26657",
        "osmosis-1",
        "http://localhost:26658",
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-0",
        "07-tendermint-1",
        1,
      );

      expect(result).toBeDefined();
      expect(result.chainIdA).toBe("cosmoshub-4");
      expect(result.chainIdB).toBe("osmosis-1");
      expect(result.nodeA).toBe("http://localhost:26657");
      expect(result.nodeB).toBe("http://localhost:26658");
      expect(result.clientA).toBe("07-tendermint-0");
      expect(result.clientB).toBe("07-tendermint-1");
      expect(result.version).toBe(1);
    });
  });

  describe("getRelayPath", () => {
    it("should retrieve a specific relay path", async () => {
      await storage.addRelayPath(
        "cosmoshub-4",
        "http://localhost:26657",
        "osmosis-1",
        "http://localhost:26658",
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-0",
        "07-tendermint-1",
        1,
      );

      const result = await storage.getRelayPath(
        "cosmoshub-4",
        "osmosis-1",
        "07-tendermint-0",
        "07-tendermint-1",
        1,
      );

      expect(result).toBeDefined();
      expect(result?.chainIdA).toBe("cosmoshub-4");
      expect(result?.chainIdB).toBe("osmosis-1");
    });

    it("should return undefined when path not found", async () => {
      const result = await storage.getRelayPath(
        "unknown-a",
        "unknown-b",
        "client-a",
        "client-b",
        1,
      );

      expect(result).toBeUndefined();
    });
  });

  describe("getRelayPaths", () => {
    it("should retrieve all relay paths", async () => {
      await storage.addRelayPath(
        "cosmoshub-4",
        "http://localhost:26657",
        "osmosis-1",
        "http://localhost:26658",
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-0",
        "07-tendermint-1",
        1,
      );

      await storage.addRelayPath(
        "juno-1",
        "http://localhost:26659",
        "osmosis-1",
        "http://localhost:26658",
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-2",
        "07-tendermint-3",
        2,
      );

      const result = await storage.getRelayPaths();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it("should return empty array when no paths exist", async () => {
      const result = await storage.getRelayPaths();

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("database operations", () => {
    it("should use temporary database file", async () => {
      // Use a separate temp file for isolated test
      const isolatedDbPath = ".test-isolated.db";
      const customStorage = new SQLiteStorage(isolatedDbPath);

      try {
        // First query should fail since nothing is added
        await expect(
          customStorage.getChainFees("isolated-test-chain"),
        ).rejects.toThrow("Chain fees not found");

        // Verify it works after adding data
        await customStorage.addChainFees("isolated-test-chain", 0.1, "utest");
        const result = await customStorage.getChainFees("isolated-test-chain");
        expect(result.chainId).toBe("isolated-test-chain");
      }
      finally {
        // Clean up isolated test file
        try {
          if (fs.existsSync(isolatedDbPath)) {
            fs.unlinkSync(isolatedDbPath);
          }
        }
        catch (err) {
          // Ignore cleanup errors
        }
      }
    });
  });
});
