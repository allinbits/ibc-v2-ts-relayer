import {
  QueryClient,
} from "@cosmjs/stargate";
import {
  beforeEach, describe, expect, it, vi,
} from "vitest";

import {
  IbcV2Extension,
  setupIbcV2Extension,
} from "./ibc.js";

// Mock the Query implementations
const mockCounterpartyInfo = vi.fn();
const mockPacketCommitment = vi.fn();
const mockUnreceivedPackets = vi.fn();
const mockUnreceivedAcks = vi.fn();
const mockNextSequenceSend = vi.fn();

vi.mock("@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/query.js", () => ({
  QueryClientImpl: class MockChannelQueryClientImpl {
    PacketCommitment = mockPacketCommitment;
    UnreceivedPackets = mockUnreceivedPackets;
    UnreceivedAcks = mockUnreceivedAcks;
    NextSequenceSend = mockNextSequenceSend;
    constructor(rpc: any) {}
  },
}));

vi.mock("@atomone/cosmos-ibc-types/build/ibc/core/client/v2/query.js", () => ({
  QueryClientImpl: class MockClientQueryClientImpl {
    CounterpartyInfo = mockCounterpartyInfo;
    constructor(rpc: any) {}
  },
}));

vi.mock("@cosmjs/stargate", () => ({
  createProtobufRpcClient: vi.fn().mockReturnValue({
  }),
}));

describe("IBC V2 Query Extension", () => {
  let mockQueryClient: QueryClient;
  let extension: IbcV2Extension;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create a mock QueryClient
    mockQueryClient = {
      queryVerified: vi.fn(),
      queryUnverified: vi.fn(),
    } as any;

    // Setup the extension
    extension = setupIbcV2Extension(mockQueryClient);
  });

  describe("setupIbcV2Extension", () => {
    it("should create an IBC V2 extension", () => {
      expect(extension).toBeDefined();
      expect(extension.ibc).toBeDefined();
      expect(extension.ibc.clientV2).toBeDefined();
      expect(extension.ibc.channelV2).toBeDefined();
    });

    it("should have all clientV2 methods", () => {
      expect(extension.ibc.clientV2.counterparty).toBeDefined();
      expect(typeof extension.ibc.clientV2.counterparty).toBe("function");
    });

    it("should have all channelV2 methods", () => {
      expect(extension.ibc.channelV2.packetCommitment).toBeDefined();
      expect(extension.ibc.channelV2.unreceivedPackets).toBeDefined();
      expect(extension.ibc.channelV2.unreceivedAcks).toBeDefined();
      expect(extension.ibc.channelV2.nextSequenceSend).toBeDefined();
      expect(typeof extension.ibc.channelV2.packetCommitment).toBe("function");
      expect(typeof extension.ibc.channelV2.unreceivedPackets).toBe("function");
      expect(typeof extension.ibc.channelV2.unreceivedAcks).toBe("function");
      expect(typeof extension.ibc.channelV2.nextSequenceSend).toBe("function");
    });
  });

  describe("clientV2.counterparty", () => {
    it("should query counterparty info for a client", async () => {
      const mockResponse = {
        counterpartyInfo: {
          clientId: "client-b",
        },
      };

      mockCounterpartyInfo.mockResolvedValue(mockResponse);

      const result = await extension.ibc.clientV2.counterparty("client-a");

      expect(mockCounterpartyInfo).toHaveBeenCalledWith({
        clientId: "client-a",
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe("channelV2.packetCommitment", () => {
    it("should query packet commitment", async () => {
      const mockResponse = {
        commitment: new Uint8Array([1, 2, 3]),
      };

      mockPacketCommitment.mockResolvedValue(mockResponse);

      const result = await extension.ibc.channelV2.packetCommitment("client-a", 123);

      expect(mockPacketCommitment).toHaveBeenCalledWith({
        clientId: "client-a",
        sequence: 123n,
      });
      expect(result).toEqual(mockResponse);
    });

    it("should convert number sequence to bigint", async () => {
      mockPacketCommitment.mockResolvedValue({
      });

      await extension.ibc.channelV2.packetCommitment("client-a", 999);

      expect(mockPacketCommitment).toHaveBeenCalledWith({
        clientId: "client-a",
        sequence: 999n,
      });
    });
  });

  describe("channelV2.unreceivedPackets", () => {
    it("should query unreceived packets", async () => {
      const mockResponse = {
        sequences: [1n, 2n, 3n],
      };

      mockUnreceivedPackets.mockResolvedValue(mockResponse);

      const result = await extension.ibc.channelV2.unreceivedPackets("client-a", [1, 2, 3, 4, 5]);

      expect(mockUnreceivedPackets).toHaveBeenCalledWith({
        clientId: "client-a",
        sequences: [1n, 2n, 3n, 4n, 5n],
      });
      expect(result).toEqual(mockResponse);
    });

    it("should handle empty sequences array", async () => {
      mockUnreceivedPackets.mockResolvedValue({
        sequences: [],
      });

      await extension.ibc.channelV2.unreceivedPackets("client-a", []);

      expect(mockUnreceivedPackets).toHaveBeenCalledWith({
        clientId: "client-a",
        sequences: [],
      });
    });

    it("should convert all sequences to bigint", async () => {
      mockUnreceivedPackets.mockResolvedValue({
      });

      await extension.ibc.channelV2.unreceivedPackets("client-a", [10, 20, 30]);

      expect(mockUnreceivedPackets).toHaveBeenCalledWith({
        clientId: "client-a",
        sequences: [10n, 20n, 30n],
      });
    });
  });

  describe("channelV2.unreceivedAcks", () => {
    it("should query unreceived acknowledgements", async () => {
      const mockResponse = {
        sequences: [1n, 3n, 5n],
      };

      mockUnreceivedAcks.mockResolvedValue(mockResponse);

      const result = await extension.ibc.channelV2.unreceivedAcks("client-b", [1, 2, 3, 4, 5]);

      expect(mockUnreceivedAcks).toHaveBeenCalledWith({
        clientId: "client-b",
        packetAckSequences: [1n, 2n, 3n, 4n, 5n],
      });
      expect(result).toEqual(mockResponse);
    });

    it("should handle empty ack sequences array", async () => {
      mockUnreceivedAcks.mockResolvedValue({
        sequences: [],
      });

      await extension.ibc.channelV2.unreceivedAcks("client-b", []);

      expect(mockUnreceivedAcks).toHaveBeenCalledWith({
        clientId: "client-b",
        packetAckSequences: [],
      });
    });

    it("should convert all ack sequences to bigint", async () => {
      mockUnreceivedAcks.mockResolvedValue({
      });

      await extension.ibc.channelV2.unreceivedAcks("client-b", [100, 200, 300]);

      expect(mockUnreceivedAcks).toHaveBeenCalledWith({
        clientId: "client-b",
        packetAckSequences: [100n, 200n, 300n],
      });
    });
  });

  describe("channelV2.nextSequenceSend", () => {
    it("should query next sequence send", async () => {
      const mockResponse = {
        nextSequenceSend: 42n,
      };

      mockNextSequenceSend.mockResolvedValue(mockResponse);

      const result = await extension.ibc.channelV2.nextSequenceSend("client-a");

      expect(mockNextSequenceSend).toHaveBeenCalledWith({
        clientId: "client-a",
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe("Integration scenarios", () => {
    it("should handle multiple queries in sequence", async () => {
      mockPacketCommitment.mockResolvedValue({
        commitment: new Uint8Array([1, 2, 3]),
      });
      mockUnreceivedPackets.mockResolvedValue({
        sequences: [1n, 2n],
      });
      mockNextSequenceSend.mockResolvedValue({
        nextSequenceSend: 10n,
      });

      await extension.ibc.channelV2.packetCommitment("client-a", 1);
      await extension.ibc.channelV2.unreceivedPackets("client-a", [1, 2, 3]);
      await extension.ibc.channelV2.nextSequenceSend("client-a");

      expect(mockPacketCommitment).toHaveBeenCalledTimes(1);
      expect(mockUnreceivedPackets).toHaveBeenCalledTimes(1);
      expect(mockNextSequenceSend).toHaveBeenCalledTimes(1);
    });

    it("should handle queries for different clients", async () => {
      mockCounterpartyInfo.mockResolvedValue({
        counterpartyInfo: {
          clientId: "client-b",
        },
      });
      mockPacketCommitment.mockResolvedValue({
        commitment: new Uint8Array(),
      });

      await extension.ibc.clientV2.counterparty("client-a");
      await extension.ibc.channelV2.packetCommitment("client-b", 1);

      expect(mockCounterpartyInfo).toHaveBeenCalledWith({
        clientId: "client-a",
      });
      expect(mockPacketCommitment).toHaveBeenCalledWith({
        clientId: "client-b",
        sequence: 1n,
      });
    });
  });

  describe("Error handling", () => {
    it("should propagate errors from counterparty query", async () => {
      mockCounterpartyInfo.mockRejectedValue(new Error("Query failed"));

      await expect(
        extension.ibc.clientV2.counterparty("invalid-client"),
      ).rejects.toThrow("Query failed");
    });

    it("should propagate errors from packet commitment query", async () => {
      mockPacketCommitment.mockRejectedValue(new Error("Commitment not found"));

      await expect(
        extension.ibc.channelV2.packetCommitment("client-a", 999),
      ).rejects.toThrow("Commitment not found");
    });

    it("should propagate errors from unreceived packets query", async () => {
      mockUnreceivedPackets.mockRejectedValue(new Error("RPC error"));

      await expect(
        extension.ibc.channelV2.unreceivedPackets("client-a", [1, 2, 3]),
      ).rejects.toThrow("RPC error");
    });
  });

  describe("Type conversions", () => {
    it("should handle large sequence numbers", async () => {
      mockPacketCommitment.mockResolvedValue({
      });

      const largeSequence = 2 ** 53 - 1; // Max safe integer
      await extension.ibc.channelV2.packetCommitment("client-a", largeSequence);

      expect(mockPacketCommitment).toHaveBeenCalledWith({
        clientId: "client-a",
        sequence: BigInt(largeSequence),
      });
    });

    it("should handle array of large sequence numbers", async () => {
      mockUnreceivedPackets.mockResolvedValue({
      });

      const largeSequences = [2 ** 50, 2 ** 51, 2 ** 52];
      await extension.ibc.channelV2.unreceivedPackets("client-a", largeSequences);

      expect(mockUnreceivedPackets).toHaveBeenCalledWith({
        clientId: "client-a",
        sequences: largeSequences.map(s => BigInt(s)),
      });
    });
  });
});
