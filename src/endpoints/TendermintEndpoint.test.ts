import {
  beforeEach, describe, expect, it, vi,
} from "vitest";

import {
  BaseIbcClient,
} from "../clients/BaseIbcClient.js";
import {
  ClientType,
  PacketV2WithMetadata,
  PacketWithMetadata,
} from "../types/index.js";
import {
  TendermintEndpoint,
} from "./TendermintEndpoint.js";

describe("TendermintEndpoint", () => {
  let mockClient: BaseIbcClient;
  let endpoint: TendermintEndpoint;
  let endpointV2: TendermintEndpoint;

  beforeEach(() => {
    mockClient = {
      chainId: "test-chain",
      clientType: ClientType.Tendermint,
      querySentPackets: vi.fn(),
      querySentPacketsV2: vi.fn(),
      queryWrittenAcks: vi.fn(),
      queryWrittenAcksV2: vi.fn(),
    } as any;

    // V1 endpoint (with connectionID)
    endpoint = new TendermintEndpoint(mockClient, "client-123", "connection-456");

    // V2 endpoint (without connectionID)
    endpointV2 = new TendermintEndpoint(mockClient, "client-789");
  });

  describe("constructor", () => {
    it("should create a V1 endpoint with clientID and connectionID", () => {
      expect(endpoint.client).toBe(mockClient);
      expect(endpoint.clientID).toBe("client-123");
      expect(endpoint.connectionID).toBe("connection-456");
      expect(endpoint.version).toBe(1);
    });

    it("should create a V2 endpoint without connectionID", () => {
      expect(endpointV2.client).toBe(mockClient);
      expect(endpointV2.clientID).toBe("client-789");
      expect(endpointV2.connectionID).toBeUndefined();
      expect(endpointV2.version).toBe(2);
    });
  });

  describe("chainId", () => {
    it("should return the chain ID from the client", () => {
      expect(endpoint.chainId()).toBe("test-chain");
    });
  });

  describe("querySentPackets", () => {
    it("should query V1 sent packets when version is 1", async () => {
      const mockPackets: PacketWithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourcePort: "transfer",
            sourceChannel: "channel-0",
            destinationPort: "transfer",
            destinationChannel: "channel-1",
            data: new Uint8Array([1, 2, 3]),
            timeoutHeight: {
              revisionNumber: 0n,
              revisionHeight: 0n,
            },
            timeoutTimestamp: 0n,
          },
          height: 100,
          txHash: "hash1",
          txEvents: [],
        },
      ];

      vi.mocked(mockClient.querySentPackets).mockResolvedValue(mockPackets);

      const result = await endpoint.querySentPackets(10, 100);

      expect(mockClient.querySentPackets).toHaveBeenCalledWith("connection-456", 10, 100);
      expect(result).toEqual(mockPackets);
    });

    it("should query V2 sent packets when version is 2", async () => {
      const mockPackets: PacketV2WithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourceClient: "client-a",
            destinationClient: "client-b",
            data: new Uint8Array([1, 2, 3]),
            timeoutHeight: {
              revisionNumber: 0n,
              revisionHeight: 0n,
            },
            timeoutTimestamp: 0n,
          },
          height: 100,
          txHash: "hash1",
          txEvents: [],
        },
      ];

      vi.mocked(mockClient.querySentPacketsV2).mockResolvedValue(mockPackets);

      const result = await endpointV2.querySentPackets(10, 100);

      expect(mockClient.querySentPacketsV2).toHaveBeenCalledWith("client-789", 10, 100);
      expect(result).toEqual(mockPackets);
    });

    it("should handle undefined minHeight and maxHeight for V1", async () => {
      vi.mocked(mockClient.querySentPackets).mockResolvedValue([]);

      await endpoint.querySentPackets(undefined, undefined);

      expect(mockClient.querySentPackets).toHaveBeenCalledWith("connection-456", undefined, undefined);
    });

    it("should handle undefined minHeight and maxHeight for V2", async () => {
      vi.mocked(mockClient.querySentPacketsV2).mockResolvedValue([]);

      await endpointV2.querySentPackets(undefined, undefined);

      expect(mockClient.querySentPacketsV2).toHaveBeenCalledWith("client-789", undefined, undefined);
    });
  });

  describe("queryWrittenAcks", () => {
    it("should query V1 written acks when version is 1", async () => {
      const mockAcks = [
        {
          originalPacket: {
            sequence: 1n,
            sourcePort: "transfer",
            sourceChannel: "channel-0",
            destinationPort: "transfer",
            destinationChannel: "channel-1",
            data: new Uint8Array([1, 2, 3]),
            timeoutHeight: {
              revisionNumber: 0n,
              revisionHeight: 0n,
            },
            timeoutTimestamp: 0n,
          },
          acknowledgement: new Uint8Array([4, 5, 6]),
          height: 200,
          txHash: "hash2",
          txEvents: [],
        },
      ];

      vi.mocked(mockClient.queryWrittenAcks).mockResolvedValue(mockAcks);

      const result = await endpoint.queryWrittenAcks(50, 200);

      expect(mockClient.queryWrittenAcks).toHaveBeenCalledWith("connection-456", 50, 200);
      expect(result).toEqual(mockAcks);
    });

    it("should query V2 written acks when version is 2", async () => {
      const mockAcks = [
        {
          originalPacket: {
            sequence: 1n,
            sourceClient: "client-a",
            destinationClient: "client-b",
            data: new Uint8Array([1, 2, 3]),
            timeoutHeight: {
              revisionNumber: 0n,
              revisionHeight: 0n,
            },
            timeoutTimestamp: 0n,
          },
          acknowledgement: new Uint8Array([4, 5, 6]),
          height: 200,
          txHash: "hash2",
          txEvents: [],
        },
      ];

      vi.mocked(mockClient.queryWrittenAcksV2).mockResolvedValue(mockAcks);

      const result = await endpointV2.queryWrittenAcks(50, 200);

      expect(mockClient.queryWrittenAcksV2).toHaveBeenCalledWith("client-789", 50, 200);
      expect(result).toEqual(mockAcks);
    });

    it("should handle undefined minHeight and maxHeight for V1 acks", async () => {
      vi.mocked(mockClient.queryWrittenAcks).mockResolvedValue([]);

      await endpoint.queryWrittenAcks(undefined, undefined);

      expect(mockClient.queryWrittenAcks).toHaveBeenCalledWith("connection-456", undefined, undefined);
    });

    it("should handle undefined minHeight and maxHeight for V2 acks", async () => {
      vi.mocked(mockClient.queryWrittenAcksV2).mockResolvedValue([]);

      await endpointV2.queryWrittenAcks(undefined, undefined);

      expect(mockClient.queryWrittenAcksV2).toHaveBeenCalledWith("client-789", undefined, undefined);
    });
  });

  describe("version detection", () => {
    it("should detect V1 based on presence of connectionID", () => {
      const v1Endpoint = new TendermintEndpoint(mockClient, "client-id", "connection-id");
      expect(v1Endpoint.version).toBe(1);
      expect(v1Endpoint.connectionID).toBe("connection-id");
    });

    it("should detect V2 based on absence of connectionID", () => {
      const v2Endpoint = new TendermintEndpoint(mockClient, "client-id");
      expect(v2Endpoint.version).toBe(2);
      expect(v2Endpoint.connectionID).toBeUndefined();
    });
  });

  describe("integration scenarios", () => {
    it("should correctly route V1 queries with specific height range", async () => {
      vi.mocked(mockClient.querySentPackets).mockResolvedValue([]);
      vi.mocked(mockClient.queryWrittenAcks).mockResolvedValue([]);

      await endpoint.querySentPackets(100, 200);
      await endpoint.queryWrittenAcks(100, 200);

      expect(mockClient.querySentPackets).toHaveBeenCalledWith("connection-456", 100, 200);
      expect(mockClient.queryWrittenAcks).toHaveBeenCalledWith("connection-456", 100, 200);
      expect(mockClient.querySentPacketsV2).not.toHaveBeenCalled();
      expect(mockClient.queryWrittenAcksV2).not.toHaveBeenCalled();
    });

    it("should correctly route V2 queries with specific height range", async () => {
      vi.mocked(mockClient.querySentPacketsV2).mockResolvedValue([]);
      vi.mocked(mockClient.queryWrittenAcksV2).mockResolvedValue([]);

      await endpointV2.querySentPackets(100, 200);
      await endpointV2.queryWrittenAcks(100, 200);

      expect(mockClient.querySentPacketsV2).toHaveBeenCalledWith("client-789", 100, 200);
      expect(mockClient.queryWrittenAcksV2).toHaveBeenCalledWith("client-789", 100, 200);
      expect(mockClient.querySentPackets).not.toHaveBeenCalled();
      expect(mockClient.queryWrittenAcks).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should propagate errors from V1 querySentPackets", async () => {
      const error = new Error("Query failed");
      vi.mocked(mockClient.querySentPackets).mockRejectedValue(error);

      await expect(endpoint.querySentPackets(10, 100)).rejects.toThrow("Query failed");
    });

    it("should propagate errors from V2 querySentPackets", async () => {
      const error = new Error("Query failed");
      vi.mocked(mockClient.querySentPacketsV2).mockRejectedValue(error);

      await expect(endpointV2.querySentPackets(10, 100)).rejects.toThrow("Query failed");
    });

    it("should propagate errors from V1 queryWrittenAcks", async () => {
      const error = new Error("Ack query failed");
      vi.mocked(mockClient.queryWrittenAcks).mockRejectedValue(error);

      await expect(endpoint.queryWrittenAcks(10, 100)).rejects.toThrow("Ack query failed");
    });

    it("should propagate errors from V2 queryWrittenAcks", async () => {
      const error = new Error("Ack query failed");
      vi.mocked(mockClient.queryWrittenAcksV2).mockRejectedValue(error);

      await expect(endpointV2.queryWrittenAcks(10, 100)).rejects.toThrow("Ack query failed");
    });
  });
});
