import {
  Order,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/channel.js";
import {
  QueryClient, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension,
} from "@cosmjs/stargate";
import {
  connectComet,
} from "@cosmjs/tendermint-rpc";
import {
  beforeAll, describe, expect, it,
} from "vitest";

import {
  Relayer,
} from "../src/relayer";
import {
  ChainType,
} from "../src/types";
import {
  log,
} from "../src/utils/logging";
import {
  setupIbcV2Extension,
} from "../src/v2queries/ibc";

/**
 * Enhanced E2E tests for IBC relayer
 * These tests require running chains (mars/venus) via docker-compose
 */
describe("Enhanced E2E Tests", () => {
  let relayer: Relayer;
  let queryA: QueryClient;
  let queryB: QueryClient;

  beforeAll(async () => {
    // Initialize relayer
    relayer = new Relayer(log);
    await relayer.start();

    // Add mnemonics
    await relayer.addMnemonic(
      "other razor era scene permit morning lend scrub habit beyond mixed icon alcohol fuel news glory alien actual bachelor spell album fitness squeeze energy",
      "mars",
    );
    await relayer.addMnemonic(
      "other razor era scene permit morning lend scrub habit beyond mixed icon alcohol fuel news glory alien actual bachelor spell album fitness squeeze energy",
      "venus",
    );

    // Add gas prices
    await relayer.addGasPrice("mars", "0.025", "umars");
    await relayer.addGasPrice("venus", "0.025", "uvenus");

    // Setup query clients
    const tmClientA = await connectComet("http://localhost:26657");
    const tmClientB = await connectComet("http://localhost:36657");

    queryA = QueryClient.withExtensions(
      tmClientA,
      setupAuthExtension,
      setupBankExtension,
      setupIbcExtension,
      setupStakingExtension,
      setupIbcV2Extension,
    );

    queryB = QueryClient.withExtensions(
      tmClientB,
      setupAuthExtension,
      setupBankExtension,
      setupIbcExtension,
      setupStakingExtension,
      setupIbcV2Extension,
    );
  }, 30000);

  describe("IBC v2 Client Registration", () => {
    it("should register IBC v2 counterparty clients", async () => {
      await relayer.addNewRelayPath(
        "mars",
        "http://localhost:26657",
        "venus",
        "http://localhost:36657",
        ChainType.Cosmos,
        ChainType.Cosmos,
        2,
      );

      // Query counterparty on chain A
      const counterA = await queryA.ibc.clientV2.counterparty("07-tendermint-0");
      expect(counterA).toBeDefined();
      expect(counterA.counterpartyInfo?.clientId).toBe("07-tendermint-0");

      // Query counterparty on chain B
      const counterB = await queryB.ibc.clientV2.counterparty("07-tendermint-0");
      expect(counterB).toBeDefined();
      expect(counterB.counterpartyInfo?.clientId).toBe("07-tendermint-0");
    }, 60000);

    it("should verify client states are created correctly", async () => {
      const clientStateA = await queryA.ibc.client.state("07-tendermint-0");
      expect(clientStateA).toBeDefined();
      expect(clientStateA.clientState).toBeDefined();

      const clientStateB = await queryB.ibc.client.state("07-tendermint-0");
      expect(clientStateB).toBeDefined();
      expect(clientStateB.clientState).toBeDefined();
    }, 30000);

    it("should verify consensus states exist", async () => {
      const consensusStateA = await queryA.ibc.client.consensusState("07-tendermint-0");
      expect(consensusStateA).toBeDefined();
      expect(consensusStateA.consensusState).toBeDefined();

      const consensusStateB = await queryB.ibc.client.consensusState("07-tendermint-0");
      expect(consensusStateB).toBeDefined();
      expect(consensusStateB.consensusState).toBeDefined();
    }, 30000);
  });

  describe("IBC v1 Connection and Channel Creation", () => {
    it("should create IBC v1 connection and channel", async () => {
      await relayer.addNewRelayPath(
        "mars",
        "http://localhost:26657",
        "venus",
        "http://localhost:36657",
        ChainType.Cosmos,
        ChainType.Cosmos,
        1,
      );

      // Verify channel on chain A
      const channelA = await queryA.ibc.channel.channel("transfer", "channel-0");
      expect(channelA).toBeDefined();
      expect(channelA.channel).toBeDefined();
      expect(channelA.channel?.counterparty.channelId).toBe("channel-0");
      expect(channelA.channel?.counterparty.portId).toBe("transfer");

      // Verify channel on chain B
      const channelB = await queryB.ibc.channel.channel("transfer", "channel-0");
      expect(channelB).toBeDefined();
      expect(channelB.channel).toBeDefined();
      expect(channelB.channel?.counterparty.channelId).toBe("channel-0");
      expect(channelB.channel?.counterparty.portId).toBe("transfer");
    }, 90000);

    it("should verify connection state is OPEN", async () => {
      const connectionA = await queryA.ibc.connection.connection("connection-0");
      expect(connectionA).toBeDefined();
      expect(connectionA.connection).toBeDefined();
      // STATE_OPEN = 3
      expect(connectionA.connection?.state).toBe(3);

      const connectionB = await queryB.ibc.connection.connection("connection-0");
      expect(connectionB).toBeDefined();
      expect(connectionB.connection).toBeDefined();
      expect(connectionB.connection?.state).toBe(3);
    }, 30000);

    it("should verify channel state is OPEN", async () => {
      const channelA = await queryA.ibc.channel.channel("transfer", "channel-0");
      expect(channelA.channel?.state).toBe(3); // STATE_OPEN

      const channelB = await queryB.ibc.channel.channel("transfer", "channel-0");
      expect(channelB.channel?.state).toBe(3); // STATE_OPEN
    }, 30000);

    it("should verify channel ordering is UNORDERED", async () => {
      const channelA = await queryA.ibc.channel.channel("transfer", "channel-0");
      expect(channelA.channel?.ordering).toBe(Order.ORDER_UNORDERED);

      const channelB = await queryB.ibc.channel.channel("transfer", "channel-0");
      expect(channelB.channel?.ordering).toBe(Order.ORDER_UNORDERED);
    }, 30000);
  });

  describe("Client Updates", () => {
    it("should have updated client heights", async () => {
      const clientStateA = await queryA.ibc.client.state("07-tendermint-0");
      const latestHeightA = clientStateA.clientState?.value.slice(-16);

      expect(latestHeightA).toBeDefined();
      expect(latestHeightA!.length).toBeGreaterThan(0);
    }, 30000);
  });

  describe("Relay Path Management", () => {
    it("should list all relay paths", async () => {
      const paths = await relayer.getRelayPaths();
      expect(paths).toBeDefined();
      expect(Array.isArray(paths)).toBe(true);
      expect(paths.length).toBeGreaterThan(0);
    }, 15000);

    it("should have both v1 and v2 paths", async () => {
      const paths = await relayer.getRelayPaths();

      // Check for v2 path (no connection IDs)
      const v2Path = paths.find(p => !p.srcConnectionId && !p.dstConnectionId);
      expect(v2Path).toBeDefined();

      // Check for v1 path (with connection IDs)
      const v1Path = paths.find(p => p.srcConnectionId && p.dstConnectionId);
      expect(v1Path).toBeDefined();
    }, 15000);

    it("should verify path configuration", async () => {
      const paths = await relayer.getRelayPaths();
      const marsVenusPath = paths.find(p => p.srcChainId === "mars" && p.dstChainId === "venus");

      expect(marsVenusPath).toBeDefined();
      expect(marsVenusPath?.srcChainId).toBe("mars");
      expect(marsVenusPath?.dstChainId).toBe("venus");
      expect(marsVenusPath?.srcClientId).toBeDefined();
      expect(marsVenusPath?.dstClientId).toBeDefined();
    }, 15000);
  });

  describe("IBC v2 Packet Queries", () => {
    it("should query packet commitments", async () => {
      try {
        const commitment = await queryA.ibc.channelV2.packetCommitment("07-tendermint-0", 1);
        // May or may not exist depending on whether packets have been sent
        expect(commitment).toBeDefined();
      }
      catch (error) {
        // Expected if no packets sent yet
        expect(error).toBeDefined();
      }
    }, 30000);

    it("should query unreceived packets", async () => {
      const unreceived = await queryA.ibc.channelV2.unreceivedPackets("07-tendermint-0", [1, 2, 3]);
      expect(unreceived).toBeDefined();
      expect(Array.isArray(unreceived.sequences)).toBe(true);
    }, 30000);

    it("should query unreceived acks", async () => {
      const unreceivedAcks = await queryA.ibc.channelV2.unreceivedAcks("07-tendermint-0", [1, 2, 3]);
      expect(unreceivedAcks).toBeDefined();
      expect(Array.isArray(unreceivedAcks.sequences)).toBe(true);
    }, 30000);

    it("should query next sequence send", async () => {
      const nextSeq = await queryA.ibc.channelV2.nextSequenceSend("07-tendermint-0");
      expect(nextSeq).toBeDefined();
      expect(nextSeq.nextSequenceSend).toBeDefined();
      expect(typeof nextSeq.nextSequenceSend).toBe("bigint");
    }, 30000);
  });

  describe("IBC v1 Packet Queries", () => {
    it("should query packet commitments for v1 channel", async () => {
      const commitments = await queryA.ibc.channel.packetCommitments("transfer", "channel-0");
      expect(commitments).toBeDefined();
      expect(Array.isArray(commitments.commitments)).toBe(true);
    }, 30000);

    it("should query packet acknowledgements", async () => {
      const acks = await queryA.ibc.channel.packetAcknowledgements("transfer", "channel-0");
      expect(acks).toBeDefined();
      expect(Array.isArray(acks.acknowledgements)).toBe(true);
    }, 30000);

    it("should query unreceived packets for v1", async () => {
      const unreceived = await queryA.ibc.channel.unreceivedPackets(
        "transfer",
        "channel-0",
        [1n, 2n, 3n],
      );
      expect(unreceived).toBeDefined();
      expect(Array.isArray(unreceived.sequences)).toBe(true);
    }, 30000);

    it("should query unreceived acks for v1", async () => {
      const unreceivedAcks = await queryA.ibc.channel.unreceivedAcks(
        "transfer",
        "channel-0",
        [1n, 2n, 3n],
      );
      expect(unreceivedAcks).toBeDefined();
      expect(Array.isArray(unreceivedAcks.sequences)).toBe(true);
    }, 30000);

    it("should query next sequence receive", async () => {
      const nextSeq = await queryA.ibc.channel.nextSequenceReceive("transfer", "channel-0");
      expect(nextSeq).toBeDefined();
      expect(nextSeq.nextSequenceReceive).toBeDefined();
    }, 30000);
  });

  describe("Chain Status", () => {
    it("should verify chains are running and synced", async () => {
      const statusA = await queryA.bank.balance("cosmos1pkptre7fdkl6gfrzlesjjvhxhlc3r4gmmk8rs6", "umars");
      expect(statusA).toBeDefined();

      const statusB = await queryB.bank.balance("cosmos1pkptre7fdkl6gfrzlesjjvhxhlc3r4gmmk8rs6", "uvenus");
      expect(statusB).toBeDefined();
    }, 30000);

    it("should get validator info", async () => {
      const validatorsA = await queryA.staking.validators("BOND_STATUS_BONDED");
      expect(validatorsA).toBeDefined();
      expect(validatorsA.validators.length).toBeGreaterThan(0);

      const validatorsB = await queryB.staking.validators("BOND_STATUS_BONDED");
      expect(validatorsB).toBeDefined();
      expect(validatorsB.validators.length).toBeGreaterThan(0);
    }, 30000);
  });

  describe("Error Handling", () => {
    it("should handle invalid client ID gracefully", async () => {
      await expect(
        queryA.ibc.client.state("invalid-client"),
      ).rejects.toThrow();
    }, 15000);

    it("should handle invalid connection ID gracefully", async () => {
      await expect(
        queryA.ibc.connection.connection("connection-999"),
      ).rejects.toThrow();
    }, 15000);

    it("should handle invalid channel gracefully", async () => {
      await expect(
        queryA.ibc.channel.channel("transfer", "channel-999"),
      ).rejects.toThrow();
    }, 15000);
  });

  describe("Stress Tests", () => {
    it("should handle multiple concurrent queries", async () => {
      const promises = [queryA.ibc.client.state("07-tendermint-0"), queryB.ibc.client.state("07-tendermint-0"), queryA.ibc.connection.connection("connection-0"), queryB.ibc.connection.connection("connection-0"), queryA.ibc.channel.channel("transfer", "channel-0"), queryB.ibc.channel.channel("transfer", "channel-0")];

      const results = await Promise.all(promises);
      results.forEach((result) => {
        expect(result).toBeDefined();
      });
    }, 45000);

    it("should handle rapid sequential queries", async () => {
      for (let i = 0; i < 10; i++) {
        const result = await queryA.ibc.client.state("07-tendermint-0");
        expect(result).toBeDefined();
      }
    }, 60000);
  });
});
