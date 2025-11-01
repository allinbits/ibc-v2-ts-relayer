import {
  Height,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/client.js";
import {
  Event,
} from "@cosmjs/stargate";
import {
  isDefined,
} from "@cosmjs/utils";
import * as winston from "winston";

import {
  BaseIbcClient, isTendermint, isTendermintClientState, isTendermintConsensusState,
} from "../clients/BaseIbcClient.js";
import {
  BaseEndpoint,
} from "../endpoints/BaseEndpoint.js";
import {
  DataProof,
  MsgResult,
  QueryOpts,
} from "../types/index.js";
import {
  decodeClientState,
  decodeConsensusState,
  secondsFromDateNanos,
  timestampFromDateNanos,
  toIntHeight,
} from "../utils/utils.js";
import {
  isRetryableError,
  withRetry,
} from "../utils/retry.js";
import {
  otherSide as getOtherSide,
  Side,
} from "./shared.js";

/**
 * Generic metadata for packets across IBC versions.
 */
export interface PacketMetadata<TPacket> {
  packet: TPacket
  height: number
}

/**
 * Generic metadata for acknowledgements across IBC versions.
 */
export interface AckMetadata<TAck> {
  height: number
  txHash: string
  txEvents: readonly any[]
}

/**
 * Records block heights from last successful relay for optimization.
 */
export interface RelayedHeights {
  packetHeightA?: number
  packetHeightB?: number
  ackHeightA?: number
  ackHeightB?: number
}

/**
 * Metadata on a relay round.
 */
export interface RelayInfo<TAck> {
  packetsFromA: number
  packetsFromB: number
  acksFromA: TAck[]
  acksFromB: TAck[]
}

/**
 * Source and destination endpoint pair.
 */
export interface EndpointPair {
  readonly src: BaseEndpoint
  readonly dest: BaseEndpoint
}

/**
 * Base class for IBC Link implementations across protocol versions.
 * Provides common functionality for managing bidirectional IBC connections.
 *
 * @template TPacket - The packet type (Packet for v1, PacketV2 for v2)
 * @template TAck - The acknowledgement type (Ack for v1, AckV2 for v2)
 * @template TPacketWithMeta - Packet with metadata
 * @template TAckWithMeta - Acknowledgement with metadata
 */
export abstract class BaseLink<
  TPacket,
  TAck,
  TPacketWithMeta extends PacketMetadata<TPacket>,
  TAckWithMeta extends AckMetadata<TAck>
> {
  public readonly endA: BaseEndpoint;
  public readonly endB: BaseEndpoint;
  public readonly logger: winston.Logger;

  protected readonly chainA: string;
  protected readonly chainB: string;
  protected packetFilter: ((packet: TPacket) => boolean) | null = null;

  protected constructor(endA: BaseEndpoint, endB: BaseEndpoint, logger: winston.Logger) {
    this.endA = endA;
    this.endB = endB;
    this.logger = logger;
    this.chainA = endA.client.chainId;
    this.chainB = endB.client.chainId;
  }

  protected chain(side: Side): string {
    return side === "A" ? this.chainA : this.chainB;
  }

  protected otherChain(side: Side): string {
    return side === "A" ? this.chainB : this.chainA;
  }

  public setFilter(filter: (packet: TPacket) => boolean): void {
    this.packetFilter = filter;
  }

  public clearFilter(): void {
    this.packetFilter = null;
  }

  protected getEnds(src: Side): EndpointPair {
    if (src === "A") {
      return {
        src: this.endA,
        dest: this.endB,
      };
    }
    else {
      return {
        src: this.endB,
        dest: this.endA,
      };
    }
  }

  /**
   * Writes the latest header from the sender chain to the other endpoint.
   * Uses retry logic to handle transient network failures.
   *
   * @param sender - Which side we get the header/commit from
   * @returns Header height (from sender) that is now known on dest
   * @throws Error if update fails after retries
   *
   * @example
   * ```typescript
   * // Update client on chain B with latest header from chain A
   * const height = await link.updateClient("A");
   * console.log(`Updated to height: ${height.revisionHeight}`);
   * ```
   */
  public async updateClient(sender: Side): Promise<Height> {
    this.logger.info(`Update Client on ${this.otherChain(sender)}`);
    const {
      src, dest,
    } = this.getEnds(sender);

    return withRetry(
      () => dest.client.updateClient(dest.clientID, src.client),
      {
        maxRetries: 3,
        initialBackoff: 1000,
        logger: this.logger,
        shouldRetry: isRetryableError,
      },
    );
  }

  /**
   * Checks if the last proven header on the destination is older than maxAge,
   * and if so, update the client. Uses retry logic for network resilience.
   *
   * @param sender - Which side to update from
   * @param maxAge - Maximum age in seconds before update needed
   * @returns The new client height if updated, null if no update needed
   * @throws Error if client type is unsupported or update fails after retries
   *
   * @example
   * ```typescript
   * // Update if client is older than 24 hours
   * const height = await link.updateClientIfStale("A", 86400);
   * if (height) {
   *   console.log(`Client updated to: ${height.revisionHeight}`);
   * } else {
   *   console.log("Client is still fresh");
   * }
   * ```
   */
  public async updateClientIfStale(
    sender: Side,
    maxAge: number,
  ): Promise<Height | null> {
    this.logger.verbose(
      `Checking if ${this.otherChain(sender)} has recent header of ${this.chain(sender)}`,
    );
    const {
      src, dest,
    } = this.getEnds(sender);

    // The following checks are for Tendermint clients.
    // TODO: Add support for other client types
    if (!isTendermint(src.client)) {
      throw new Error(
        `updateClientIfStale only supported for Tendermint clients, got ${dest.client.clientType}`,
      );
    }

    const rawKnownHeader = await dest.client.getConsensusStateAtHeight(dest.clientID);
    const knownHeader = decodeConsensusState(rawKnownHeader);

    if (!isTendermintConsensusState(knownHeader)) {
      throw new Error(
        `Expected TendermintConsensusState, got ${rawKnownHeader.typeUrl}`,
      );
    }

    const currentHeader = await src.client.latestHeader();

    // Quit now if we don't need to update
    const knownSeconds = Number(knownHeader.timestamp?.seconds);
    if (knownSeconds) {
      const curSeconds = Number(timestampFromDateNanos(currentHeader.time).seconds);
      if (curSeconds - knownSeconds < maxAge) {
        return null;
      }
    }

    // Otherwise, do the update
    return this.updateClient(sender);
  }

  /**
   * Ensures the dest has a proof of at least minHeight from source.
   * Will not execute any tx if not needed.
   * Will wait a block if needed until the header is available.
   *
   * @param source - Which side to update from
   * @param minHeight - Minimum height needed
   * @returns The latest header height now available on dest
   */
  public async updateClientToHeight(
    source: Side,
    minHeight: number,
  ): Promise<Height> {
    this.logger.info(
      `Check whether client on ${this.otherChain(source)} >= height ${minHeight}`,
    );
    const {
      src, dest,
    } = this.getEnds(source);

    // The following checks are for Tendermint clients.
    // TODO: Add support for other client types
    if (!isTendermint(src.client)) {
      throw new Error(
        `updateClientToHeight only supported for Tendermint clients, got ${src.client.clientType}`,
      );
    }

    const rawClientState = await dest.client.getLatestClientState(dest.clientID);
    const clientState = decodeClientState(rawClientState);

    if (!isTendermintClientState(clientState)) {
      throw new Error(
        `Expected TendermintClientState, got ${rawClientState.typeUrl}`,
      );
    }

    // TODO: revisit where revision number comes from - this must be the number from the source chain
    const knownHeight = Number(clientState.latestHeight?.revisionHeight ?? 0);
    if (knownHeight >= minHeight && clientState.latestHeight !== undefined) {
      return clientState.latestHeight;
    }

    const curHeight = (await src.client.latestHeader()).height;
    if (curHeight < minHeight) {
      await src.client.waitOneBlock();
    }
    return this.updateClient(source);
  }

  /**
   * Validates that headers match the consensus state.
   * Can be used to detect double-signing evidence.
   *
   * @param proofSide - The side holding the consensus proof
   * @param clientId - Client ID to validate
   * @param clientState - Client state to validate against
   */
  public async assertHeadersMatchConsensusState(
    proofSide: Side,
    clientId: string,
    clientState: ReturnType<typeof decodeClientState>,
  ): Promise<void> {
    const {
      src, dest,
    } = this.getEnds(proofSide);

    // The following is for a Tendermint client.
    // TODO: add support for other client types
    if (isTendermintClientState(clientState) && isTendermint(dest.client)) {
      const height = clientState.latestHeight;

      // Check headers match consensus state (at least validators)
      const [rawConsensusState, header] = await Promise.all([
        src.client.getConsensusStateAtHeight(clientId, height),
        dest.client.header(toIntHeight(height)),
      ]);

      const consensusState = decodeConsensusState(rawConsensusState);

      if (isTendermintConsensusState(consensusState)) {
        // Ensure consensus and headers match for next validator hashes
        if (!this.arrayContentEquals(consensusState.nextValidatorsHash, header.nextValidatorsHash)) {
          throw new Error("NextValidatorHash doesn't match ConsensusState.");
        }

        // Ensure the committed apphash matches the actual node we have
        const hash = consensusState.root?.hash;
        if (!hash) {
          throw new Error("ConsensusState.root.hash missing.");
        }
        if (!this.arrayContentEquals(hash, header.appHash)) {
          throw new Error("AppHash doesn't match ConsensusState.");
        }
      }
    }
  }

  /**
   * Helper to compare Uint8Array contents.
   * @param a - First array
   * @param b - Second array
   * @returns true if arrays have same content
   */
  private arrayContentEquals(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  // Abstract methods to be implemented by version-specific subclasses

  /**
   * Get packet proof for a specific packet.
   * @param src - Source client
   * @param packet - The packet to get proof for
   * @param headerHeight - The header height for the proof
   * @returns Data proof
   */
  protected abstract getPacketProof(
    src: BaseIbcClient,
    packet: TPacket,
    headerHeight: Height
  ): Promise<DataProof>;

  /**
   * Get acknowledgement proof for a specific packet.
   * @param src - Source client (where ack was written)
   * @param packet - The original packet
   * @param headerHeight - The header height for the proof
   * @returns Data proof
   */
  protected abstract getAckProof(
    src: BaseIbcClient,
    packet: TPacket,
    headerHeight: Height
  ): Promise<DataProof>;

  /**
   * Get timeout proof for a specific packet.
   * @param dest - Destination client
   * @param packet - The packet to get timeout proof for
   * @param headerHeight - The header height for the proof
   * @returns Data proof
   */
  protected abstract getTimeoutProof(
    dest: BaseIbcClient,
    packet: TPacket,
    headerHeight: Height
  ): Promise<DataProof>;

  /**
   * Receive packets on the destination chain.
   */
  protected abstract receivePacketsOnDest(
    dest: BaseIbcClient,
    packets: readonly TPacket[],
    proofs: readonly Uint8Array[],
    proofHeight: Height
  ): Promise<MsgResult>;

  /**
   * Acknowledge packets on the source chain.
   */
  protected abstract acknowledgePacketsOnSrc(
    src: BaseIbcClient,
    acks: readonly TAck[],
    proofs: readonly Uint8Array[],
    proofHeight: Height
  ): Promise<MsgResult>;

  /**
   * Timeout packets on the source chain.
   */
  protected abstract timeoutPacketsOnSrc(
    src: BaseIbcClient,
    packets: readonly TPacket[],
    proofs: readonly Uint8Array[],
    proofHeight: Height
  ): Promise<MsgResult>;

  /**
   * Query sent packets from an endpoint.
   */
  protected abstract querySentPackets(
    endpoint: BaseEndpoint,
    minHeight?: number,
    maxHeight?: number
  ): Promise<TPacketWithMeta[]>;

  /**
   * Query written acknowledgements from an endpoint.
   */
  protected abstract queryWrittenAcks(
    endpoint: BaseEndpoint,
    minHeight?: number,
    maxHeight?: number
  ): Promise<TAckWithMeta[]>;

  /**
   * Query unreceived packets on destination.
   */
  protected abstract queryUnreceivedPackets(
    dest: BaseIbcClient,
    packets: readonly TPacket[]
  ): Promise<number[]>;

  /**
   * Query unreceived acks on source.
   */
  protected abstract queryUnreceivedAcks(
    src: BaseIbcClient,
    packets: readonly TPacket[]
  ): Promise<number[]>;

  /**
   * Query commitments to check if packet still valid.
   */
  protected abstract queryCommitments(
    src: BaseIbcClient,
    packet: TPacket
  ): Promise<Uint8Array>;

  /**
   * Extract packet from metadata wrapper.
   */
  protected abstract extractPacket(meta: TPacketWithMeta): TPacket;

  /**
   * Extract acknowledgement from metadata wrapper.
   */
  protected abstract extractAck(meta: TAckWithMeta): TAck;

  /**
   * Extract original packet from acknowledgement.
   */
  protected abstract extractOriginalPacket(ack: TAck): TPacket;

  /**
   * Parse acknowledgements from transaction events.
   */
  protected abstract parseAcksFromEvents(events: readonly Event[]): TAck[];

  /**
   * Split packets into those to submit vs timeout based on cutoff criteria.
   */
  protected abstract splitPendingPackets(
    cutoffHeight: Height,
    cutoffTime: number,
    packets: readonly TPacketWithMeta[]
  ): { toSubmit: readonly TPacketWithMeta[]; toTimeout: readonly TPacketWithMeta[] };

  /**
   * Get packet sequence number.
   */
  protected abstract getPacketSequence(packet: TPacket): bigint;

  /**
   * Create packet ID for grouping (port:channel for v1, client:seq for v2).
   */
  protected abstract createPacketId(packet: TPacket): string;

  /**
   * Create ack ID for grouping.
   */
  protected abstract createAckId(packet: TPacket): string;

  /**
   * Relay packets from source to destination side.
   * Handles client updates, proof generation, and packet submission with retry logic.
   *
   * @param source - Which side is sending the packets
   * @param packets - Packets with metadata to relay
   * @returns Acknowledgements generated by the relay
   * @throws Error if relay fails after retries
   *
   * @example
   * ```typescript
   * const pendingPackets = await link.getPendingPackets("A");
   * const acks = await link.relayPackets("A", pendingPackets);
   * console.log(`Relayed ${acks.length} packets, got ${acks.length} acks`);
   * ```
   */
  public async relayPackets(
    source: Side,
    packets: readonly TPacketWithMeta[],
  ): Promise<TAckWithMeta[]> {
    this.logger.info(
      `Relay ${packets.length} packets from ${this.chain(source)} => ${this.otherChain(source)}`,
    );
    if (packets.length === 0) {
      return [];
    }

    const {
      src, dest,
    } = this.getEnds(source);

    // Check if we need to update client at all
    const neededHeight = Math.max(...packets.map(x => x.height)) + 1;
    const headerHeight = await this.updateClientToHeight(source, neededHeight);

    const submit = packets.map(meta => this.extractPacket(meta));
    const proofs = await Promise.all(
      submit.map(packet => this.getPacketProof(src.client, packet, headerHeight)),
    );

    // Submit with retry logic for network resilience
    const {
      events, height, transactionHash,
    } = await withRetry(
      () => this.receivePacketsOnDest(
        dest.client,
        submit,
        proofs.map(proof => proof.proof),
        headerHeight,
      ),
      {
        maxRetries: 3,
        initialBackoff: 1000,
        logger: this.logger,
        shouldRetry: isRetryableError,
      },
    );

    const acks = this.parseAcksFromEvents(events);
    return acks.map(ack => ({
      height,
      txHash: transactionHash,
      txEvents: events,
      ...ack,
    } as any)) as TAckWithMeta[];
  }

  /**
   * Relay acknowledgements from source to destination side.
   * Uses retry logic to handle transient network failures.
   *
   * @param source - Which side has written the acknowledgements
   * @param acks - Acknowledgements with metadata to relay
   * @returns Block height where acks were included, or null if no acks sent
   * @throws Error if relay fails after retries
   *
   * @example
   * ```typescript
   * const pendingAcks = await link.getPendingAcks("B");
   * const height = await link.relayAcks("B", pendingAcks);
   * if (height) {
   *   console.log(`Acks relayed at height: ${height}`);
   * }
   * ```
   */
  public async relayAcks(
    source: Side,
    acks: readonly TAckWithMeta[],
  ): Promise<number | null> {
    this.logger.info(
      `Relay ${acks.length} acks from ${this.chain(source)} => ${this.otherChain(source)}`,
    );
    if (acks.length === 0) {
      return null;
    }

    const {
      src, dest,
    } = this.getEnds(source);

    // Check if we need to update client at all
    const neededHeight = Math.max(...acks.map(x => x.height)) + 1;
    const headerHeight = await this.updateClientToHeight(source, neededHeight);

    const ackList = acks.map(meta => this.extractAck(meta));
    const proofs = await Promise.all(
      ackList.map(ack => this.getAckProof(src.client, this.extractOriginalPacket(ack), headerHeight)),
    );

    // Submit with retry logic
    const {
      height,
    } = await withRetry(
      () => this.acknowledgePacketsOnSrc(
        dest.client,
        ackList,
        proofs.map(proof => proof.proof),
        headerHeight,
      ),
      {
        maxRetries: 3,
        initialBackoff: 1000,
        logger: this.logger,
        shouldRetry: isRetryableError,
      },
    );
    return height;
  }

  /**
   * Timeout packets that have expired.
   * Waits for a block, updates client, and submits timeout proofs with retry logic.
   *
   * @param source - Which side originally sent the packets
   * @param packets - Expired packets with metadata to timeout
   * @returns Block height where timeouts were included, or null if no packets
   * @throws Error if timeout submission fails after retries
   *
   * @example
   * ```typescript
   * const expiredPackets = [...]; // Packets that have timed out
   * const height = await link.timeoutPackets("A", expiredPackets);
   * if (height) {
   *   console.log(`Timeouts processed at height: ${height}`);
   * }
   * ```
   */
  public async timeoutPackets(
    source: Side,
    packets: readonly TPacketWithMeta[],
  ): Promise<number | null> {
    this.logger.info(
      `Timeout ${packets.length} packets sent from ${this.chain(source)}`,
    );
    if (packets.length === 0) {
      return null;
    }

    const {
      src, dest,
    } = this.getEnds(source);
    const destSide = getOtherSide(source);

    // We need a header that is after the timeout
    await dest.client.waitOneBlock();
    const headerHeight = await this.updateClient(destSide);

    const rawPackets = packets.map(meta => this.extractPacket(meta));
    const proofs = await Promise.all(
      rawPackets.map(packet => this.getTimeoutProof(dest.client, packet, headerHeight)),
    );

    // Submit with retry logic
    const {
      height,
    } = await withRetry(
      () => this.timeoutPacketsOnSrc(
        src.client,
        rawPackets,
        proofs.map(proof => proof.proof),
        headerHeight,
      ),
      {
        maxRetries: 3,
        initialBackoff: 1000,
        logger: this.logger,
        shouldRetry: isRetryableError,
      },
    );
    return height;
  }

  /**
   * Get pending packets that need to be relayed.
   * Filters out already-received packets and those that have been timed out.
   *
   * @param source - Which side to check for sent packets
   * @param opts - Query options with optional minHeight and maxHeight
   * @returns Array of pending packets with metadata
   *
   * @example
   * ```typescript
   * // Get all pending packets from chain A
   * const packets = await link.getPendingPackets("A");
   *
   * // Get packets from specific height range
   * const recentPackets = await link.getPendingPackets("B", {
   *   minHeight: 1000,
   *   maxHeight: 2000
   * });
   * ```
   */
  public async getPendingPackets(
    source: Side,
    opts: QueryOpts = {},
  ): Promise<TPacketWithMeta[]> {
    this.logger.verbose(`Get pending packets on ${this.chain(source)}`);
    const {
      src, dest,
    } = this.getEnds(source);

    const allPackets = await this.querySentPackets(src, opts.minHeight, opts.maxHeight);
    const toFilter = allPackets.map(meta => this.extractPacket(meta));

    // Get subset that were already processed on receiving chain
    const unreceived = await this.filterUnreceived(
      toFilter,
      (packets) => this.queryUnreceivedPackets(dest.client, packets),
      (packet) => this.createPacketId(packet),
    );

    const unreceivedPackets = allPackets.filter(meta =>
      unreceived[this.createPacketId(this.extractPacket(meta))].has(Number(this.getPacketSequence(this.extractPacket(meta)))),
    );

    // Filter out those already submitted as timeouts
    const valid = await Promise.all(
      unreceivedPackets.map(async (packetMeta) => {
        const packet = this.extractPacket(packetMeta);
        try {
          await this.queryCommitments(src.client, packet);
          return packetMeta;
        }
        catch {
          return undefined;
        }
      }),
    );

    return valid.filter(isDefined);
  }

  /**
   * Get pending acknowledgements that need to be relayed.
   * Filters by packet filter if set, and checks which acks haven't been relayed yet.
   *
   * @param source - Which side to check for written acknowledgements
   * @param opts - Query options with optional minHeight and maxHeight
   * @returns Array of pending acknowledgements with metadata
   *
   * @example
   * ```typescript
   * // Get all pending acks from chain B
   * const acks = await link.getPendingAcks("B");
   *
   * // Get acks from recent blocks only
   * const recentAcks = await link.getPendingAcks("A", {
   *   minHeight: lastRelayedHeight
   * });
   * ```
   */
  public async getPendingAcks(
    source: Side,
    opts: QueryOpts = {},
  ): Promise<TAckWithMeta[]> {
    this.logger.verbose(`Get pending acks on ${this.chain(source)}`);
    const {
      src, dest,
    } = this.getEnds(source);

    const allAcks = await this.queryWrittenAcks(src, opts.minHeight, opts.maxHeight);
    const filteredAcks = this.packetFilter !== null
      ? allAcks.filter(meta => this.packetFilter?.(this.extractOriginalPacket(this.extractAck(meta))))
      : allAcks;

    const toFilter = filteredAcks.map(meta => this.extractOriginalPacket(this.extractAck(meta)));

    const unreceived = await this.filterUnreceived(
      toFilter,
      (packets) => this.queryUnreceivedAcks(dest.client, packets),
      (packet) => this.createAckId(packet),
    );

    return filteredAcks.filter(meta => {
      const originalPacket = this.extractOriginalPacket(this.extractAck(meta));
      return unreceived[this.createAckId(originalPacket)].has(Number(this.getPacketSequence(originalPacket)));
    });
  }

  /**
   * Filter packets/acks to find which are unreceived on destination.
   */
  private async filterUnreceived(
    packets: TPacket[],
    unreceivedQuery: (packets: readonly TPacket[]) => Promise<number[]>,
    idFunc: (packet: TPacket) => string,
  ): Promise<Record<string, Set<number>>> {
    if (packets.length === 0) {
      return {};
    }

    // Group by destination
    const packetsPerDestination: Record<string, number[]> = {};
    for (const packet of packets) {
      const key = idFunc(packet);
      if (!packetsPerDestination[key]) {
        packetsPerDestination[key] = [];
      }
      packetsPerDestination[key].push(Number(this.getPacketSequence(packet)));
    }

    // Query unreceived for each destination
    const unreceivedResponses = await Promise.all(
      Object.entries(packetsPerDestination).map(async ([destination, sequences]) => {
        const packetsForDest = packets.filter(p => idFunc(p) === destination);
        const notfound = await unreceivedQuery(packetsForDest);
        return {
          key: destination,
          sequences: notfound,
        };
      }),
    );

    const unreceived: Record<string, Set<number>> = {};
    for (const {
      key, sequences,
    } of unreceivedResponses) {
      unreceived[key] = new Set(sequences);
    }

    return unreceived;
  }

  /**
   * Main relay logic: checks both sides for pending packets and acks, then relays them.
   * Handles packet timeouts, client updates, and acknowledgement relay in a single operation.
   *
   * This is the primary method used by the relayer loop for continuous operation.
   *
   * @param relayFrom - Heights to start checking from (for optimization)
   * @param timedoutThresholdBlocks - Blocks before considering packet timed out (default: 0)
   * @param timedoutThresholdSeconds - Seconds before considering packet timed out (default: 0)
   * @returns Updated heights after relaying (use for next iteration)
   *
   * @example
   * ```typescript
   * let heights = { packetHeightA: 0, packetHeightB: 0, ackHeightA: 0, ackHeightB: 0 };
   *
   * // In relayer loop
   * while (running) {
   *   heights = await link.checkAndRelayPacketsAndAcks(
   *     heights,
   *     2,  // Timeout after 2 blocks
   *     6   // Timeout after 6 seconds
   *   );
   *   await sleep(5000);
   * }
   * ```
   */
  public async checkAndRelayPacketsAndAcks(
    relayFrom: RelayedHeights,
    timedoutThresholdBlocks = 0,
    timedoutThresholdSeconds = 0,
  ): Promise<RelayedHeights> {
    const {
      heights,
    } = await this.doCheckAndRelay(relayFrom, timedoutThresholdBlocks, timedoutThresholdSeconds);
    this.logger.verbose("next heights to relay", heights);
    return heights;
  }

  /**
   * Relay all pending packets and acks without height tracking.
   * Designed for integration tests in low-traffic CI or devnet environments.
   *
   * Unlike checkAndRelayPacketsAndAcks, this returns full relay information
   * including all acknowledgements for test validation.
   *
   * @returns Relay information with packet counts and all acks
   *
   * @example
   * ```typescript
   * // In integration tests
   * const info = await link.relayAll();
   * expect(info.packetsFromA).toBeGreaterThan(0);
   * expect(info.acksFromB).toHaveLength(info.packetsFromA);
   * ```
   */
  public async relayAll(): Promise<RelayInfo<TAckWithMeta>> {
    const result = await this.doCheckAndRelay({});
    return result.info;
  }

  /**
   * Core relay implementation.
   */
  protected async doCheckAndRelay(
    relayFrom: RelayedHeights,
    timedoutThresholdBlocks = 0,
    timedoutThresholdSeconds = 0,
  ): Promise<{ heights: RelayedHeights; info: RelayInfo<TAckWithMeta> }> {
    // Get current heights and pending packets from both sides
    const [packetHeightA, packetHeightB, packetsA, packetsB] = await Promise.all([
      this.endA.client.currentHeight(),
      this.endB.client.currentHeight(),
      this.getPendingPackets("A", {
        minHeight: relayFrom.packetHeightA,
      }),
      this.getPendingPackets("B", {
        minHeight: relayFrom.packetHeightB,
      }),
    ]);

    // Apply packet filter if set
    const filteredPacketsA = this.packetFilter !== null
      ? packetsA.filter(meta => this.packetFilter?.(this.extractPacket(meta)))
      : packetsA;
    const filteredPacketsB = this.packetFilter !== null
      ? packetsB.filter(meta => this.packetFilter?.(this.extractPacket(meta)))
      : packetsB;

    // Calculate timeout cutoffs
    const cutoffHeightA = await this.endB.client.timeoutHeight(timedoutThresholdBlocks);
    const cutoffTimeA = secondsFromDateNanos(await this.endB.client.currentTime()) + timedoutThresholdSeconds;
    const {
      toSubmit: submitA, toTimeout: timeoutA,
    } = this.splitPendingPackets(cutoffHeightA, cutoffTimeA, filteredPacketsA);

    const cutoffHeightB = await this.endA.client.timeoutHeight(timedoutThresholdBlocks);
    const cutoffTimeB = secondsFromDateNanos(await this.endA.client.currentTime()) + timedoutThresholdSeconds;
    const {
      toSubmit: submitB, toTimeout: timeoutB,
    } = this.splitPendingPackets(cutoffHeightB, cutoffTimeB, filteredPacketsB);

    // Relay packets
    await Promise.all([this.relayPackets("A", submitA), this.relayPackets("B", submitB)]);

    // Wait for indexer
    await Promise.all([this.endA.client.waitForIndexer(), this.endB.client.waitForIndexer()]);

    // Get and relay acks
    const [ackHeightA, ackHeightB, acksA, acksB] = await Promise.all([
      this.endA.client.currentHeight(),
      this.endB.client.currentHeight(),
      this.getPendingAcks("A", {
        minHeight: relayFrom.ackHeightA,
      }),
      this.getPendingAcks("B", {
        minHeight: relayFrom.ackHeightB,
      }),
    ]);

    await Promise.all([this.relayAcks("A", acksA), this.relayAcks("B", acksB)]);

    // Timeout expired packets
    await Promise.all([this.timeoutPackets("A", timeoutA), this.timeoutPackets("B", timeoutB)]);

    const heights = {
      packetHeightA,
      packetHeightB,
      ackHeightA,
      ackHeightB,
    };

    const info: RelayInfo<TAckWithMeta> = {
      packetsFromA: packetsA.length,
      packetsFromB: packetsB.length,
      acksFromA: acksA,
      acksFromB: acksB,
    };

    return {
      heights,
      info,
    };
  }
}
