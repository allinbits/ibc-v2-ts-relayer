import {
  createPagination,
  createProtobufRpcClient,
  QueryClient,
} from "@cosmjs/stargate";
import {
  Any,
} from "cosmjs-types/google/protobuf/any.js";
import {
  QueryClientImpl as TransferQuery,
} from "cosmjs-types/ibc/applications/transfer/v1/query.js";
import {
  QueryClientImpl as ChannelQuery,
} from "cosmjs-types/ibc/core/channel/v1/query.js";
import {
  Height,
} from "cosmjs-types/ibc/core/client/v1/client.js";
import {
  QueryClientImpl as ClientQuery,
} from "cosmjs-types/ibc/core/client/v1/query.js";
import {
  QueryClientImpl as ConnectionQuery,
} from "cosmjs-types/ibc/core/connection/v1/query.js";
import {
  ClientState as TendermintClientState,
  ConsensusState as TendermintConsensusState,
} from "cosmjs-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  setupIbcExtension,
} from "./ibc.js";

vi.mock("@cosmjs/stargate", async () => {
  const actual = await vi.importActual("@cosmjs/stargate");
  return {
    ...actual,
    createProtobufRpcClient: vi.fn(),
  };
});

vi.mock("cosmjs-types/ibc/applications/transfer/v1/query", async () => {
  const actual = await vi.importActual("cosmjs-types/ibc/applications/transfer/v1/query");
  return {
    ...actual,
    QueryClientImpl: vi.fn(),
  };
});

vi.mock("cosmjs-types/ibc/core/channel/v1/query", async () => {
  const actual = await vi.importActual("cosmjs-types/ibc/core/channel/v1/query");
  return {
    ...actual,
    QueryClientImpl: vi.fn(),
  };
});

vi.mock("cosmjs-types/ibc/core/client/v1/query", async () => {
  const actual = await vi.importActual("cosmjs-types/ibc/core/client/v1/query");
  return {
    ...actual,
    QueryClientImpl: vi.fn(),
  };
});

vi.mock("cosmjs-types/ibc/core/connection/v1/query", async () => {
  const actual = await vi.importActual("cosmjs-types/ibc/core/connection/v1/query");
  return {
    ...actual,
    QueryClientImpl: vi.fn(),
  };
});

describe("v1queries/ibc", () => {
  let mockQueryClient: QueryClient;
  let mockRpc: any;
  let mockChannelQuery: any;
  let mockClientQuery: any;
  let mockConnectionQuery: any;
  let mockTransferQuery: any;

  beforeEach(() => {
    mockRpc = {
      request: vi.fn(),
    };

    mockQueryClient = {
    } as QueryClient;

    (createProtobufRpcClient as any).mockReturnValue(mockRpc);

    // Mock query service implementations
    mockChannelQuery = {
      Channel: vi.fn(),
      Channels: vi.fn(),
      ConnectionChannels: vi.fn(),
      ChannelClientState: vi.fn(),
      ChannelConsensusState: vi.fn(),
      PacketCommitment: vi.fn(),
      PacketCommitments: vi.fn(),
      PacketReceipt: vi.fn(),
      PacketAcknowledgement: vi.fn(),
      PacketAcknowledgements: vi.fn(),
      UnreceivedPackets: vi.fn(),
      UnreceivedAcks: vi.fn(),
      NextSequenceReceive: vi.fn(),
    };

    mockClientQuery = {
      ClientState: vi.fn(),
      ClientStates: vi.fn(),
      ConsensusState: vi.fn(),
      ConsensusStates: vi.fn(),
      ClientParams: vi.fn(),
    };

    mockConnectionQuery = {
      Connection: vi.fn(),
      Connections: vi.fn(),
      ClientConnections: vi.fn(),
      ConnectionClientState: vi.fn(),
      ConnectionConsensusState: vi.fn(),
    };

    mockTransferQuery = {
      DenomTrace: vi.fn(),
      DenomTraces: vi.fn(),
      Params: vi.fn(),
    };

    // Mock as constructor functions using function syntax
    vi.mocked(ChannelQuery).mockImplementation(function (this: any) {
      return mockChannelQuery;
    } as any);
    vi.mocked(ClientQuery).mockImplementation(function (this: any) {
      return mockClientQuery;
    } as any);
    vi.mocked(ConnectionQuery).mockImplementation(function (this: any) {
      return mockConnectionQuery;
    } as any);
    vi.mocked(TransferQuery).mockImplementation(function (this: any) {
      return mockTransferQuery;
    } as any);
  });

  describe("setupIbcExtension", () => {
    it("should create IBC extension with all query methods", () => {
      const extension = setupIbcExtension(mockQueryClient);

      expect(extension).toBeDefined();
      expect(extension.ibc).toBeDefined();
      expect(extension.ibc.channel).toBeDefined();
      expect(extension.ibc.client).toBeDefined();
      expect(extension.ibc.connection).toBeDefined();
      expect(extension.ibc.transfer).toBeDefined();
    });

    describe("channel queries", () => {
      it("should query channel", async () => {
        const mockResponse = {
          channel: {
            state: 3,
          },
        };
        mockChannelQuery.Channel.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        const result = await extension.ibc.channel.channel("transfer", "channel-0");

        expect(mockChannelQuery.Channel).toHaveBeenCalledWith({
          portId: "transfer",
          channelId: "channel-0",
        });
        expect(result).toEqual(mockResponse);
      });

      it("should query channels with pagination", async () => {
        const mockResponse = {
          channels: [],
          pagination: {
            nextKey: new Uint8Array(),
          },
        };
        mockChannelQuery.Channels.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        const paginationKey = new Uint8Array([1, 2, 3]);
        await extension.ibc.channel.channels(paginationKey);

        expect(mockChannelQuery.Channels).toHaveBeenCalledWith({
          pagination: createPagination(paginationKey),
        });
      });

      it("should query all channels with pagination", async () => {
        const mockResponse1 = {
          channels: [
            {
              portId: "transfer",
              channelId: "channel-0",
            },
          ],
          pagination: {
            nextKey: new Uint8Array([1]),
          },
          height: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        const mockResponse2 = {
          channels: [
            {
              portId: "transfer",
              channelId: "channel-1",
            },
          ],
          pagination: {
            nextKey: new Uint8Array(),
          },
          height: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };

        mockChannelQuery.Channels
          .mockResolvedValueOnce(mockResponse1)
          .mockResolvedValueOnce(mockResponse2);

        const extension = setupIbcExtension(mockQueryClient);
        const result = await extension.ibc.channel.allChannels();

        expect(mockChannelQuery.Channels).toHaveBeenCalledTimes(2);
        expect(result.channels).toHaveLength(2);
      });

      it("should query connection channels", async () => {
        const mockResponse = {
          channels: [],
        };
        mockChannelQuery.ConnectionChannels.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.channel.connectionChannels("connection-0");

        expect(mockChannelQuery.ConnectionChannels).toHaveBeenCalledWith({
          connection: "connection-0",
          pagination: createPagination(undefined),
        });
      });

      it("should query packet commitment", async () => {
        const mockResponse = {
          commitment: new Uint8Array([1, 2, 3]),
        };
        mockChannelQuery.PacketCommitment.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.channel.packetCommitment("transfer", "channel-0", 1);

        expect(mockChannelQuery.PacketCommitment).toHaveBeenCalled();
      });

      it("should query unreceived packets", async () => {
        const mockResponse = {
          sequences: [1n, 2n, 3n],
        };
        mockChannelQuery.UnreceivedPackets.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.channel.unreceivedPackets("transfer", "channel-0", [1, 2, 3]);

        expect(mockChannelQuery.UnreceivedPackets).toHaveBeenCalledWith({
          portId: "transfer",
          channelId: "channel-0",
          packetCommitmentSequences: [1n, 2n, 3n],
        });
      });

      it("should query unreceived acks", async () => {
        const mockResponse = {
          sequences: [1n, 2n],
        };
        mockChannelQuery.UnreceivedAcks.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.channel.unreceivedAcks("transfer", "channel-0", [1, 2]);

        expect(mockChannelQuery.UnreceivedAcks).toHaveBeenCalledWith({
          portId: "transfer",
          channelId: "channel-0",
          packetAckSequences: [1n, 2n],
        });
      });

      it("should query all packet commitments with pagination", async () => {
        const mockResponse1 = {
          commitments: [
            {
              sequence: 1n,
            },
          ],
          pagination: {
            nextKey: new Uint8Array([1]),
          },
          height: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        const mockResponse2 = {
          commitments: [
            {
              sequence: 2n,
            },
          ],
          pagination: {
            nextKey: new Uint8Array(),
          },
          height: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };

        mockChannelQuery.PacketCommitments
          .mockResolvedValueOnce(mockResponse1)
          .mockResolvedValueOnce(mockResponse2);

        const extension = setupIbcExtension(mockQueryClient);
        const result = await extension.ibc.channel.allPacketCommitments("transfer", "channel-0");

        expect(mockChannelQuery.PacketCommitments).toHaveBeenCalledTimes(2);
        expect(result.commitments).toHaveLength(2);
      });
    });

    describe("client queries", () => {
      it("should query client state", async () => {
        const mockResponse = {
          clientState: Any.fromPartial({
            typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
            value: new Uint8Array(),
          }),
        };
        mockClientQuery.ClientState.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.client.state("07-tendermint-0");

        expect(mockClientQuery.ClientState).toHaveBeenCalledWith({
          clientId: "07-tendermint-0",
        });
      });

      it("should query all client states with pagination", async () => {
        const mockResponse1 = {
          clientStates: [
            {
              clientId: "07-tendermint-0",
            },
          ],
          pagination: {
            nextKey: new Uint8Array([1]),
          },
        };
        const mockResponse2 = {
          clientStates: [
            {
              clientId: "07-tendermint-1",
            },
          ],
          pagination: {
            nextKey: new Uint8Array(),
          },
        };

        mockClientQuery.ClientStates
          .mockResolvedValueOnce(mockResponse1)
          .mockResolvedValueOnce(mockResponse2);

        const extension = setupIbcExtension(mockQueryClient);
        const result = await extension.ibc.client.allStates();

        expect(mockClientQuery.ClientStates).toHaveBeenCalledTimes(2);
        expect(result.clientStates).toHaveLength(2);
      });

      it("should query consensus state with height", async () => {
        const mockResponse = {
          consensusState: Any.fromPartial({
            typeUrl: "/ibc.lightclients.tendermint.v1.ConsensusState",
            value: new Uint8Array(),
          }),
        };
        mockClientQuery.ConsensusState.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        const height = Height.fromPartial({
          revisionNumber: 1n,
          revisionHeight: 100n,
        });
        await extension.ibc.client.consensusState("07-tendermint-0", height);

        expect(mockClientQuery.ConsensusState).toHaveBeenCalled();
      });

      it("should query consensus state without height (latest)", async () => {
        const mockResponse = {
          consensusState: Any.fromPartial({
            typeUrl: "/ibc.lightclients.tendermint.v1.ConsensusState",
            value: new Uint8Array(),
          }),
        };
        mockClientQuery.ConsensusState.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.client.consensusState("07-tendermint-0");

        expect(mockClientQuery.ConsensusState).toHaveBeenCalled();
      });

      it("should query tendermint client state", async () => {
        const clientStateBytes = TendermintClientState.encode(
          TendermintClientState.fromPartial({
            chainId: "test-chain",
          }),
        ).finish();

        const mockResponse = {
          clientState: Any.fromPartial({
            typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
            value: clientStateBytes,
          }),
        };
        mockClientQuery.ClientState.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        const result = await extension.ibc.client.stateTm("07-tendermint-0");

        expect(result.chainId).toBe("test-chain");
      });

      it("should throw error for non-tendermint client state", async () => {
        const mockResponse = {
          clientState: Any.fromPartial({
            typeUrl: "/ibc.lightclients.solomachine.v3.ClientState",
            value: new Uint8Array(),
          }),
        };
        mockClientQuery.ClientState.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);

        await expect(
          extension.ibc.client.stateTm("solomachine-0"),
        ).rejects.toThrow();
      });

      it("should query all tendermint client states with pagination", async () => {
        const clientStateBytes = TendermintClientState.encode(
          TendermintClientState.fromPartial({
            chainId: "test-chain",
          }),
        ).finish();

        const mockResponse1 = {
          clientStates: [
            {
              clientState: Any.fromPartial({
                typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
                value: clientStateBytes,
              }),
            },
          ],
          pagination: {
            nextKey: new Uint8Array([1]),
          },
        };
        const mockResponse2 = {
          clientStates: [
            {
              clientState: Any.fromPartial({
                typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
                value: clientStateBytes,
              }),
            },
          ],
          pagination: {
            nextKey: new Uint8Array(),
          },
        };

        mockClientQuery.ClientStates
          .mockResolvedValueOnce(mockResponse1)
          .mockResolvedValueOnce(mockResponse2);

        const extension = setupIbcExtension(mockQueryClient);
        const result = await extension.ibc.client.allStatesTm();

        expect(mockClientQuery.ClientStates).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(2);
      });

      it("should query tendermint consensus state", async () => {
        const consensusStateBytes = TendermintConsensusState.encode(
          TendermintConsensusState.fromPartial({
            nextValidatorsHash: new Uint8Array([1, 2, 3]),
          }),
        ).finish();

        const mockResponse = {
          consensusState: Any.fromPartial({
            typeUrl: "/ibc.lightclients.tendermint.v1.ConsensusState",
            value: consensusStateBytes,
          }),
        };
        mockClientQuery.ConsensusState.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        const result = await extension.ibc.client.consensusStateTm("07-tendermint-0");

        expect(result.nextValidatorsHash).toEqual(new Uint8Array([1, 2, 3]));
      });
    });

    describe("connection queries", () => {
      it("should query connection", async () => {
        const mockResponse = {
          connection: {
            clientId: "07-tendermint-0",
          },
        };
        mockConnectionQuery.Connection.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.connection.connection("connection-0");

        expect(mockConnectionQuery.Connection).toHaveBeenCalledWith({
          connectionId: "connection-0",
        });
      });

      it("should query all connections with pagination", async () => {
        const mockResponse1 = {
          connections: [
            {
              id: "connection-0",
            },
          ],
          pagination: {
            nextKey: new Uint8Array([1]),
          },
          height: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };
        const mockResponse2 = {
          connections: [
            {
              id: "connection-1",
            },
          ],
          pagination: {
            nextKey: new Uint8Array(),
          },
          height: {
            revisionNumber: 1n,
            revisionHeight: 100n,
          },
        };

        mockConnectionQuery.Connections
          .mockResolvedValueOnce(mockResponse1)
          .mockResolvedValueOnce(mockResponse2);

        const extension = setupIbcExtension(mockQueryClient);
        const result = await extension.ibc.connection.allConnections();

        expect(mockConnectionQuery.Connections).toHaveBeenCalledTimes(2);
        expect(result.connections).toHaveLength(2);
      });

      it("should query client connections", async () => {
        const mockResponse = {
          connectionPaths: ["connection-0", "connection-1"],
        };
        mockConnectionQuery.ClientConnections.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.connection.clientConnections("07-tendermint-0");

        expect(mockConnectionQuery.ClientConnections).toHaveBeenCalledWith({
          clientId: "07-tendermint-0",
        });
      });

      it("should query connection client state", async () => {
        const mockResponse = {
          identifiedClientState: {
            clientId: "07-tendermint-0",
          },
        };
        mockConnectionQuery.ConnectionClientState.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.connection.clientState("connection-0");

        expect(mockConnectionQuery.ConnectionClientState).toHaveBeenCalledWith({
          connectionId: "connection-0",
        });
      });

      it("should query connection consensus state", async () => {
        const mockResponse = {
          consensusState: Any.fromPartial({
            typeUrl: "/ibc.lightclients.tendermint.v1.ConsensusState",
            value: new Uint8Array(),
          }),
        };
        mockConnectionQuery.ConnectionConsensusState.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.connection.consensusState("connection-0", 1, 100);

        expect(mockConnectionQuery.ConnectionConsensusState).toHaveBeenCalled();
      });
    });

    describe("transfer queries", () => {
      it("should query denom trace", async () => {
        const mockResponse = {
          denomTrace: {
            path: "transfer/channel-0",
            baseDenom: "uatom",
          },
        };
        mockTransferQuery.DenomTrace.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.transfer.denomTrace("hash123");

        expect(mockTransferQuery.DenomTrace).toHaveBeenCalledWith({
          hash: "hash123",
        });
      });

      it("should query all denom traces with pagination", async () => {
        const mockResponse1 = {
          denomTraces: [
            {
              path: "transfer/channel-0",
            },
          ],
          pagination: {
            nextKey: new Uint8Array([1]),
          },
        };
        const mockResponse2 = {
          denomTraces: [
            {
              path: "transfer/channel-1",
            },
          ],
          pagination: {
            nextKey: new Uint8Array(),
          },
        };

        mockTransferQuery.DenomTraces
          .mockResolvedValueOnce(mockResponse1)
          .mockResolvedValueOnce(mockResponse2);

        const extension = setupIbcExtension(mockQueryClient);
        const result = await extension.ibc.transfer.allDenomTraces();

        expect(mockTransferQuery.DenomTraces).toHaveBeenCalledTimes(2);
        expect(result.denomTraces).toHaveLength(2);
      });

      it("should query transfer params", async () => {
        const mockResponse = {
          params: {
            sendEnabled: true,
            receiveEnabled: true,
          },
        };
        mockTransferQuery.Params.mockResolvedValue(mockResponse);

        const extension = setupIbcExtension(mockQueryClient);
        await extension.ibc.transfer.params();

        expect(mockTransferQuery.Params).toHaveBeenCalledWith({
        });
      });
    });
  });
});
