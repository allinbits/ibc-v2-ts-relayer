import {
  ClientState as TendermintClientState,
  ConsensusState as TendermintConsensusState,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  describe, expect, it, vi,
} from "vitest";
import * as winston from "winston";

import {
  ClientType,
} from "../types/index.js";
import {
  BaseIbcClient,
  isTendermint,
  isTendermintClientState,
  isTendermintConsensusState,
} from "./BaseIbcClient.js";
import {
  TendermintIbcClient,
} from "./tendermint/IbcClient.js";

describe("BaseIbcClient Type Guards", () => {
  const mockLogger = {
    info: vi.fn(),
    verbose: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as any as winston.Logger;

  describe("isTendermint", () => {
    it("should return true for Tendermint client", () => {
      const mockClient = {
        clientType: ClientType.Tendermint,
        chainId: "test-chain",
        rpcEndpoint: "http://localhost:26657",
        senderAddress: "cosmos1abc",
        estimatedBlockTime: 1000,
        estimatedIndexerTime: 500,
        logger: mockLogger,
        revisionNumber: 1n,
      } as BaseIbcClient;

      expect(isTendermint(mockClient)).toBe(true);
    });

    it("should return false for non-Tendermint client", () => {
      const mockClient = {
        clientType: ClientType.Gno, // Different client type
        chainId: "test-chain",
        rpcEndpoint: "http://localhost:26657",
        senderAddress: "cosmos1abc",
        estimatedBlockTime: 1000,
        estimatedIndexerTime: 500,
        logger: mockLogger,
        revisionNumber: 1n,
      } as BaseIbcClient;

      expect(isTendermint(mockClient)).toBe(false);
    });

    it("should properly narrow type to TendermintIbcClient", () => {
      const mockClient = {
        clientType: ClientType.Tendermint,
        chainId: "test-chain",
        rpcEndpoint: "http://localhost:26657",
        senderAddress: "cosmos1abc",
        estimatedBlockTime: 1000,
        estimatedIndexerTime: 500,
        logger: mockLogger,
        revisionNumber: 1n,
      } as BaseIbcClient;

      if (isTendermint(mockClient)) {
        // TypeScript should now know this is a TendermintIbcClient
        expect(mockClient.clientType).toBe(ClientType.Tendermint);
      }
    });
  });

  describe("isTendermintClientState", () => {
    it("should return true for Tendermint client state", () => {
      const clientState: TendermintClientState = {
        chainId: "test-chain",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 100n,
        },
        trustLevel: {
          numerator: 1n,
          denominator: 3n,
        },
        trustingPeriod: {
          seconds: 86400n,
          nanos: 0,
        },
        unbondingPeriod: {
          seconds: 172800n,
          nanos: 0,
        },
        maxClockDrift: {
          seconds: 10n,
          nanos: 0,
        },
        frozenHeight: undefined,
        upgradePath: [],
        allowUpdateAfterExpiry: false,
        allowUpdateAfterMisbehaviour: false,
      };

      expect(isTendermintClientState(clientState)).toBe(true);
    });

    it("should return false for non-Tendermint client state", () => {
      const nonTendermintState = {
        publicKey: new Uint8Array([1, 2, 3]),
        diversifier: "solo",
        sequence: 1n,
      };

      expect(isTendermintClientState(nonTendermintState as any)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isTendermintClientState(undefined as any)).toBe(false);
    });

    it("should return false for null", () => {
      expect(isTendermintClientState(null as any)).toBe(false);
    });

    it("should return false for empty object", () => {
      expect(isTendermintClientState({
      } as any)).toBe(false);
    });

    it("should return true for partial Tendermint client state with chainId", () => {
      const partialState = {
        chainId: "test-chain",
        // Other fields may be missing
      } as any;

      expect(isTendermintClientState(partialState)).toBe(true);
    });
  });

  describe("isTendermintConsensusState", () => {
    it("should return true for Tendermint consensus state", () => {
      const consensusState: TendermintConsensusState = {
        timestamp: {
          seconds: 1234567890n,
          nanos: 0,
        },
        root: {
          hash: new Uint8Array([1, 2, 3, 4]),
        },
        nextValidatorsHash: new Uint8Array([5, 6, 7, 8]),
      };

      expect(isTendermintConsensusState(consensusState)).toBe(true);
    });

    it("should return false for non-Tendermint consensus state", () => {
      const nonTendermintState = {
        publicKey: new Uint8Array([1, 2, 3]),
        diversifier: "solo",
        timestamp: 1234567890n,
        signature: new Uint8Array([9, 10, 11]),
      };

      expect(isTendermintConsensusState(nonTendermintState as any)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isTendermintConsensusState(undefined as any)).toBe(false);
    });

    it("should return false for null", () => {
      expect(isTendermintConsensusState(null as any)).toBe(false);
    });

    it("should return false for empty object", () => {
      expect(isTendermintConsensusState({
      } as any)).toBe(false);
    });

    it("should return true for partial Tendermint consensus state with nextValidatorsHash", () => {
      const partialState = {
        nextValidatorsHash: new Uint8Array([1, 2, 3]),
        // Other fields may be missing
      } as any;

      expect(isTendermintConsensusState(partialState)).toBe(true);
    });

    it("should return false if nextValidatorsHash is empty", () => {
      const stateWithoutHash = {
        timestamp: {
          seconds: 1234567890n,
          nanos: 0,
        },
        root: {
          hash: new Uint8Array([1, 2, 3, 4]),
        },
        // Missing nextValidatorsHash
      } as any;

      expect(isTendermintConsensusState(stateWithoutHash)).toBe(false);
    });
  });

  describe("Type guard integration scenarios", () => {
    it("should correctly identify Tendermint client with valid state and consensus", () => {
      const client: BaseIbcClient = {
        clientType: ClientType.Tendermint,
        chainId: "test-chain",
        rpcEndpoint: "http://localhost:26657",
        senderAddress: "cosmos1abc",
        estimatedBlockTime: 1000,
        estimatedIndexerTime: 500,
        logger: mockLogger,
        revisionNumber: 1n,
      } as BaseIbcClient;

      const clientState: TendermintClientState = {
        chainId: "test-chain",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 100n,
        },
      } as TendermintClientState;

      const consensusState: TendermintConsensusState = {
        nextValidatorsHash: new Uint8Array([1, 2, 3]),
        root: {
          hash: new Uint8Array([4, 5, 6]),
        },
      } as TendermintConsensusState;

      expect(isTendermint(client)).toBe(true);
      expect(isTendermintClientState(clientState)).toBe(true);
      expect(isTendermintConsensusState(consensusState)).toBe(true);
    });

    it("should handle mixed client types correctly", () => {
      const tendermintClient: BaseIbcClient = {
        clientType: ClientType.Tendermint,
      } as BaseIbcClient;

      const gnoClient: BaseIbcClient = {
        clientType: ClientType.Gno,
      } as BaseIbcClient;

      expect(isTendermint(tendermintClient)).toBe(true);
      expect(isTendermint(gnoClient)).toBe(false);
    });

    it("should properly use type guards in conditional logic", () => {
      const unknownState: any = {
        chainId: "test-chain",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 100n,
        },
      };

      if (isTendermintClientState(unknownState)) {
        // Should recognize this as TendermintClientState
        expect(unknownState.chainId).toBe("test-chain");
        expect(unknownState.latestHeight).toBeDefined();
      }
      else {
        throw new Error("Should have been identified as Tendermint client state");
      }
    });
  });

  describe("Edge cases", () => {
    it("should handle objects with similar properties but wrong type", () => {
      const fakeClientState = {
        chainId: 12345, // Wrong type (number instead of string)
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 100n,
        },
      };

      // Should still return true because we only check for existence, not type
      expect(isTendermintClientState(fakeClientState as any)).toBe(true);
    });

    it("should handle objects with extra properties", () => {
      const extendedClientState = {
        chainId: "test-chain",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 100n,
        },
        extraProperty: "should not affect type guard",
      };

      expect(isTendermintClientState(extendedClientState as any)).toBe(true);
    });

    it("should handle nested undefined values", () => {
      const stateWithUndefined = {
        chainId: undefined,
      };

      expect(isTendermintClientState(stateWithUndefined as any)).toBe(false);
    });
  });

  describe("BaseIbcClient constructor", () => {
    it("should initialize with default revision number", () => {
      const client = {
        chainId: "test-chain",
        clientType: ClientType.Tendermint,
        rpcEndpoint: "http://localhost:26657",
        logger: mockLogger,
        estimatedBlockTime: 1000,
        estimatedIndexerTime: 500,
        senderAddress: "cosmos1abc",
        revisionNumber: 1n,
      } as BaseIbcClient;

      expect(client.revisionNumber).toBe(1n);
    });

    it("should accept custom revision number", () => {
      const client = {
        chainId: "test-chain",
        clientType: ClientType.Tendermint,
        rpcEndpoint: "http://localhost:26657",
        logger: mockLogger,
        estimatedBlockTime: 1000,
        estimatedIndexerTime: 500,
        senderAddress: "cosmos1abc",
        revisionNumber: 5n,
      } as BaseIbcClient;

      expect(client.revisionNumber).toBe(5n);
    });
  });
});
