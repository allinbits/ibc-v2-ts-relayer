// @vitest-environment happy-dom

import "fake-indexeddb/auto";

import {
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  ChainType,
} from "../types/index.js";
import {
  DexieStorage,
} from "./dexie-storage.js";

describe("DexieStorage", () => {
  let storage: DexieStorage;

  beforeEach(() => {
    // Create a fresh storage instance for each test
    storage = new DexieStorage();
  });

  describe("addChainFees", () => {
    it("should add chain fees to the database", async () => {
      const chainId = "cosmoshub-4";
      const gasPrice = 0.025;
      const gasDenom = "uatom";

      const result = await storage.addChainFees(chainId, gasPrice, gasDenom);

      expect(result.chainId).toBe(chainId);
      expect(result.gasPrice).toBe(gasPrice);
      expect(result.gasDenom).toBe(gasDenom);
      expect(result.id).toBeDefined();
    });
  });

  describe("getChainFees", () => {
    it("should retrieve chain fees from the database", async () => {
      const chainId = "cosmoshub-4";
      const gasPrice = 0.025;
      const gasDenom = "uatom";

      await storage.addChainFees(chainId, gasPrice, gasDenom);
      const result = await storage.getChainFees(chainId);

      expect(result.chainId).toBe(chainId);
      expect(result.gasPrice).toBe(gasPrice);
      expect(result.gasDenom).toBe(gasDenom);
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
        undefined,
        "osmosis-1",
        "http://localhost:26658",
        undefined,
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
  });

  describe("getRelayedHeights", () => {
    it("should retrieve existing relayed heights", async () => {
      const path = await storage.addRelayPath(
        "cosmoshub-4",
        "http://localhost:26657",
        undefined,
        "osmosis-1",
        "http://localhost:26658",
        undefined,
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

    it("should return zero heights when not found", async () => {
      const path = await storage.addRelayPath(
        "juno-1",
        "http://localhost:26659",
        undefined,
        "osmosis-1",
        "http://localhost:26658",
        undefined,
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-2",
        "07-tendermint-3",
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
        undefined,
        "osmosis-1",
        "http://localhost:26658",
        undefined,
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

    it("should return existing path if already exists", async () => {
      const first = await storage.addRelayPath(
        "cosmoshub-4",
        "http://localhost:26657",
        undefined,
        "osmosis-1",
        "http://localhost:26658",
        undefined,
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-0",
        "07-tendermint-1",
        1,
      );

      const second = await storage.addRelayPath(
        "cosmoshub-4",
        "http://localhost:26657",
        undefined,
        "osmosis-1",
        "http://localhost:26658",
        undefined,
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-0",
        "07-tendermint-1",
        1,
      );

      expect(first.id).toBe(second.id);
    });
  });

  describe("getRelayPath", () => {
    it("should retrieve a specific relay path", async () => {
      await storage.addRelayPath(
        "cosmoshub-4",
        "http://localhost:26657",
        undefined,
        "osmosis-1",
        "http://localhost:26658",
        undefined,
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
        undefined,
        "osmosis-1",
        "http://localhost:26658",
        undefined,
        ChainType.Cosmos,
        ChainType.Cosmos,
        "07-tendermint-0",
        "07-tendermint-1",
        1,
      );

      await storage.addRelayPath(
        "juno-1",
        "http://localhost:26659",
        undefined,
        "osmosis-1",
        "http://localhost:26658",
        undefined,
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
});
