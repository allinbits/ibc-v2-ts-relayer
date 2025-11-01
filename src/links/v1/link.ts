/* eslint-disable max-lines */
import {
  Order, Packet, State,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/channel.js";
import {
  Height,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/client.js";
import {
  Event,
} from "@cosmjs/stargate";
import * as winston from "winston";

import {
  BaseIbcClient, isTendermint, isTendermintClientState, isTendermintConsensusState,
} from "../../clients/BaseIbcClient.js";
import {
  BaseEndpoint,
} from "../../endpoints/BaseEndpoint.js";
import {
  Ack,
  AckWithMetadata,
  ChannelInfo,
  DataProof,
  MsgResult,
  PacketWithMetadata,
} from "../../types/index.js";
import {
  decodeClientState,
  decodeConsensusState,
  parseAcksFromTxEvents,
  prepareChannelHandshake,
  prepareConnectionHandshake,
  splitPendingPackets as splitPendingPacketsUtil,
} from "../../utils/utils.js";
import {
  BaseLink,
  RelayedHeights,
  RelayInfo,
} from "../BaseLink.js";
import {
  createClients,
  getEndpoint,
  otherSide,
  Side,
} from "../shared.js";

// Re-export shared types and functions for backward compatibility
export {
  otherSide,
  Side,
} from "../shared.js";

/**
 * PacketFilter is the type for a function that accepts a Packet and returns a boolean defining whether to relay the packet or not
 */
export type PacketFilter = (packet: Packet) => boolean;

// Re-export types from BaseLink for backward compatibility
export type {
  RelayedHeights,
  RelayInfo,
} from "../BaseLink.js";

/**
 * Link represents a Connection between a pair of blockchains (Nodes) for IBC v1.
 * An initialized Link requires both sides to have a Client for the remote side
 * as well as an established Connection using those Clients.
 *
 * Extends BaseLink to inherit common relay logic.
 */
export class Link extends BaseLink<Packet, Ack, PacketWithMetadata, AckWithMetadata> {

  /**
   * findConnection attempts to reuse an existing Client/Connection.
   * If none exists, then it returns an error.
   *
   * @param nodeA
   * @param nodeB
   */
  public static async createWithExistingConnections(
    nodeA: BaseIbcClient,
    nodeB: BaseIbcClient,
    connA: string,
    connB: string,
    logger: winston.Logger,
  ): Promise<Link> {
    const [chainA, chainB] = [nodeA.chainId, nodeB.chainId];

    const [
      {
        connection: connectionA,
      },
      {
        connection: connectionB,
      },
    ]
      = await Promise.all([nodeA.getConnection(connA), nodeB.getConnection(connB)]);

    // The following are the basic checks we do to ensure the connections are valid
    if (!connectionA) {
      throw new Error(`[${chainA}] Connection not found for ID ${connA}`);
    }
    if (!connectionB) {
      throw new Error(`[${chainB}] Connection not found for ID ${connB}`);
    }
    if (!connectionA.counterparty) {
      throw new Error(
        `[${chainA}] Counterparty not found for connection with ID ${connA}`,
      );
    }
    if (!connectionB.counterparty) {
      throw new Error(
        `[${chainB}] Counterparty not found for connection with ID ${connB}`,
      );
    }
    // ensure the connection is open
    if (connectionA.state != State.STATE_OPEN) {
      throw new Error(
        `Connection on ${chainA} must be in state open, it has state ${connectionA.state}`,
      );
    }
    if (connectionB.state != State.STATE_OPEN) {
      throw new Error(
        `Connection on ${chainB} must be in state open, it has state ${connectionB.state}`,
      );
    }

    const [clientIdA, clientIdB] = [connectionA.clientId, connectionB.clientId];
    if (clientIdA !== connectionB.counterparty.clientId) {
      throw new Error(
        `Client ID ${connectionA.clientId} for connection with ID ${connA} does not match counterparty client ID ${connectionB.counterparty.clientId} for connection with ID ${connB}`,
      );
    }
    if (clientIdB !== connectionA.counterparty.clientId) {
      throw new Error(
        `Client ID ${connectionB.clientId} for connection with ID ${connB} does not match counterparty client ID ${connectionA.counterparty.clientId} for connection with ID ${connA}`,
      );
    }
    // An additional check for clients where client state contains a chain ID e.g. Tendermint
    const [rawClientStateA, rawClientStateB] = await Promise.all([nodeA.getLatestClientState(clientIdA), nodeB.getLatestClientState(clientIdB)]);
    const clientStateA = decodeClientState(rawClientStateA);
    const clientStateB = decodeClientState(rawClientStateB);
    if (isTendermintClientState(clientStateB)) {
      if (nodeA.chainId !== clientStateB.chainId) {
        throw new Error(
          `Chain ID ${nodeA.chainId} for connection with ID ${connA} does not match remote chain ID ${clientStateB.chainId}`,
        );
      }
    }
    if (isTendermintClientState(clientStateA)) {
      if (nodeB.chainId !== clientStateA.chainId) {
        throw new Error(
          `Chain ID ${nodeB.chainId} for connection with ID ${connB} does not match remote chain ID ${clientStateA.chainId}`,
        );
      }
    }

    /*
     * TODO: add additional checks for different light clients.
     * e.g. solomachine, wasm etc.
     * For now, we only support Tendermint, so we can skip this.
     */
    const endA = getEndpoint(nodeA, clientIdA, connA);
    const endB = getEndpoint(nodeB, clientIdB, connB);
    const link = new Link(endA, endB, logger);

    await Promise.all([
      link.assertHeadersMatchConsensusState(
        "A", clientIdA, clientStateA,
      ),
      link.assertHeadersMatchConsensusState(
        "B", clientIdB, clientStateB,
      ),
    ]);

    return link;
  }

  // assertHeadersMatchConsensusState moved to BaseLink

  /**
   * createConnection will always create a new pair of clients and a Connection between the
   * two sides
   *
   * @param nodeA
   * @param nodeB
   */
  public static async createWithNewConnections(
    nodeA: BaseIbcClient,
    nodeB: BaseIbcClient,
    logger: winston.Logger,
    // number of seconds the client (on B pointing to A) is valid without update
    trustPeriodA?: number | null,
    // number of seconds the client (on A pointing to B) is valid without update
    trustPeriodB?: number | null,
  ): Promise<Link> {
    const [clientIdA, clientIdB] = await createClients(
      nodeA, nodeB, trustPeriodA, trustPeriodB,
    );

    // wait a block to ensure we have proper proofs for creating a connection (this has failed on CI before)
    await Promise.all([nodeA.waitOneBlock(), nodeB.waitOneBlock()]);

    // connectionInit on nodeA
    const {
      connectionId: connIdA,
    } = await nodeA.connOpenInit(
      clientIdA, clientIdB,
    );

    // connectionTry on nodeB
    const proof = await prepareConnectionHandshake(
      nodeA, nodeB, clientIdA, clientIdB, connIdA,
    );
    const {
      connectionId: connIdB,
    } = await nodeB.connOpenTry(clientIdB, proof);

    // connectionAck on nodeA
    const proofAck = await prepareConnectionHandshake(
      nodeB, nodeA, clientIdB, clientIdA, connIdB,
    );
    await nodeA.connOpenAck(connIdA, proofAck);

    // connectionConfirm on dest
    const proofConfirm = await prepareConnectionHandshake(
      nodeA, nodeB, clientIdA, clientIdB, connIdA,
    );
    await nodeB.connOpenConfirm(connIdB, proofConfirm);

    const endA = getEndpoint(nodeA, clientIdA, connIdA);
    const endB = getEndpoint(nodeB, clientIdB, connIdB);
    return new Link(endA, endB, logger);
  }

  // you can use this if you already have the info out of bounds
  // FIXME: check the validity of that data?
  public constructor(endA: BaseEndpoint, endB: BaseEndpoint, logger: winston.Logger) {
    super(endA, endB, logger);
  }

  // Implement abstract methods from BaseLink

  protected getPacketProof(src: BaseIbcClient, packet: Packet, headerHeight: Height): Promise<DataProof> {
    return src.getPacketProof(packet, headerHeight);
  }

  protected getAckProof(src: BaseIbcClient, packet: Packet, headerHeight: Height): Promise<DataProof> {
    return src.getAckProof(packet, headerHeight);
  }

  protected getTimeoutProof(dest: BaseIbcClient, packet: Packet, headerHeight: Height): Promise<DataProof> {
    return dest.getTimeoutProof(packet, headerHeight);
  }

  protected receivePacketsOnDest(
    dest: BaseIbcClient,
    packets: readonly Packet[],
    proofs: readonly Uint8Array[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    return dest.receivePackets(packets, proofs, proofHeight);
  }

  protected acknowledgePacketsOnSrc(
    dest: BaseIbcClient,
    acks: readonly Ack[],
    proofs: readonly Uint8Array[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    return dest.acknowledgePackets(acks, proofs, proofHeight);
  }

  protected async timeoutPacketsOnSrc(
    src: BaseIbcClient,
    packets: readonly Packet[],
    proofs: readonly Uint8Array[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    const nextSequenceRecv = await Promise.all(
      packets.map(packet => src.getNextSequenceRecv(packet.destinationPort, packet.destinationChannel)),
    );
    return src.timeoutPackets(packets as Packet[], proofs as Uint8Array[], nextSequenceRecv, proofHeight);
  }

  protected querySentPackets(endpoint: BaseEndpoint, minHeight?: number, maxHeight?: number): Promise<PacketWithMetadata[]> {
    return endpoint.querySentPackets(minHeight, maxHeight) as Promise<PacketWithMetadata[]>;
  }

  protected queryWrittenAcks(endpoint: BaseEndpoint, minHeight?: number, maxHeight?: number): Promise<AckWithMetadata[]> {
    return endpoint.queryWrittenAcks(minHeight, maxHeight) as Promise<AckWithMetadata[]>;
  }

  protected async queryUnreceivedPackets(dest: BaseIbcClient, packets: readonly Packet[]): Promise<number[]> {
    // Group by port/channel
    const grouped = new Map<string, number[]>();
    for (const packet of packets) {
      const key = `${packet.destinationPort}:${packet.destinationChannel}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(Number(packet.sequence));
    }

    // Query each group
    const results: number[] = [];
    for (const [key, sequences] of grouped.entries()) {
      const [port, channel] = key.split(":");
      const unreceived = await dest.queryUnreceivedPackets(port, channel, sequences);
      results.push(...unreceived);
    }
    return results;
  }

  protected async queryUnreceivedAcks(src: BaseIbcClient, packets: readonly Packet[]): Promise<number[]> {
    // Group by port/channel
    const grouped = new Map<string, number[]>();
    for (const packet of packets) {
      const key = `${packet.sourcePort}:${packet.sourceChannel}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(Number(packet.sequence));
    }

    // Query each group
    const results: number[] = [];
    for (const [key, sequences] of grouped.entries()) {
      const [port, channel] = key.split(":");
      const unreceived = await src.queryUnreceivedAcks(port, channel, sequences);
      results.push(...unreceived);
    }
    return results;
  }

  protected queryCommitments(src: BaseIbcClient, packet: Packet): Promise<Uint8Array> {
    return src.queryCommitments(packet.sourcePort, packet.sourceChannel, packet.sequence);
  }

  protected extractPacket(meta: PacketWithMetadata): Packet {
    return meta.packet;
  }

  protected extractAck(meta: AckWithMetadata): Ack {
    return meta;
  }

  protected extractOriginalPacket(ack: Ack): Packet {
    return ack.originalPacket;
  }

  protected parseAcksFromEvents(events: readonly Event[]): Ack[] {
    return parseAcksFromTxEvents(events);
  }

  protected splitPendingPackets(
    cutoffHeight: Height,
    cutoffTime: number,
    packets: readonly PacketWithMetadata[],
  ): { toSubmit: readonly PacketWithMetadata[]; toTimeout: readonly PacketWithMetadata[] } {
    return splitPendingPacketsUtil(cutoffHeight, cutoffTime, packets);
  }

  protected getPacketSequence(packet: Packet): bigint {
    return packet.sequence;
  }

  protected createPacketId(packet: Packet): string {
    return `${packet.destinationPort}:${packet.destinationChannel}`;
  }

  protected createAckId(packet: Packet): string {
    return `${packet.sourcePort}:${packet.sourceChannel}`;
  }

  // updateClient, updateClientIfStale, updateClientToHeight moved to BaseLink

  public async createChannel(
    sender: Side,
    srcPort: string,
    destPort: string,
    ordering: Order,
    version: string,
  ): Promise<ChannelPair> {
    this.logger.info(
      `Create channel with sender ${this.chain(
        sender,
      )}: ${srcPort} => ${destPort}`,
    );
    const {
      src, dest,
    } = this.getEnds(sender);
    // init on src
    if (src.version === 1 && dest.version === 1 && src.connectionID && dest.connectionID) {
      const {
        channelId: channelIdSrc,
      } = await src.client.channelOpenInit(
        srcPort, destPort, ordering, src.connectionID, version,
      );

      // try on dest
      const proof = await prepareChannelHandshake(
        src.client, dest.client, dest.clientID, srcPort, channelIdSrc,
      );

      const {
        channelId: channelIdDest,
      } = await dest.client.channelOpenTry(
        destPort, {
          portId: srcPort,
          channelId: channelIdSrc,
        }, ordering, dest.connectionID, version, version, proof,
      );

      // ack on src
      const proofAck = await prepareChannelHandshake(
        dest.client, src.client, src.clientID, destPort, channelIdDest,
      );
      await src.client.channelOpenAck(
        srcPort, channelIdSrc, channelIdDest, version, proofAck,
      );

      // confirm on dest
      const proofConfirm = await prepareChannelHandshake(
        src.client, dest.client, dest.clientID, srcPort, channelIdSrc,
      );
      await dest.client.channelOpenConfirm(destPort, channelIdDest, proofConfirm);

      return {
        src: {
          portId: srcPort,
          channelId: channelIdSrc,
        },
        dest: {
          portId: destPort,
          channelId: channelIdDest,
        },
      };
    }
    else if (src.version === 2 && dest.version === 2) {
      // version 2 channel creation
      throw new Error("Please use v2/Link instead");
    }
    else {
      throw new Error("Invalid clients for channel creation, both sides must be version 1 or version 2");
    }
  }

  // All relay methods (relayAll, checkAndRelayPacketsAndAcks, doCheckAndRelay,
  // getPendingPackets, getPendingAcks, filterUnreceived, relayPackets, relayAcks,
  // timeoutPackets, getEnds) have been moved to BaseLink
}

const idDelim = ":";
const packetId = (packet: Packet) =>
  `${packet.destinationPort}${idDelim}${packet.destinationChannel}`;

const ackId = (packet: Packet) =>
  `${packet.sourcePort}${idDelim}${packet.sourceChannel}`;

export interface EndpointPair {
  readonly src: BaseEndpoint
  readonly dest: BaseEndpoint
}

export interface ChannelPair {
  readonly src: ChannelInfo
  readonly dest: ChannelInfo
}
// getEndpoint and createClients have been moved to ../shared.ts
