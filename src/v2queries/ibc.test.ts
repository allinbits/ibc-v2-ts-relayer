import {
  QueryNextSequenceSendResponse,
  QueryPacketCommitmentResponse,
  QueryUnreceivedAcksResponse,
  QueryUnreceivedPacketsResponse,
} from "@atomone/cosmos-ibc-types/ibc/core/channel/v2/query.js";
import {
  QueryClientImpl as ChannelV2Query,
} from "@atomone/cosmos-ibc-types/ibc/core/channel/v2/query.js";
import {
  QueryClientImpl as ClientV2Query,
  QueryCounterpartyInfoResponse,
} from "@atomone/cosmos-ibc-types/ibc/core/client/v2/query.js";
import {
  createProtobufRpcClient,
  QueryClient,
} from "@cosmjs/stargate";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  setupIbcV2Extension,
} from "./ibc.js";

vi.mock("@cosmjs/stargate", async () => {
  const actual = await vi.importActual("@cosmjs/stargate");
  return {
    ...actual,
    createProtobufRpcClient: vi.fn(),
  };
});

vi.mock("@atomone/cosmos-ibc-types/ibc/core/channel/v2/query.js", async () => {
  const actual = await vi.importActual("@atomone/cosmos-ibc-types/ibc/core/channel/v2/query.js");
  return {
    ...actual,
    QueryClientImpl: vi.fn(),
  };
});

vi.mock("@atomone/cosmos-ibc-types/ibc/core/client/v2/query.js", async () => {
  const actual = await vi.importActual("@atomone/cosmos-ibc-types/ibc/core/client/v2/query.js");
  return {
    ...actual,
    QueryClientImpl: vi.fn(),
  };
});

describe("v2queries/ibc", () => {
  let mockQueryClient: QueryClient;
  let mockRpc: any;
  let mockChannelV2Query: any;
  let mockClientV2Query: any;

  beforeEach(() => {
    mockRpc = {
      request: vi.fn(),
    };

    mockQueryClient = {
    } as QueryClient;

    (createProtobufRpcClient as any).mockReturnValue(mockRpc);

    // Mock query service implementations
    mockChannelV2Query = {
      PacketCommitment: vi.fn(),
      UnreceivedPackets: vi.fn(),
      UnreceivedAcks: vi.fn(),
      NextSequenceSend: vi.fn(),
    };

    mockClientV2Query = {
      CounterpartyInfo: vi.fn(),
    };

    // Mock as constructor functions using function syntax
    vi.mocked(ChannelV2Query).mockImplementation(function (this: any) {
      return mockChannelV2Query;
    } as any);
    vi.mocked(ClientV2Query).mockImplementation(function (this: any) {
      return mockClientV2Query;
    } as any);
  });

  describe("setupIbcV2Extension", () => {
    it("should create IBC v2 extension with all query methods", () => {
      const extension = setupIbcV2Extension(mockQueryClient);

      expect(extension).toBeDefined();
      expect(extension.ibc).toBeDefined();
      expect(extension.ibc.clientV2).toBeDefined();
      expect(extension.ibc.channelV2).toBeDefined();
    });

    describe("clientV2 queries", () => {
      it("should query counterparty info", async () => {
        const mockResponse: QueryCounterpartyInfoResponse = {
          counterpartyInfo: {
            clientId: "07-tendermint-1",
            merklePrefix: [],
          },
        };
        mockClientV2Query.CounterpartyInfo.mockResolvedValue(mockResponse);

        const extension = setupIbcV2Extension(mockQueryClient);
        const result = await extension.ibc.clientV2.counterparty("07-tendermint-0");

        expect(mockClientV2Query.CounterpartyInfo).toHaveBeenCalledWith({
          clientId: "07-tendermint-0",
        });
        expect(result).toEqual(mockResponse);
      });

      it("should handle counterparty query for different client types", async () => {
        const mockResponse: QueryCounterpartyInfoResponse = {
          counterpartyInfo: {
            clientId: "10-gno-0",
            merklePrefix: [],
          },
        };
        mockClientV2Query.CounterpartyInfo.mockResolvedValue(mockResponse);

        const extension = setupIbcV2Extension(mockQueryClient);
        const result = await extension.ibc.clientV2.counterparty("10-gno-1");

        expect(mockClientV2Query.CounterpartyInfo).toHaveBeenCalledWith({
          clientId: "10-gno-1",
        });
        expect(result.counterpartyInfo.clientId).toBe("10-gno-0");
      });
    });

    describe("channelV2 queries", () => {
      it("should query packet commitment", async () => {
        const mockResponse: QueryPacketCommitmentResponse = {
          commitment: new Uint8Array([1, 2, 3]),
          proof: new Uint8Array(),
          proofHeight: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        mockChannelV2Query.PacketCommitment.mockResolvedValue(mockResponse);

        const extension = setupIbcV2Extension(mockQueryClient);
        const result = await extension.ibc.channelV2.packetCommitment("07-tendermint-0", 1);

        expect(mockChannelV2Query.PacketCommitment).toHaveBeenCalledWith({
          clientId: "07-tendermint-0",
          sequence: 1n,
        });
        expect(result).toEqual(mockResponse);
      });

      it("should query packet commitment with large sequence number", async () => {
        const mockResponse: QueryPacketCommitmentResponse = {
          commitment: new Uint8Array([1, 2, 3]),
          proof: new Uint8Array(),
          proofHeight: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        mockChannelV2Query.PacketCommitment.mockResolvedValue(mockResponse);

        const extension = setupIbcV2Extension(mockQueryClient);
        await extension.ibc.channelV2.packetCommitment("07-tendermint-0", 999999);

        expect(mockChannelV2Query.PacketCommitment).toHaveBeenCalledWith({
          clientId: "07-tendermint-0",
          sequence: 999999n,
        });
      });

      it("should query unreceived packets", async () => {
        const mockResponse: QueryUnreceivedPacketsResponse = {
          sequences: [1n, 3n, 5n],
          height: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        mockChannelV2Query.UnreceivedPackets.mockResolvedValue(mockResponse);

        const extension = setupIbcV2Extension(mockQueryClient);
        const result = await extension.ibc.channelV2.unreceivedPackets(
          "07-tendermint-0",
          [1, 2, 3, 4, 5],
        );

        expect(mockChannelV2Query.UnreceivedPackets).toHaveBeenCalledWith({
          clientId: "07-tendermint-0",
          sequences: [1n, 2n, 3n, 4n, 5n],
        });
        expect(result).toEqual(mockResponse);
      });

      it("should query unreceived packets with empty sequences", async () => {
        const mockResponse: QueryUnreceivedPacketsResponse = {
          sequences: [],
          height: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        mockChannelV2Query.UnreceivedPackets.mockResolvedValue(mockResponse);

        const extension = setupIbcV2Extension(mockQueryClient);
        const result = await extension.ibc.channelV2.unreceivedPackets("07-tendermint-0", []);

        expect(mockChannelV2Query.UnreceivedPackets).toHaveBeenCalledWith({
          clientId: "07-tendermint-0",
          sequences: [],
        });
        expect(result.sequences).toHaveLength(0);
      });

      it("should query unreceived acks", async () => {
        const mockResponse: QueryUnreceivedAcksResponse = {
          sequences: [2n, 4n],
          height: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        mockChannelV2Query.UnreceivedAcks.mockResolvedValue(mockResponse);

        const extension = setupIbcV2Extension(mockQueryClient);
        const result = await extension.ibc.channelV2.unreceivedAcks(
          "07-tendermint-0",
          [1, 2, 3, 4],
        );

        expect(mockChannelV2Query.UnreceivedAcks).toHaveBeenCalledWith({
          clientId: "07-tendermint-0",
          packetAckSequences: [1n, 2n, 3n, 4n],
        });
        expect(result).toEqual(mockResponse);
      });

      it("should query unreceived acks with single sequence", async () => {
        const mockResponse: QueryUnreceivedAcksResponse = {
          sequences: [1n],
          height: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        mockChannelV2Query.UnreceivedAcks.mockResolvedValue(mockResponse);

        const extension = setupIbcV2Extension(mockQueryClient);
        const result = await extension.ibc.channelV2.unreceivedAcks("07-tendermint-0", [1]);

        expect(mockChannelV2Query.UnreceivedAcks).toHaveBeenCalledWith({
          clientId: "07-tendermint-0",
          packetAckSequences: [1n],
        });
        expect(result.sequences).toEqual([1n]);
      });

      it("should query next sequence send", async () => {
        const mockResponse: QueryNextSequenceSendResponse = {
          nextSequenceSend: 42n,
          proof: new Uint8Array(),
          proofHeight: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        mockChannelV2Query.NextSequenceSend.mockResolvedValue(mockResponse);

        const extension = setupIbcV2Extension(mockQueryClient);
        const result = await extension.ibc.channelV2.nextSequenceSend("07-tendermint-0");

        expect(mockChannelV2Query.NextSequenceSend).toHaveBeenCalledWith({
          clientId: "07-tendermint-0",
        });
        expect(result).toEqual(mockResponse);
        expect(result.nextSequenceSend).toBe(42n);
      });

      it("should query next sequence send for different client", async () => {
        const mockResponse: QueryNextSequenceSendResponse = {
          nextSequenceSend: 1n,
          proof: new Uint8Array(),
          proofHeight: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        mockChannelV2Query.NextSequenceSend.mockResolvedValue(mockResponse);

        const extension = setupIbcV2Extension(mockQueryClient);
        const result = await extension.ibc.channelV2.nextSequenceSend("10-gno-0");

        expect(mockChannelV2Query.NextSequenceSend).toHaveBeenCalledWith({
          clientId: "10-gno-0",
        });
        expect(result.nextSequenceSend).toBe(1n);
      });
    });

    describe("number to bigint conversion", () => {
      it("should correctly convert sequence numbers to bigint", async () => {
        mockChannelV2Query.PacketCommitment.mockResolvedValue({
          commitment: new Uint8Array(),
          proof: new Uint8Array(),
          proofHeight: {
            revisionNumber: 0n,
            revisionHeight: 0n,
          },
        });

        const extension = setupIbcV2Extension(mockQueryClient);

        await extension.ibc.channelV2.packetCommitment("client", 0);
        expect(mockChannelV2Query.PacketCommitment).toHaveBeenLastCalledWith({
          clientId: "client",
          sequence: 0n,
        });

        await extension.ibc.channelV2.packetCommitment("client", 1000000);
        expect(mockChannelV2Query.PacketCommitment).toHaveBeenLastCalledWith({
          clientId: "client",
          sequence: 1000000n,
        });
      });

      it("should correctly convert sequence arrays to bigint arrays", async () => {
        mockChannelV2Query.UnreceivedPackets.mockResolvedValue({
          sequences: [],
          height: {
            revisionNumber: 0n,
            revisionHeight: 0n,
          },
        });

        const extension = setupIbcV2Extension(mockQueryClient);

        await extension.ibc.channelV2.unreceivedPackets("client", [1, 100, 1000, 10000]);
        expect(mockChannelV2Query.UnreceivedPackets).toHaveBeenCalledWith({
          clientId: "client",
          sequences: [1n, 100n, 1000n, 10000n],
        });
      });
    });
  });
});
