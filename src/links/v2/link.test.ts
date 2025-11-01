import {
  Packet,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/packet.js";
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
  PacketV2WithMetadata,
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

describe("V2 Link", () => {
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
      getCounterparty: vi.fn(),
      updateClient: vi.fn(),
      receivePacketsV2: vi.fn(),
      acknowledgePacketsV2: vi.fn(),
      timeoutPacketsV2: vi.fn(),
      queryUnreceivedPacketsV2: vi.fn(),
      queryUnreceivedAcksV2: vi.fn(),
      queryCommitmentsV2: vi.fn(),
      querySentPacketsV2: vi.fn(),
      queryWrittenAcksV2: vi.fn(),
      getPacketProofV2: vi.fn(),
      getAckProofV2: vi.fn(),
      getTimeoutProofV2: vi.fn(),
      currentTime: vi.fn(),
      timeoutHeight: vi.fn(),
      header: vi.fn(),
      registerCounterParty: vi.fn(),
      createTendermintClient: vi.fn(),
      buildCreateClientArgs: vi.fn(),
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
      getCounterparty: vi.fn(),
      updateClient: vi.fn(),
      receivePacketsV2: vi.fn(),
      acknowledgePacketsV2: vi.fn(),
      timeoutPacketsV2: vi.fn(),
      queryUnreceivedPacketsV2: vi.fn(),
      queryUnreceivedAcksV2: vi.fn(),
      queryCommitmentsV2: vi.fn(),
      querySentPacketsV2: vi.fn(),
      queryWrittenAcksV2: vi.fn(),
      getPacketProofV2: vi.fn(),
      getAckProofV2: vi.fn(),
      getTimeoutProofV2: vi.fn(),
      currentTime: vi.fn(),
      timeoutHeight: vi.fn(),
      header: vi.fn(),
      registerCounterParty: vi.fn(),
      createTendermintClient: vi.fn(),
      buildCreateClientArgs: vi.fn(),
    } as any;

    // Create V2 endpoints (no connectionID)
    mockEndpointA = new TendermintEndpoint(mockClientA, "client-a");
    mockEndpointB = new TendermintEndpoint(mockClientB, "client-b");

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
    it("should create a v2 link with endpoints", () => {
      expect(link.endA).toBe(mockEndpointA);
      expect(link.endB).toBe(mockEndpointB);
      expect(link.logger).toBe(mockLogger);
      expect(mockEndpointA.version).toBe(2);
      expect(mockEndpointB.version).toBe(2);
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

  describe("createWithNewClientsV2", () => {
    it("should create link with new clients and register counterparties", async () => {
      vi.mocked(mockClientA.buildCreateClientArgs).mockResolvedValue({
        clientState: {
        } as any,
        consensusState: {
        } as any,
      });
      vi.mocked(mockClientB.buildCreateClientArgs).mockResolvedValue({
        clientState: {
        } as any,
        consensusState: {
        } as any,
      });

      vi.mocked(mockClientA.createTendermintClient).mockResolvedValue({
        clientId: "client-a-new",
      } as any);
      vi.mocked(mockClientB.createTendermintClient).mockResolvedValue({
        clientId: "client-b-new",
      } as any);

      vi.mocked(mockClientA.registerCounterParty).mockResolvedValue({
        height: 100,
        transactionHash: "tx-hash",
      } as any);
      vi.mocked(mockClientB.registerCounterParty).mockResolvedValue({
        height: 200,
        transactionHash: "tx-hash",
      } as any);

      const createdLink = await Link.createWithNewClientsV2(
        mockClientA,
        mockClientB,
        mockLogger,
        null,
        null,
      );

      expect(createdLink).toBeInstanceOf(Link);
      expect(mockClientA.registerCounterParty).toHaveBeenCalled();
      expect(mockClientB.registerCounterParty).toHaveBeenCalled();
      expect(mockClientA.waitOneBlock).toHaveBeenCalled();
      expect(mockClientB.waitOneBlock).toHaveBeenCalled();
    });
  });

  describe("createWithExistingClients", () => {
    it("should create link with valid existing clients", async () => {
      vi.mocked(mockClientA.getCounterparty).mockResolvedValue("client-b");
      vi.mocked(mockClientB.getCounterparty).mockResolvedValue("client-a");

      const clientStateA: TendermintClientState = {
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

      // Mock the decode functions - need to track which client we're decoding for
      let decodeCallCount = 0;
      vi.mocked(utils.decodeClientState).mockImplementation((raw) => {
        if (raw.typeUrl.includes("tendermint")) {
          decodeCallCount++;
          // First call is for nodeA (should return clientStateA pointing to chain-b)
          // Second call is for nodeB (should return clientStateB pointing to chain-a)
          return decodeCallCount === 1 ? clientStateA as any : clientStateB as any;
        }
        return clientStateB as any;
      });

      vi.mocked(utils.decodeConsensusState).mockReturnValue(consensusState as any);

      const createdLink = await Link.createWithExistingClients(
        mockClientA,
        mockClientB,
        "client-a",
        "client-b",
        mockLogger,
      );

      expect(createdLink).toBeInstanceOf(Link);
    });

    it("should throw error if counterparty not found on chain A", async () => {
      vi.mocked(mockClientA.getCounterparty).mockResolvedValue("");

      await expect(
        Link.createWithExistingClients(
          mockClientA,
          mockClientB,
          "client-a",
          "client-b",
          mockLogger,
        ),
      ).rejects.toThrow("[chain-a] Counterparty not found");
    });

    it("should throw error if counterparty not found on chain B", async () => {
      vi.mocked(mockClientA.getCounterparty).mockResolvedValue("client-b");
      vi.mocked(mockClientB.getCounterparty).mockResolvedValue("");

      await expect(
        Link.createWithExistingClients(
          mockClientA,
          mockClientB,
          "client-a",
          "client-b",
          mockLogger,
        ),
      ).rejects.toThrow("[chain-b] Counterparty not found");
    });

    it("should throw error if client IDs don't match counterparties", async () => {
      vi.mocked(mockClientA.getCounterparty).mockResolvedValue("wrong-client");
      vi.mocked(mockClientB.getCounterparty).mockResolvedValue("client-a");

      await expect(
        Link.createWithExistingClients(
          mockClientA,
          mockClientB,
          "client-a",
          "client-b",
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

      vi.mocked(utils.decodeConsensusState).mockReturnValue(consensusState as any);

      vi.mocked(mockClientA.latestHeader).mockResolvedValue({
        height: 100,
        time: recentTime,
      } as any);

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

  describe("getPendingPackets", () => {
    it("should return pending V2 packets", async () => {
      const packets: PacketV2WithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourceClient: "client-a",
            destinationClient: "client-b",
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

      vi.mocked(mockClientA.querySentPacketsV2).mockResolvedValue(packets);
      vi.mocked(mockClientB.queryUnreceivedPacketsV2).mockResolvedValue([1]);
      vi.mocked(mockClientA.queryCommitmentsV2).mockResolvedValue(new Uint8Array());

      const result = await link.getPendingPackets("A");

      expect(result).toHaveLength(1);
      expect(result[0].packet.sequence).toBe(1n);
    });

    it("should filter out already received V2 packets", async () => {
      const packets: PacketV2WithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourceClient: "client-a",
            destinationClient: "client-b",
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

      vi.mocked(mockClientA.querySentPacketsV2).mockResolvedValue(packets);
      vi.mocked(mockClientB.queryUnreceivedPacketsV2).mockResolvedValue([]);

      const result = await link.getPendingPackets("A");

      expect(result).toHaveLength(0);
    });

    it("should filter out timed out V2 packets (no commitment)", async () => {
      const packets: PacketV2WithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourceClient: "client-a",
            destinationClient: "client-b",
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

      vi.mocked(mockClientA.querySentPacketsV2).mockResolvedValue(packets);
      vi.mocked(mockClientB.queryUnreceivedPacketsV2).mockResolvedValue([1]);
      vi.mocked(mockClientA.queryCommitmentsV2).mockRejectedValue(new Error("No commitment"));

      const result = await link.getPendingPackets("A");

      expect(result).toHaveLength(0);
    });
  });

  describe("relayPackets", () => {
    it("should relay V2 packets successfully", async () => {
      const packets: PacketV2WithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourceClient: "client-a",
            destinationClient: "client-b",
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

      const headerHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 101n,
      };

      vi.mocked(mockClientB.getLatestClientState).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
        value: new Uint8Array(),
      });

      vi.mocked(mockClientB.updateClient).mockResolvedValue(headerHeight);
      vi.mocked(mockClientA.getPacketProofV2).mockResolvedValue({
        proof: new Uint8Array(),
      } as any);
      vi.mocked(mockClientB.receivePacketsV2).mockResolvedValue({
        events: [],
        height: 201,
        transactionHash: "tx-hash",
      } as any);

      const result = await link.relayPackets("A", packets);

      expect(mockClientB.receivePacketsV2).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith("Relay 1 packets from chain-a => chain-b");
    });

    it("should return empty array if no V2 packets to relay", async () => {
      const result = await link.relayPackets("A", []);

      expect(result).toEqual([]);
      expect(mockClientB.receivePacketsV2).not.toHaveBeenCalled();
    });
  });

  describe("relayAcks", () => {
    it("should relay V2 acknowledgements successfully", async () => {
      const acks = [
        {
          originalPacket: {
            sequence: 1n,
            sourceClient: "client-a",
            destinationClient: "client-b",
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

      const headerHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 101n,
      };

      vi.mocked(mockClientB.getLatestClientState).mockResolvedValue({
        typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
        value: new Uint8Array(),
      });

      vi.mocked(mockClientB.updateClient).mockResolvedValue(headerHeight);
      vi.mocked(mockClientA.getAckProofV2).mockResolvedValue({
        proof: new Uint8Array(),
      } as any);
      vi.mocked(mockClientB.acknowledgePacketsV2).mockResolvedValue({
        height: 201,
        transactionHash: "tx-hash",
      } as any);

      const result = await link.relayAcks("A", acks);

      expect(result).toBe(201);
      expect(mockClientB.acknowledgePacketsV2).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith("Relay 1 acks from chain-a => chain-b");
    });

    it("should return null if no V2 acks to relay", async () => {
      const result = await link.relayAcks("A", []);

      expect(result).toBeNull();
      expect(mockClientB.acknowledgePacketsV2).not.toHaveBeenCalled();
    });
  });

  describe("timeoutPackets", () => {
    it("should timeout V2 packets successfully", async () => {
      const packets: PacketV2WithMetadata[] = [
        {
          packet: {
            sequence: 1n,
            sourceClient: "client-a",
            destinationClient: "client-b",
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
      vi.mocked(mockClientB.getTimeoutProofV2).mockResolvedValue({
        proof: new Uint8Array(),
      } as any);
      vi.mocked(mockClientA.timeoutPacketsV2).mockResolvedValue({
        height: 101,
        transactionHash: "tx-hash",
      } as any);

      const result = await link.timeoutPackets("A", packets);

      expect(result).toBe(101);
      expect(mockClientB.waitOneBlock).toHaveBeenCalled();
      expect(mockClientA.timeoutPacketsV2).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith("Timeout 1 packets sent from chain-a");
    });

    it("should return null if no V2 packets to timeout", async () => {
      const result = await link.timeoutPackets("A", []);

      expect(result).toBeNull();
      expect(mockClientA.timeoutPacketsV2).not.toHaveBeenCalled();
    });
  });

  describe("relayAll", () => {
    it("should relay all V2 packets and acks", async () => {
      vi.mocked(mockClientA.currentHeight).mockResolvedValue(100);
      vi.mocked(mockClientB.currentHeight).mockResolvedValue(200);
      vi.mocked(mockClientA.querySentPacketsV2).mockResolvedValue([]);
      vi.mocked(mockClientB.querySentPacketsV2).mockResolvedValue([]);
      vi.mocked(mockClientA.queryWrittenAcksV2).mockResolvedValue([]);
      vi.mocked(mockClientB.queryWrittenAcksV2).mockResolvedValue([]);
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
    it("should check and relay V2 packets and acks with height tracking", async () => {
      const relayFrom: RelayedHeights = {
        packetHeightA: 90,
        packetHeightB: 190,
        ackHeightA: 95,
        ackHeightB: 195,
      };

      vi.mocked(mockClientA.currentHeight).mockResolvedValue(100);
      vi.mocked(mockClientB.currentHeight).mockResolvedValue(200);
      vi.mocked(mockClientA.querySentPacketsV2).mockResolvedValue([]);
      vi.mocked(mockClientB.querySentPacketsV2).mockResolvedValue([]);
      vi.mocked(mockClientA.queryWrittenAcksV2).mockResolvedValue([]);
      vi.mocked(mockClientB.queryWrittenAcksV2).mockResolvedValue([]);
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

  describe("assertHeadersMatchConsensusState", () => {
    it("should validate headers match consensus state for Tendermint", async () => {
      const clientState: TendermintClientState = {
        chainId: "chain-b",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 100n,
        },
      } as any;

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

      vi.mocked(utils.decodeConsensusState).mockReturnValue(consensusState as any);

      vi.mocked(mockClientB.header).mockResolvedValue({
        nextValidatorsHash: new Uint8Array([1, 2, 3]),
        appHash: new Uint8Array([4, 5, 6]),
      } as any);

      await expect(
        link.assertHeadersMatchConsensusState("A", "client-a", clientState),
      ).resolves.not.toThrow();
    });

    it("should throw error if validator hashes don't match", async () => {
      const clientState: TendermintClientState = {
        chainId: "chain-b",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 100n,
        },
      } as any;

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

      vi.mocked(utils.decodeConsensusState).mockReturnValue(consensusState as any);

      vi.mocked(mockClientB.header).mockResolvedValue({
        nextValidatorsHash: new Uint8Array([7, 8, 9]), // Different hash
        appHash: new Uint8Array([4, 5, 6]),
      } as any);

      await expect(
        link.assertHeadersMatchConsensusState("A", "client-a", clientState),
      ).rejects.toThrow("NextValidatorHash doesn't match ConsensusState");
    });

    it("should throw error if app hashes don't match", async () => {
      const clientState: TendermintClientState = {
        chainId: "chain-b",
        latestHeight: {
          revisionNumber: 1n,
          revisionHeight: 100n,
        },
      } as any;

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

      vi.mocked(utils.decodeConsensusState).mockReturnValue(consensusState as any);

      vi.mocked(mockClientB.header).mockResolvedValue({
        nextValidatorsHash: new Uint8Array([1, 2, 3]),
        appHash: new Uint8Array([10, 11, 12]), // Different hash
      } as any);

      await expect(
        link.assertHeadersMatchConsensusState("A", "client-a", clientState),
      ).rejects.toThrow("AppHash doesn't match ConsensusState");
    });
  });
});
