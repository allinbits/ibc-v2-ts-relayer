import {
  Order,
  Packet,
  State,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/channel.js";
import {
  Height,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/client.js";
import {
  ClientState as TendermintClientState,
  ConsensusState as TendermintConsensusState,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  beforeEach, describe, expect, it, vi,
} from "vitest";
import * as winston from "winston";

import {
  BaseIbcClient,
} from "../../clients/BaseIbcClient.js";
import {
  TendermintIbcClient,
} from "../../clients/tendermint/IbcClient.js";
import {
  BaseEndpoint,
} from "../../endpoints/BaseEndpoint.js";
import {
  TendermintEndpoint,
} from "../../endpoints/TendermintEndpoint.js";
import {
  ClientType,
  PacketWithMetadata,
} from "../../types/index.js";

// Use spy: true for native ESM mocking
vi.mock("../../utils/utils.js", {
  spy: true,
});

import * as utils from "../../utils/utils.js";
import {
  Link,
  otherSide,
  PacketFilter,
  RelayedHeights,
  Side,
} from "./link.js";

describe("V1 Link", () => {
  let mockClientA: BaseIbcClient;
  let mockClientB: BaseIbcClient;
  let mockEndpointA: BaseEndpoint;
  let mockEndpointB: BaseEndpoint;
  let mockLogger: winston.Logger;
  let link: Link;

  beforeEach(() => {
    vi.clearAllMocks();

    // Spy on and mock the decode functions
    vi.spyOn(utils, "decodeClientState").mockReturnValue({
      chainId: "mock-chain",
      latestHeight: {
        revisionNumber: 1n,
        revisionHeight: 100n,
      },
    } as any);
    vi.spyOn(utils, "decodeConsensusState").mockReturnValue({
      nextValidatorsHash: new Uint8Array(),
      root: {
        hash: new Uint8Array(),
      },
      timestamp: {
        seconds: 0n,
        nanos: 0,
      },
    } as any);
    vi.spyOn(utils, "toIntHeight").mockImplementation((h: Height) => Number(h.revisionHeight));

    mockLogger = {
      info: vi.fn(),
      verbose: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as any;

    // Create mock clients
    mockClientA = {
      chainId: "chain-a",
      clientType: ClientType.Tendermint,
      rpcEndpoint: "http://localhost:26657",
      senderAddress: "cosmos1abc",
      estimatedBlockTime: 1000,
      estimatedIndexerTime: 500,
      logger: mockLogger,
      revisionNumber: 1n,
      getChainId: vi.fn().mockResolvedValue("chain-a"),
      currentHeight: vi.fn().mockResolvedValue(100),
      currentRevision: vi.fn().mockResolvedValue({
        revisionNumber: 1n,
        revisionHeight: 100n,
      }),
      latestHeader: vi.fn().mockResolvedValue({
        height: 100,
        time: new Date(),
      }),
      waitOneBlock: vi.fn().mockResolvedValue(undefined),
      waitForIndexer: vi.fn().mockResolvedValue(undefined),
      getLatestClientState: vi.fn(),
      getConsensusStateAtHeight: vi.fn(),
      getConnection: vi.fn(),
      updateClient: vi.fn(),
      receivePackets: vi.fn(),
      acknowledgePackets: vi.fn(),
      timeoutPackets: vi.fn(),
      queryUnreceivedPackets: vi.fn(),
      queryUnreceivedAcks: vi.fn(),
      queryCommitments: vi.fn(),
      querySentPackets: vi.fn(),
      queryWrittenAcks: vi.fn(),
      getPacketProof: vi.fn(),
      getAckProof: vi.fn(),
      getTimeoutProof: vi.fn(),
      getNextSequenceRecv: vi.fn(),
      currentTime: vi.fn(),
      timeoutHeight: vi.fn(),
      header: vi.fn(),
    } as any;

    mockClientB = {
      chainId: "chain-b",
      clientType: ClientType.Tendermint,
      rpcEndpoint: "http://localhost:26658",
      senderAddress: "cosmos1xyz",
      estimatedBlockTime: 1000,
      estimatedIndexerTime: 500,
      logger: mockLogger,
      revisionNumber: 1n,
      getChainId: vi.fn().mockResolvedValue("chain-b"),
      currentHeight: vi.fn().mockResolvedValue(200),
      currentRevision: vi.fn().mockResolvedValue({
        revisionNumber: 1n,
        revisionHeight: 200n,
      }),
      latestHeader: vi.fn().mockResolvedValue({
        height: 200,
        time: new Date(),
      }),
      waitOneBlock: vi.fn().mockResolvedValue(undefined),
      waitForIndexer: vi.fn().mockResolvedValue(undefined),
      getLatestClientState: vi.fn(),
      getConsensusStateAtHeight: vi.fn(),
      getConnection: vi.fn(),
      updateClient: vi.fn(),
      receivePackets: vi.fn(),
      acknowledgePackets: vi.fn(),
      timeoutPackets: vi.fn(),
      queryUnreceivedPackets: vi.fn(),
      queryUnreceivedAcks: vi.fn(),
      queryCommitments: vi.fn(),
      querySentPackets: vi.fn(),
      queryWrittenAcks: vi.fn(),
      getPacketProof: vi.fn(),
      getAckProof: vi.fn(),
      getTimeoutProof: vi.fn(),
      getNextSequenceRecv: vi.fn(),
      currentTime: vi.fn(),
      timeoutHeight: vi.fn(),
      header: vi.fn(),
    } as any;

    mockEndpointA = new TendermintEndpoint(mockClientA, "client-a", "connection-a");
    mockEndpointB = new TendermintEndpoint(mockClientB, "client-b", "connection-b");

    link = new Link(mockEndpointA, mockEndpointB, mockLogger);
  });

  describe("otherSide", () => {
    it("should return B for A", () => {
      expect(otherSide("A")).toBe("B");
    });

    it("should return A for B", () => {
      expect(otherSide("B")).toBe("A");
    });
  });

  describe("constructor", () => {
    it("should create a link with endpoints", () => {
      expect(link.endA).toBe(mockEndpointA);
      expect(link.endB).toBe(mockEndpointB);
      expect(link.logger).toBe(mockLogger);
    });
  });

  describe("packet filtering", () => {
    it("should set a packet filter", () => {
      const filter: PacketFilter = (packet: Packet) => packet.sequence === 1n;
      link.setFilter(filter);
      // Filter is private, but we can test its effect later
    });

    it("should clear a packet filter", () => {
      const filter: PacketFilter = (packet: Packet) => packet.sequence === 1n;
      link.setFilter(filter);
      link.clearFilter();
      // Filter is private, but we can test its effect later
    });
  });

  describe("createWithExistingConnections", () => {
    it("should create link with valid existing connections", async () => {
      const connection = {
        state: State.STATE_OPEN,
        clientId: "client-a",
        counterparty: {
          clientId: "client-b",
        },
      };

      const connectionB = {
        state: State.STATE_OPEN,
        clientId: "client-b",
        counterparty: {
          clientId: "client-a",
        },
      };

      vi.mocked(mockClientA.getConnection).mockResolvedValue({
        connection,
      });
      vi.mocked(mockClientB.getConnection).mockResolvedValue({
        connection: connectionB,
      });

      const clientState: TendermintClientState = {
        chainId: "chain-b",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 100n,
        },
      } as any;

      const clientStateB: TendermintClientState = {
        chainId: "chain-a",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 200n,
        },
      } as any;

      vi.mocked(mockClientA.getLatestClientState).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
        value: new Uint8Array(),
      });
      vi.mocked(mockClientB.getLatestClientState).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
        value: new Uint8Array(),
      });

      const consensusState: TendermintConsensusState = {
        nextValidatorsHash: new Uint8Array([1, 2, 3]),
        root: {
          hash: new Uint8Array([4, 5, 6]),
        },
      } as any;

      vi.mocked(mockClientA.getConsensusStateAtHeight).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ConsensusState",
        value: new Uint8Array(),
      });
      vi.mocked(mockClientB.getConsensusStateAtHeight).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ConsensusState",
        value: new Uint8Array(),
      });

      vi.mocked(mockClientA.header).mockResolvedValue({
        nextValidatorsHash: new Uint8Array([1, 2, 3]),
        appHash: new Uint8Array([4, 5, 6]),
      } as any);

      vi.mocked(mockClientB.header).mockResolvedValue({
        nextValidatorsHash: new Uint8Array([1, 2, 3]),
        appHash: new Uint8Array([4, 5, 6]),
      } as any);

      // Mock the decode functions - first call returns clientStateA, second returns clientStateB
      vi.mocked(utils.decodeClientState)
        .mockReturnValueOnce(clientState as any) // First call (nodeA.getLatestClientState)
        .mockReturnValueOnce(clientStateB as any) // Second call (nodeB.getLatestClientState)
        .mockReturnValue(clientState as any); // Subsequent calls in assertHeadersMatchConsensusState

      vi.mocked(utils.decodeConsensusState).mockReturnValue(consensusState as any);

      const createdLink = await Link.createWithExistingConnections(
        mockClientA,
        mockClientB,
        "connection-a",
        "connection-b",
        mockLogger,
      );

      expect(createdLink).toBeInstanceOf(Link);
    });

    it("should throw error if connection A not found", async () => {
      vi.mocked(mockClientA.getConnection).mockResolvedValue({
        connection: undefined,
      });
      vi.mocked(mockClientB.getConnection).mockResolvedValue({
        connection: {
          state: State.STATE_OPEN,
        },
      });

      await expect(
        Link.createWithExistingConnections(
          mockClientA,
          mockClientB,
          "connection-a",
          "connection-b",
          mockLogger,
        ),
      ).rejects.toThrow("[chain-a] Connection not found");
    });

    it("should throw error if connection B not found", async () => {
      vi.mocked(mockClientA.getConnection).mockResolvedValue({
        connection: {
          state: State.STATE_OPEN,
        },
      });
      vi.mocked(mockClientB.getConnection).mockResolvedValue({
        connection: undefined,
      });

      await expect(
        Link.createWithExistingConnections(
          mockClientA,
          mockClientB,
          "connection-a",
          "connection-b",
          mockLogger,
        ),
      ).rejects.toThrow("[chain-b] Connection not found");
    });

    it("should throw error if connection state is not OPEN", async () => {
      vi.mocked(mockClientA.getConnection).mockResolvedValue({
        connection: {
          state: State.STATE_INIT,
          counterparty: {
            clientId: "client-b",
          },
        },
      });
      vi.mocked(mockClientB.getConnection).mockResolvedValue({
        connection: {
          state: State.STATE_OPEN,
          counterparty: {
            clientId: "client-a",
          },
        },
      });

      await expect(
        Link.createWithExistingConnections(
          mockClientA,
          mockClientB,
          "connection-a",
          "connection-b",
          mockLogger,
        ),
      ).rejects.toThrow("must be in state open");
    });

    it("should throw error if counterparty client IDs don't match", async () => {
      vi.mocked(mockClientA.getConnection).mockResolvedValue({
        connection: {
          state: State.STATE_OPEN,
          clientId: "client-a",
          counterparty: {
            clientId: "wrong-client",
          },
        },
      });
      vi.mocked(mockClientB.getConnection).mockResolvedValue({
        connection: {
          state: State.STATE_OPEN,
          clientId: "client-b",
          counterparty: {
            clientId: "client-a",
          },
        },
      });

      await expect(
        Link.createWithExistingConnections(
          mockClientA,
          mockClientB,
          "connection-a",
          "connection-b",
          mockLogger,
        ),
      ).rejects.toThrow("does not match counterparty client ID");
    });
  });

  describe("updateClient", () => {
    it("should update client on side B when sender is A", async () => {
      const expectedHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      vi.mocked(mockClientB.updateClient).mockResolvedValue(expectedHeight);

      const result = await link.updateClient("A");

      expect(result).toEqual(expectedHeight);
      expect(mockClientB.updateClient).toHaveBeenCalledWith("client-b", mockClientA);
      expect(mockLogger.info).toHaveBeenCalledWith("Update Client on chain-b");
    });

    it("should update client on side A when sender is B", async () => {
      const expectedHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 200n,
      };
      vi.mocked(mockClientA.updateClient).mockResolvedValue(expectedHeight);

      const result = await link.updateClient("B");

      expect(result).toEqual(expectedHeight);
      expect(mockClientA.updateClient).toHaveBeenCalledWith("client-a", mockClientB);
      expect(mockLogger.info).toHaveBeenCalledWith("Update Client on chain-a");
    });
  });

  describe("updateClientIfStale", () => {
    it("should return null if client is not stale", async () => {
      const recentTime = new Date();
      const consensusState: TendermintConsensusState = {
        timestamp: {
          seconds: BigInt(Math.floor(recentTime.getTime() / 1000)),
          nanos: 0,
        },
        nextValidatorsHash: new Uint8Array(),
      } as any;

      vi.mocked(mockClientB.getConsensusStateAtHeight).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ConsensusState",
        value: new Uint8Array(),
      });

      vi.mocked(mockClientA.latestHeader).mockResolvedValue({
        height: 100,
        time: recentTime,
      } as any);

      vi.mocked(utils.decodeConsensusState).mockReturnValue(consensusState as any);

      const result = await link.updateClientIfStale("A", 10000);

      expect(result).toBeNull();
    });

    it("should update client if client is stale", async () => {
      const oldTime = new Date(Date.now() - 20000000);
      const consensusState: TendermintConsensusState = {
        timestamp: {
          seconds: BigInt(Math.floor(oldTime.getTime() / 1000)),
          nanos: 0,
        },
        nextValidatorsHash: new Uint8Array(),
      } as any;

      vi.mocked(mockClientB.getConsensusStateAtHeight).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ConsensusState",
        value: new Uint8Array(),
      });

      vi.mocked(mockClientA.latestHeader).mockResolvedValue({
        height: 100,
        time: new Date(),
      } as any);

      vi.mocked(utils.decodeConsensusState).mockReturnValue(consensusState as any);

      const expectedHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      vi.mocked(mockClientB.updateClient).mockResolvedValue(expectedHeight);

      const result = await link.updateClientIfStale("A", 1000);

      expect(result).toEqual(expectedHeight);
      expect(mockClientB.updateClient).toHaveBeenCalled();
    });
  });

  describe("updateClientToHeight", () => {
    it("should not update if client already at required height", async () => {
      const clientState: TendermintClientState = {
        chainId: "chain-a",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 150n,
        },
      } as any;

      vi.mocked(mockClientB.getLatestClientState).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
        value: new Uint8Array(),
      });

      vi.mocked(utils.decodeClientState).mockReturnValue(clientState as any);

      const result = await link.updateClientToHeight("A", 100);

      expect(result).toEqual(clientState.latestHeight);
    });

    it("should update client if below required height", async () => {
      const clientState: TendermintClientState = {
        chainId: "chain-a",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 50n,
        },
      } as any;

      vi.mocked(mockClientB.getLatestClientState).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
        value: new Uint8Array(),
      });

      vi.mocked(utils.decodeClientState).mockReturnValue(clientState as any);

      vi.mocked(mockClientA.latestHeader).mockResolvedValue({
        height: 150,
        time: new Date(),
      } as any);

      const expectedHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 150n,
      };
      vi.mocked(mockClientB.updateClient).mockResolvedValue(expectedHeight);

      const result = await link.updateClientToHeight("A", 100);

      expect(result).toEqual(expectedHeight);
      expect(mockClientB.updateClient).toHaveBeenCalled();
    });

    it("should wait one block if current height below min height", async () => {
      const clientState: TendermintClientState = {
        chainId: "chain-a",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 50n,
        },
      } as any;

      vi.mocked(mockClientB.getLatestClientState).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
        value: new Uint8Array(),
      });

      vi.mocked(utils.decodeClientState).mockReturnValue(clientState as any);

      vi.mocked(mockClientA.latestHeader).mockResolvedValue({
        height: 90,
        time: new Date(),
      } as any);

      const expectedHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      vi.mocked(mockClientB.updateClient).mockResolvedValue(expectedHeight);

      const result = await link.updateClientToHeight("A", 100);

      expect(mockClientA.waitOneBlock).toHaveBeenCalled();
      expect(result).toEqual(expectedHeight);
    });
  });

  describe("getPendingPackets", () => {
    it("should return pending packets", async () => {
      const packets: PacketWithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourcePort: "transfer",
            sourceChannel: "channel-0",
            destinationPort: "transfer",
            destinationChannel: "channel-1",
            data: new Uint8Array(),
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

      vi.mocked(mockClientA.querySentPackets).mockResolvedValue(packets);
      vi.mocked(mockClientB.queryUnreceivedPackets).mockResolvedValue([1]);
      vi.mocked(mockClientA.queryCommitments).mockResolvedValue(new Uint8Array());

      const result = await link.getPendingPackets("A");

      expect(result).toHaveLength(1);
      expect(result[0].packet.sequence).toBe(1n);
    });

    it("should filter out already received packets", async () => {
      const packets: PacketWithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourcePort: "transfer",
            sourceChannel: "channel-0",
            destinationPort: "transfer",
            destinationChannel: "channel-1",
            data: new Uint8Array(),
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

      vi.mocked(mockClientA.querySentPackets).mockResolvedValue(packets);
      vi.mocked(mockClientB.queryUnreceivedPackets).mockResolvedValue([]);

      const result = await link.getPendingPackets("A");

      expect(result).toHaveLength(0);
    });

    it("should filter out timed out packets (no commitment)", async () => {
      const packets: PacketWithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourcePort: "transfer",
            sourceChannel: "channel-0",
            destinationPort: "transfer",
            destinationChannel: "channel-1",
            data: new Uint8Array(),
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

      vi.mocked(mockClientA.querySentPackets).mockResolvedValue(packets);
      vi.mocked(mockClientB.queryUnreceivedPackets).mockResolvedValue([1]);
      vi.mocked(mockClientA.queryCommitments).mockRejectedValue(new Error("No commitment"));

      const result = await link.getPendingPackets("A");

      expect(result).toHaveLength(0);
    });
  });

  describe("relayPackets", () => {
    it("should relay packets successfully", async () => {
      const packets: PacketWithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourcePort: "transfer",
            sourceChannel: "channel-0",
            destinationPort: "transfer",
            destinationChannel: "channel-1",
            data: new Uint8Array(),
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

      const clientState: TendermintClientState = {
        chainId: "chain-a",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 150n,
        },
      } as any;

      const headerHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 101n,
      };

      vi.mocked(mockClientB.getLatestClientState).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
        value: new Uint8Array(),
      });

      vi.mocked(utils.decodeClientState).mockReturnValue(clientState as any);
      vi.mocked(mockClientA.getPacketProof).mockResolvedValue({
        proof: new Uint8Array(),
      } as any);
      vi.mocked(mockClientB.receivePackets).mockResolvedValue({
        events: [],
        height: 201,
        transactionHash: "tx-hash",
      } as any);

      const result = await link.relayPackets("A", packets);

      expect(mockClientB.receivePackets).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith("Relay 1 packets from chain-a => chain-b");
    });

    it("should return empty array if no packets to relay", async () => {
      const result = await link.relayPackets("A", []);

      expect(result).toEqual([]);
      expect(mockClientB.receivePackets).not.toHaveBeenCalled();
    });
  });

  describe("relayAcks", () => {
    it("should relay acknowledgements successfully", async () => {
      const acks = [
        {
          originalPacket: {
            sequence: 1n,
            sourcePort: "transfer",
            sourceChannel: "channel-0",
            destinationPort: "transfer",
            destinationChannel: "channel-1",
            data: new Uint8Array(),
            timeoutHeight: {
              revisionNumber: 0n,
              revisionHeight: 0n,
            },
            timeoutTimestamp: 0n,
          },
          acknowledgement: new Uint8Array([1, 2, 3]),
          height: 100,
          txHash: "hash1",
          txEvents: [],
        },
      ];

      const clientState: TendermintClientState = {
        chainId: "chain-a",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 150n,
        },
      } as any;

      const headerHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 101n,
      };

      vi.mocked(mockClientB.getLatestClientState).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
        value: new Uint8Array(),
      });

      vi.mocked(utils.decodeClientState).mockReturnValue(clientState as any);
      vi.mocked(mockClientA.getAckProof).mockResolvedValue({
        proof: new Uint8Array(),
      } as any);
      vi.mocked(mockClientB.acknowledgePackets).mockResolvedValue({
        height: 201,
        transactionHash: "tx-hash",
      } as any);

      const result = await link.relayAcks("A", acks);

      expect(result).toBe(201);
      expect(mockClientB.acknowledgePackets).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith("Relay 1 acks from chain-a => chain-b");
    });

    it("should return null if no acks to relay", async () => {
      const result = await link.relayAcks("A", []);

      expect(result).toBeNull();
      expect(mockClientB.acknowledgePackets).not.toHaveBeenCalled();
    });
  });

  describe("timeoutPackets", () => {
    it("should timeout packets successfully", async () => {
      const packets: PacketWithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourcePort: "transfer",
            sourceChannel: "channel-0",
            destinationPort: "transfer",
            destinationChannel: "channel-1",
            data: new Uint8Array(),
            timeoutHeight: {
              revisionNumber: 1n,
              revisionHeight: 100n,
            },
            timeoutTimestamp: 0n,
          },
          height: 100,
          txHash: "hash1",
          txEvents: [],
        },
      ];

      const headerHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 201n,
      };

      vi.mocked(mockClientA.updateClient).mockResolvedValue(headerHeight);
      vi.mocked(mockClientB.getNextSequenceRecv).mockResolvedValue(1n);
      vi.mocked(mockClientB.getTimeoutProof).mockResolvedValue({
        proof: new Uint8Array(),
      } as any);
      vi.mocked(mockClientA.timeoutPackets).mockResolvedValue({
        height: 101,
        transactionHash: "tx-hash",
      } as any);

      const result = await link.timeoutPackets("A", packets);

      expect(result).toBe(101);
      expect(mockClientB.waitOneBlock).toHaveBeenCalled();
      expect(mockClientA.timeoutPackets).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith("Timeout 1 packets sent from chain-a");
    });

    it("should return null if no packets to timeout", async () => {
      const result = await link.timeoutPackets("A", []);

      expect(result).toBeNull();
      expect(mockClientA.timeoutPackets).not.toHaveBeenCalled();
    });
  });

  describe("relayAll", () => {
    it("should relay all packets and acks", async () => {
      vi.mocked(mockClientA.currentHeight).mockResolvedValue(100);
      vi.mocked(mockClientB.currentHeight).mockResolvedValue(200);
      vi.mocked(mockClientA.querySentPackets).mockResolvedValue([]);
      vi.mocked(mockClientB.querySentPackets).mockResolvedValue([]);
      vi.mocked(mockClientA.queryWrittenAcks).mockResolvedValue([]);
      vi.mocked(mockClientB.queryWrittenAcks).mockResolvedValue([]);
      vi.mocked(mockClientA.currentTime).mockResolvedValue({
        getTime: () => Date.now(),
      } as any);
      vi.mocked(mockClientB.currentTime).mockResolvedValue({
        getTime: () => Date.now(),
      } as any);
      vi.mocked(mockClientA.timeoutHeight).mockResolvedValue({
        revisionNumber: 1n,
        revisionHeight: 300n,
      });
      vi.mocked(mockClientB.timeoutHeight).mockResolvedValue({
        revisionNumber: 1n,
        revisionHeight: 300n,
      });

      const result = await link.relayAll();

      expect(result.packetsFromA).toBe(0);
      expect(result.packetsFromB).toBe(0);
      expect(result.acksFromA).toEqual([]);
      expect(result.acksFromB).toEqual([]);
    });
  });

  describe("checkAndRelayPacketsAndAcks", () => {
    it("should check and relay packets and acks with height tracking", async () => {
      const relayFrom: RelayedHeights = {
        packetHeightA: 90,
        packetHeightB: 190,
        ackHeightA: 95,
        ackHeightB: 195,
      };

      vi.mocked(mockClientA.currentHeight).mockResolvedValue(100);
      vi.mocked(mockClientB.currentHeight).mockResolvedValue(200);
      vi.mocked(mockClientA.querySentPackets).mockResolvedValue([]);
      vi.mocked(mockClientB.querySentPackets).mockResolvedValue([]);
      vi.mocked(mockClientA.queryWrittenAcks).mockResolvedValue([]);
      vi.mocked(mockClientB.queryWrittenAcks).mockResolvedValue([]);
      vi.mocked(mockClientA.currentTime).mockResolvedValue({
        getTime: () => Date.now(),
      } as any);
      vi.mocked(mockClientB.currentTime).mockResolvedValue({
        getTime: () => Date.now(),
      } as any);
      vi.mocked(mockClientA.timeoutHeight).mockResolvedValue({
        revisionNumber: 1n,
        revisionHeight: 300n,
      });
      vi.mocked(mockClientB.timeoutHeight).mockResolvedValue({
        revisionNumber: 1n,
        revisionHeight: 300n,
      });

      const result = await link.checkAndRelayPacketsAndAcks(relayFrom, 100, 60);

      expect(result.packetHeightA).toBe(100);
      expect(result.packetHeightB).toBe(200);
      expect(result.ackHeightA).toBeDefined();
      expect(result.ackHeightB).toBeDefined();
    });
  });
});
