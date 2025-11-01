import {
  Packet,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/packet.js";
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
  AckV2,
  AckV2WithMetadata,
  ChannelInfo,
  DataProof,
  MsgResult,
  PacketV2WithMetadata,
} from "../../types/index.js";
import {
  decodeClientState,
  decodeConsensusState,
  parseAcksFromTxEventsV2,
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
 * Link represents a Connection between a pair of blockchains (Nodes) for IBC v2.
 * An initialized Link requires both sides to have a Client for the remote side.
 *
 * Extends BaseLink to inherit common relay logic.
 */
export class Link extends BaseLink<Packet, AckV2, PacketV2WithMetadata, AckV2WithMetadata> {

  // assertHeadersMatchConsensusState moved to BaseLink

  /**
   * createConnection will always create a new pair of clients and a Connection between the
   * two sides
   *
   * @param nodeA
   * @param nodeB
   */
  public static async createWithNewClientsV2(
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
    await Promise.all([nodeA.waitOneBlock(), nodeB.waitOneBlock()]);
    await nodeB.registerCounterParty(clientIdB, clientIdA, Buffer.from("ibc", "utf-8"));
    await nodeA.registerCounterParty(clientIdA, clientIdB, Buffer.from("ibc", "utf-8"));
    const endA = getEndpoint(nodeA, clientIdA);
    const endB = getEndpoint(nodeB, clientIdB);
    return new Link(endA, endB, logger);
  }

  public static async createWithExistingClients(
    nodeA: BaseIbcClient,
    nodeB: BaseIbcClient,
    clientIdA: string,
    clientIdB: string,
    logger: winston.Logger,
  ): Promise<Link> {
    const [chainA, chainB] = [nodeA.chainId, nodeB.chainId];

    const [connectionA, connectionB]
      = await Promise.all([nodeA.getCounterparty(clientIdA), nodeB.getCounterparty(clientIdB)]);

    // The following are the basic checks we do to ensure the clients are valid
    if (!connectionA) {
      throw new Error(`[${chainA}] Counterparty not found for ID ${clientIdA}`);
    }
    if (!connectionB) {
      throw new Error(`[${chainB}] Counterparty not found for ID ${clientIdB}`);
    }

    if (clientIdA !== connectionB) {
      throw new Error(
        `Client ID on [${chainA}] : ${clientIdA} does not match counterparty client ID on [${chainB}] : ${connectionB}`,
      );
    }
    if (clientIdB !== connectionA) {
      throw new Error(
        `Client ID on [${chainB}] : ${clientIdB} does not match counterparty client ID on [${chainA}] : ${connectionA}`,
      );
    }
    // An additional check for clients where client state contains a chain ID e.g. Tendermint
    const [rawClientStateA, rawClientStateB] = await Promise.all([nodeA.getLatestClientState(clientIdA), nodeB.getLatestClientState(clientIdB)]);
    const clientStateA = decodeClientState(rawClientStateA);
    const clientStateB = decodeClientState(rawClientStateB);
    if (isTendermintClientState(clientStateB)) {
      if (nodeA.chainId !== clientStateB.chainId) {
        throw new Error(
          `Chain ID ${nodeA.chainId} for client with ID ${clientIdA} does not match remote chain ID ${clientStateB.chainId}`,
        );
      }
    }
    if (isTendermintClientState(clientStateA)) {
      if (nodeB.chainId !== clientStateA.chainId) {
        throw new Error(
          `Chain ID ${nodeB.chainId} for client with ID ${clientIdB} does not match remote chain ID ${clientStateA.chainId}`,
        );
      }
    }

    /*
     * TODO: add additional checks for different light clients.
     * e.g. solomachine, wasm etc.
     * For now, we only support Tendermint, so we can skip this.
     */
    const endA = getEndpoint(nodeA, clientIdA);
    const endB = getEndpoint(nodeB, clientIdB);
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

  // you can use this if you already have the info out of bounds
  // FIXME: check the validity of that data?
  public constructor(endA: BaseEndpoint, endB: BaseEndpoint, logger: winston.Logger) {
    super(endA, endB, logger);
  }

  // Implement abstract methods from BaseLink

  protected getPacketProof(src: BaseIbcClient, packet: Packet, headerHeight: Height): Promise<DataProof> {
    return src.getPacketProofV2(packet, headerHeight);
  }

  protected getAckProof(src: BaseIbcClient, packet: Packet, headerHeight: Height): Promise<DataProof> {
    return src.getAckProofV2(packet, headerHeight);
  }

  protected getTimeoutProof(dest: BaseIbcClient, packet: Packet, headerHeight: Height): Promise<DataProof> {
    return dest.getTimeoutProofV2(packet, headerHeight);
  }

  protected receivePacketsOnDest(
    dest: BaseIbcClient,
    packets: readonly Packet[],
    proofs: readonly Uint8Array[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    return dest.receivePacketsV2(packets, proofs, proofHeight);
  }

  protected acknowledgePacketsOnSrc(
    dest: BaseIbcClient,
    acks: readonly AckV2[],
    proofs: readonly Uint8Array[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    return dest.acknowledgePacketsV2(acks, proofs, proofHeight);
  }

  protected timeoutPacketsOnSrc(
    src: BaseIbcClient,
    packets: readonly Packet[],
    proofs: readonly Uint8Array[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    return src.timeoutPacketsV2(packets as Packet[], proofs as Uint8Array[], proofHeight);
  }

  protected querySentPackets(endpoint: BaseEndpoint, minHeight?: number, maxHeight?: number): Promise<PacketV2WithMetadata[]> {
    return endpoint.querySentPackets(minHeight, maxHeight) as Promise<PacketV2WithMetadata[]>;
  }

  protected queryWrittenAcks(endpoint: BaseEndpoint, minHeight?: number, maxHeight?: number): Promise<AckV2WithMetadata[]> {
    return endpoint.queryWrittenAcks(minHeight, maxHeight) as Promise<AckV2WithMetadata[]>;
  }

  protected async queryUnreceivedPackets(dest: BaseIbcClient, packets: readonly Packet[]): Promise<number[]> {
    // Group by client
    const grouped = new Map<string, number[]>();
    for (const packet of packets) {
      const key = packet.destinationClient;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(Number(packet.sequence));
    }

    // Query each group
    const results: number[] = [];
    for (const [clientId, sequences] of grouped.entries()) {
      const unreceived = await dest.queryUnreceivedPacketsV2(clientId, sequences);
      results.push(...unreceived);
    }
    return results;
  }

  protected async queryUnreceivedAcks(src: BaseIbcClient, packets: readonly Packet[]): Promise<number[]> {
    // Group by client
    const grouped = new Map<string, number[]>();
    for (const packet of packets) {
      const key = packet.sourceClient;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(Number(packet.sequence));
    }

    // Query each group
    const results: number[] = [];
    for (const [clientId, sequences] of grouped.entries()) {
      const unreceived = await src.queryUnreceivedAcksV2(clientId, sequences);
      results.push(...unreceived);
    }
    return results;
  }

  protected queryCommitments(src: BaseIbcClient, packet: Packet): Promise<Uint8Array> {
    return src.queryCommitmentsV2(packet.sourceClient, packet.sequence);
  }

  protected extractPacket(meta: PacketV2WithMetadata): Packet {
    return meta.packet;
  }

  protected extractAck(meta: AckV2WithMetadata): AckV2 {
    return meta;
  }

  protected extractOriginalPacket(ack: AckV2): Packet {
    return ack.originalPacket;
  }

  protected parseAcksFromEvents(events: readonly Event[]): AckV2[] {
    return parseAcksFromTxEventsV2(events);
  }

  protected splitPendingPackets(
    cutoffHeight: Height,
    cutoffTime: number,
    packets: readonly PacketV2WithMetadata[],
  ): { toSubmit: readonly PacketV2WithMetadata[]; toTimeout: readonly PacketV2WithMetadata[] } {
    return splitPendingPacketsUtil(cutoffHeight, cutoffTime, packets);
  }

  protected getPacketSequence(packet: Packet): bigint {
    return packet.sequence;
  }

  protected createPacketId(packet: Packet): string {
    return `${packet.destinationClient}:${packet.sequence}`;
  }

  protected createAckId(packet: Packet): string {
    return `${packet.sourceClient}:${packet.sequence}`;
  }

  // All relay methods (updateClient, updateClientIfStale, updateClientToHeight,
  // relayAll, checkAndRelayPacketsAndAcks, doCheckAndRelay, getPendingPackets,
  // getPendingAcks, filterUnreceived, relayPackets, relayAcks, timeoutPackets,
  // getEnds) have been moved to BaseLink
}

const idDelim = ":";
const packetId = (packet: Packet) =>
  `${packet.destinationClient}${idDelim}${packet.sequence}`;
const ackId = (packet: Packet) =>
  `${packet.sourceClient}${idDelim}${packet.sequence}`;

export interface EndpointPair {
  readonly src: BaseEndpoint
  readonly dest: BaseEndpoint
}

export interface ChannelPair {
  readonly src: ChannelInfo
  readonly dest: ChannelInfo
}
// getEndpoint and createClients have been moved to ../shared.ts
