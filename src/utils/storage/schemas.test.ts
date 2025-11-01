import {
  describe,
  expect,
  it,
} from "vitest";

import {
  ChainType,
} from "../../types";
import {
  ChainFeesSchema,
  RelayedHeightsSchema,
  RelayPathsSchema,
  safeValidate,
  validateChainFees,
  validateRelayedHeights,
  validateRelayPaths,
} from "./schemas";

describe("Storage Schemas", () => {
  describe("ChainFeesSchema", () => {
    it("should validate valid chain fees", () => {
      const validFees = {
        id: 1,
        chainId: "cosmoshub-4",
        gasPrice: 0.025,
        gasDenom: "uatom",
      };

      expect(() => validateChainFees(validFees)).not.toThrow();
      const result = validateChainFees(validFees);
      expect(result.chainId).toBe("cosmoshub-4");
      expect(result.gasPrice).toBe(0.025);
    });

    it("should reject empty chain ID", () => {
      const invalid = {
        chainId: "",
        gasPrice: 0.025,
        gasDenom: "uatom",
      };

      expect(() => validateChainFees(invalid)).toThrow("Chain ID cannot be empty");
    });

    it("should reject negative gas price", () => {
      const invalid = {
        chainId: "cosmoshub-4",
        gasPrice: -0.025,
        gasDenom: "uatom",
      };

      expect(() => validateChainFees(invalid)).toThrow("Gas price must be positive");
    });

    it("should reject empty gas denomination", () => {
      const invalid = {
        chainId: "cosmoshub-4",
        gasPrice: 0.025,
        gasDenom: "",
      };

      expect(() => validateChainFees(invalid)).toThrow("Gas denomination cannot be empty");
    });

    it("should require id field", () => {
      const invalidWithoutId = {
        chainId: "osmosis-1",
        gasPrice: 0.0025,
        gasDenom: "uosmo",
      };

      expect(() => validateChainFees(invalidWithoutId)).toThrow();
    });
  });

  describe("RelayedHeightsSchema", () => {
    it("should validate valid relayed heights", () => {
      const validHeights = {
        id: 1,
        relayPathId: 5,
        packetHeightA: 1000,
        packetHeightB: 2000,
        ackHeightA: 950,
        ackHeightB: 1950,
      };

      expect(() => validateRelayedHeights(validHeights)).not.toThrow();
      const result = validateRelayedHeights(validHeights);
      expect(result.packetHeightA).toBe(1000);
    });

    it("should reject negative heights", () => {
      const invalid = {
        id: 1,
        relayPathId: 5,
        packetHeightA: -1,
        packetHeightB: 2000,
        ackHeightA: 0,
        ackHeightB: 0,
      };

      expect(() => validateRelayedHeights(invalid)).toThrow();
    });

    it("should accept zero heights (initial state)", () => {
      const valid = {
        id: 1,
        relayPathId: 5,
        packetHeightA: 0,
        packetHeightB: 0,
        ackHeightA: 0,
        ackHeightB: 0,
      };

      expect(() => validateRelayedHeights(valid)).not.toThrow();
    });

    it("should reject missing required fields", () => {
      const invalid = {
        id: 1,
        // Missing relayPathId
        packetHeightA: 100,
      };

      expect(() => validateRelayedHeights(invalid)).toThrow();
    });
  });

  describe("RelayPathsSchema", () => {
    it("should validate valid relay path", () => {
      const validPath = {
        id: 1,
        chainIdA: "cosmoshub-4",
        nodeA: "https://rpc.cosmos.network",
        chainIdB: "osmosis-1",
        nodeB: "https://rpc.osmosis.zone",
        chainTypeA: ChainType.Cosmos,
        chainTypeB: ChainType.Cosmos,
        clientA: "07-tendermint-0",
        clientB: "07-tendermint-1",
        version: 1,
      };

      expect(() => validateRelayPaths(validPath)).not.toThrow();
      const result = validateRelayPaths(validPath);
      expect(result.chainIdA).toBe("cosmoshub-4");
    });

    it("should reject empty chain IDs", () => {
      const invalid = {
        id: 1,
        chainIdA: "",
        nodeA: "https://rpc.cosmos.network",
        chainIdB: "osmosis-1",
        nodeB: "https://rpc.osmosis.zone",
        chainTypeA: ChainType.Cosmos,
        chainTypeB: ChainType.Cosmos,
        clientA: "07-tendermint-0",
        clientB: "07-tendermint-1",
        version: 1,
      };

      expect(() => validateRelayPaths(invalid)).toThrow("Chain ID A cannot be empty");
    });

    it("should reject empty node endpoints", () => {
      const invalid = {
        id: 1,
        chainIdA: "cosmoshub-4",
        nodeA: "",
        chainIdB: "osmosis-1",
        nodeB: "https://rpc.osmosis.zone",
        chainTypeA: ChainType.Cosmos,
        chainTypeB: ChainType.Cosmos,
        clientA: "07-tendermint-0",
        clientB: "07-tendermint-1",
        version: 1,
      };

      expect(() => validateRelayPaths(invalid)).toThrow("Node A cannot be empty");
    });

    it("should reject invalid IBC version", () => {
      const invalid = {
        id: 1,
        chainIdA: "cosmoshub-4",
        nodeA: "https://rpc.cosmos.network",
        chainIdB: "osmosis-1",
        nodeB: "https://rpc.osmosis.zone",
        chainTypeA: ChainType.Cosmos,
        chainTypeB: ChainType.Cosmos,
        clientA: "07-tendermint-0",
        clientB: "07-tendermint-1",
        version: 3,
      };

      expect(() => validateRelayPaths(invalid)).toThrow("IBC version must be 1 or 2");
    });

    it("should accept IBC v2", () => {
      const valid = {
        id: 1,
        chainIdA: "cosmoshub-4",
        nodeA: "https://rpc.cosmos.network",
        chainIdB: "osmosis-1",
        nodeB: "https://rpc.osmosis.zone",
        chainTypeA: ChainType.Cosmos,
        chainTypeB: ChainType.Cosmos,
        clientA: "07-tendermint-0",
        clientB: "07-tendermint-1",
        version: 2,
      };

      expect(() => validateRelayPaths(valid)).not.toThrow();
    });

    it("should reject invalid chain type", () => {
      const invalid = {
        id: 1,
        chainIdA: "cosmoshub-4",
        nodeA: "https://rpc.cosmos.network",
        chainIdB: "osmosis-1",
        nodeB: "https://rpc.osmosis.zone",
        chainTypeA: "invalid-type",
        chainTypeB: ChainType.Cosmos,
        clientA: "07-tendermint-0",
        clientB: "07-tendermint-1",
        version: 1,
      };

      expect(() => validateRelayPaths(invalid)).toThrow();
    });
  });

  describe("safeValidate", () => {
    it("should return success for valid data", () => {
      const validFees = {
        id: 1,
        chainId: "cosmoshub-4",
        gasPrice: 0.025,
        gasDenom: "uatom",
      };

      const result = safeValidate(ChainFeesSchema, validFees);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chainId).toBe("cosmoshub-4");
      }
    });

    it("should return error for invalid data without throwing", () => {
      const invalid = {
        chainId: "",
        gasPrice: -1,
        gasDenom: "uatom",
      };

      const result = safeValidate(ChainFeesSchema, invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });

    it("should provide detailed error messages", () => {
      const invalid = {
        chainId: "",
        gasPrice: -0.025,
        gasDenom: "",
      };

      const result = safeValidate(ChainFeesSchema, invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessages = result.error.issues.map(e => e.message);
        expect(errorMessages).toContain("Chain ID cannot be empty");
        expect(errorMessages).toContain("Gas price must be positive");
        expect(errorMessages).toContain("Gas denomination cannot be empty");
      }
    });
  });
});
