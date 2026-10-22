import {
  Packet,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";
import {
  arrayContentEquals, isDefined,
} from "@cosmjs/utils";
import * as winston from "winston";

import {
  BaseIbcClient, isEthereum, isGno, isGnoClientState, isGnoConsensusState, isTendermint, isTendermintClientState, isTendermintConsensusState,
} from "../../clients/BaseIbcClient.js";
import type {
  EthereumIbcClient,
} from "../../clients/ethereum/IbcClient.js";
import {
  isEthereumClientState, isEthereumConsensusState,
} from "../../clients/ethereum/types.js";
import {
  GnoIbcClient,
} from "../../clients/gno/IbcClient.js";
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
  AckV2WithMetadata, AnyClientState, ChannelInfo, ClientType, PacketV2WithMetadata, QueryOpts,
} from "../../types/index.js";
import {
  parseAcksFromTxEventsV2,
  secondsFromDateNanos,
  splitPendingPackets,
  timestampFromDateNanos,
  toIntHeight,
} from "../../utils/utils.js";

/**
 * Many actions on link focus on a src and a dest. Rather than add two functions,
 * we have `Side` to select if we initialize from A or B.
 */
export type Side = "A" | "B";

/**
 * How many blocks (Ethereum: slots) updateClientToHeight waits for the
 * source's provable header to reach the height it needs before giving up on
 * this round. Ethereum finality normally takes two to three epochs (64 to 96
 * slots); past this the relay loop retries later rather than hanging.
 */
const MAX_HEADER_WAIT_BLOCKS = 150;

export function otherSide(side: Side): Side {
  if (side === "A") {
    return "B";
  }
  else {
    return "A";
  }
}

/**
 * PacketFilter is the type for a function that accepts a Packet and returns a boolean defining whether to relay the packet or not
 */
export type PacketFilter = (packet: Packet) => boolean;

// This records the block heights from the last point where we successfully relayed packets.
// This can be used to optimize the next round of relaying
export interface RelayedHeights {
  packetHeightA?: number
  packetHeightB?: number
  ackHeightA?: number
  ackHeightB?: number
}

// This is metadata on a round of relaying
export interface RelayInfo {
  packetsFromA: number
  packetsFromB: number
  acksFromA: AckV2WithMetadata[]
  acksFromB: AckV2WithMetadata[]
}

/**
 * Link represents a Connection between a pair of blockchains (Nodes).
 * An initialized Link requires a both sides to have a Client for the remote side
 * as well as an established Connection using those Clients. Channels can be added
 * and removed to a Link. There are constructors to find/create the basic requirements
 * if you don't know the client/connection IDs a priori.
 */
export class Link {
  public readonly endA: BaseEndpoint;
  public readonly endB: BaseEndpoint;
  public readonly logger: winston.Logger;

  private readonly chainA: string;
  private readonly chainB: string;
  private packetFilter: PacketFilter | null = null;

  private chain(side: Side): string {
    if (side === "A") {
      return this.chainA;
    }
    else {
      return this.chainB;
    }
  }

  public setFilter(filter: PacketFilter): void {
    this.packetFilter = filter;
  }

  public clearFilter(): void {
    this.packetFilter = null;
  }

  private otherChain(side: Side): string {
    if (side === "A") {
      return this.chainB;
    }
    else {
      return this.chainA;
    }
  }

  /**
   * we do this assert inside createWithExistingConnections, but it could be a useful check
   * for submitting double-sign evidence later
   *
   * @param proofSide the side holding the consensus proof, we check the header from the other side
   * @param clientState the clientState indicating the consensus state and header we wish to compare
   */
  public async assertHeadersMatchConsensusState(
    proofSide: Side,
    clientId: string,
    clientState: AnyClientState,
  ): Promise<void> {
    const {
      src, dest,
    } = this.getEnds(proofSide);

    // The following is for a Tendermint client.
    // TODO: add support for other client types
    if (isTendermintClientState(clientState) && isTendermint(dest.client)) {
      const height = clientState.latestHeight;
      // Check headers match consensus state (at least validators)
      const [consensusState, header] = await Promise.all([src.client.getConsensusStateAtHeight(clientId, dest.client.clientType, height), dest.client.header(toIntHeight(height))]);

      if (isTendermintConsensusState(consensusState)) {
        // ensure consensus and headers match for next validator hashes
        if (
          !arrayContentEquals(
            consensusState.nextValidatorsHash, header.nextValidatorsHash,
          )
        ) {
          throw new Error("NextValidatorHash doesn't match ConsensusState.");
        }
        // ensure the committed apphash matches the actual node we have
        const hash = consensusState.root?.hash;
        if (!hash) {
          throw new Error("ConsensusState.root.hash missing.");
        }
        if (!arrayContentEquals(hash, header.appHash)) {
          throw new Error("AppHash doesn't match ConsensusState.");
        }
      }
    }
  }

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
    let merklePrefixA = Buffer.from("ibc", "utf-8");
    let merklePrefixB = Buffer.from("ibc", "utf-8");
    let merklePathPrefixA = new Uint8Array();
    let merklePathPrefixB = new Uint8Array();
    if (isGno(nodeA)) {
      merklePrefixA = Buffer.from("main", "utf-8");
      merklePathPrefixA = Buffer.from("/pv/vm:gno.land/r/aib/ibc/core:", "utf-8");
    }
    if (isGno(nodeB)) {
      merklePrefixB = Buffer.from("main", "utf-8");
      merklePathPrefixB = Buffer.from("/pv/vm:gno.land/r/aib/ibc/core:", "utf-8");
    }
    // The ICS26 router keys its commitments by the ICS24 path itself: its
    // prefix is a single empty element, which hosts of an Ethereum client
    // register from the client's type.
    if (isEthereum(nodeA)) {
      merklePrefixA = Buffer.from("", "utf-8");
    }
    if (isEthereum(nodeB)) {
      merklePrefixB = Buffer.from("", "utf-8");
    }
    await nodeB.registerCounterParty(clientIdB, clientIdA, merklePrefixA, merklePathPrefixA);
    await nodeA.registerCounterParty(clientIdA, clientIdB, merklePrefixB, merklePathPrefixB);
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
        `Client ID on [${chainA}] : ${clientIdA}  dos not match counterparty client ID on [${chainB}] : ${connectionB}`,
      );
    }
    if (clientIdB !== connectionA) {
      throw new Error(
        `Client ID on [${chainB}] : ${clientIdB}  dos not match counterparty client ID on [${chainA}] : ${connectionA}`,
      );
    }

    // An additional check for clients where client state contains a chain ID e.g. Tendermint
    const [clientStateA, clientStateB] = await Promise.all([nodeA.getLatestClientState(clientIdA, nodeB.clientType), nodeB.getLatestClientState(clientIdB, nodeA.clientType)]);

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
    this.endA = endA;
    this.endB = endB;
    this.logger = logger;
    this.chainA = endA.client.chainId;
    this.chainB = endB.client.chainId;
  }

  /**
   * Writes the latest header from the sender chain to the other endpoint
   *
   * @param sender Which side we get the header/commit from
   * @returns header height (from sender) that is now known on dest
   *
   * Relayer binary should call this from a heartbeat which checks if needed and updates.
   * Just needs trusting period on both side
   */
  public async updateClient(sender: Side): Promise<Height> {
    this.logger.info(`Update Client on ${this.otherChain(sender)}`);
    const {
      src, dest,
    } = this.getEnds(sender);
    const height = await dest.client.updateClient(dest.clientID, src.client);
    return height;
  }

  /**
   * Checks if the last proven header on the destination is older than maxAge,
   * and if so, update the client. Returns the new client height if updated,
   * or null if no update needed
   *
   * @param sender
   * @param maxAge
   */
  public async updateClientIfStale(
    sender: Side,
    maxAge: number,
  ): Promise<Height | null> {
    this.logger.verbose(
      `Checking if ${this.otherChain(sender)} has recent header of ${this.chain(
        sender,
      )}`,
    );
    const {
      src, dest,
    } = this.getEnds(sender);
    // The following checks are for Termendmint clients.
    // TODO: Add support for other client types
    const knownHeader = await dest.client.getConsensusStateAtHeight(
      dest.clientID,
      src.client.clientType,
    );

    if (!isTendermintConsensusState(knownHeader) && !isGnoConsensusState(knownHeader) && !isEthereumConsensusState(knownHeader)) {
      throw new Error(
        `Expected a Tendermint, Gno or Ethereum consensus state, got ${knownHeader}`,
      );
    }
    if (!isTendermint(src.client) && !isGno(src.client) && !isEthereum(src.client)) {
      throw new Error(
        `updateClientIfStale only supported for Tendermint/Gno/Ethereum clients, got ${src.client.clientType}`,
      );
    }

    let knownSeconds: number;
    if (isTendermintConsensusState(knownHeader)) {
      knownSeconds = Number(knownHeader.timestamp?.seconds);
    }
    else if (isGnoConsensusState(knownHeader)) {
      knownSeconds = Number(knownHeader.timestamp?.seconds);
    }
    else if (isEthereumConsensusState(knownHeader)) {
      knownSeconds = Number(knownHeader.timestamp.seconds);
    }
    else {
      knownSeconds = 0;
    }

    if (knownSeconds) {
      if (isTendermint(src.client)) {
        const currentHeader = await src.client.latestHeader();
        const curSeconds = Number(
          timestampFromDateNanos(currentHeader.time).seconds,
        );
        if (curSeconds - knownSeconds < maxAge) {
          return null;
        }
      }
      else if (isGno(src.client) || isEthereum(src.client)) {
        const currentHeader = await src.client.latestHeader();
        const curSeconds = Number(currentHeader.time.seconds);
        if (curSeconds - knownSeconds < maxAge) {
          return null;
        }
      }
    }
    // otherwise, do the update
    return this.updateClient(sender);
  }

  /**
   * Ensures the dest has a proof of at least minHeight from source.
   * Will not execute any tx if not needed.
   * Will wait a block if needed until the header is available.
   *
   * Returns the latest header height now available on dest
   */
  public async updateClientToHeight(
    source: Side,
    minHeight: number,
  ): Promise<Height> {
    this.logger.info(
      `Check whether client on ${this.otherChain(
        source,
      )} >= height ${minHeight}`,
    );
    const {
      src, dest,
    } = this.getEnds(source);
    // The following checks are for Termendmint clients.
    // TODO: Add support for other client types
    if (!isTendermint(src.client) && !isGno(src.client) && !isEthereum(src.client)) {
      throw new Error(
        `updateClientToHeight only supported for Tendermint/Gno/Ethereum clients, got ${src.client.clientType}`,
      );
    }
    const clientState = await dest.client.getLatestClientState(dest.clientID, src.client.clientType);

    if (!isTendermintClientState(clientState) && !isGnoClientState(clientState) && !isEthereumClientState(clientState)) {
      throw new Error(
        `Expected a Tendermint, Gno or Ethereum client state, got ${clientState}`,
      );
    }
    // TODO: revisit where revision number comes from - this must be the number from the source chain
    const knownHeight = Number(clientState.latestHeight?.revisionHeight ?? 0);
    if (knownHeight >= minHeight && clientState.latestHeight !== undefined) {
      return clientState.latestHeight;
    }

    // An update can only reach the source's latest provable header: its
    // latest block for a Tendermint chain, its latest finalized slot for
    // Ethereum, which trails the head by two epochs or more. Below minHeight
    // it is no use, as every proof is then taken at a state before the event
    // it is for, so wait for the header to get there before updating.
    await this.waitForHeader(source, src.client, minHeight);
    const height = await this.updateClient(source);
    if (Number(height.revisionHeight) < minHeight) {
      throw new Error(
        `client on ${this.otherChain(source)} updated to height ${height.revisionHeight}, below the needed ${minHeight}`,
      );
    }
    return height;
  }

  /** Waits until the source's latest provable header is at or past minHeight. */
  private async waitForHeader(
    source: Side,
    src: TendermintIbcClient | GnoIbcClient | EthereumIbcClient,
    minHeight: number,
  ): Promise<void> {
    let height = (await src.latestHeader()).height;
    if (height >= minHeight) {
      return;
    }
    this.logger.info(
      `Waiting for ${this.chain(source)} to reach height ${minHeight} (latest provable header: ${height})`,
    );
    for (let waited = 0; height < minHeight; waited++) {
      if (waited >= MAX_HEADER_WAIT_BLOCKS) {
        throw new Error(
          `${this.chain(source)} has not reached height ${minHeight} after ${waited} blocks (latest provable header: ${height}); retry later`,
        );
      }
      await src.waitOneBlock();
      height = (await src.latestHeader()).height;
    }
  }

  /**
   * This is a variant of checkAndRelayPacketsAndAcks designed for integration tests.
   * It doesn't have the optimizations of the other variant, as this is designed for low-traffic
   * CI or devnet environments.
   * It does, however, return all the acknowledgements, so we can check for
   */
  public async relayAll(): Promise<RelayInfo> {
    const result = await this.doCheckAndRelay({
    });
    return result.info;
  }

  /**
   * This will check both sides for pending packets and relay them.
   * It will then relay all acks (previous and generated by the just-submitted packets).
   * If pending packets have timed out, it will submit a timeout instead of attempting to relay them.
   *
   * Returns the most recent heights it relay, which can be used as a start for the next round
   */
  public async checkAndRelayPacketsAndAcks(
    relayFrom: RelayedHeights,
    timedoutThresholdBlocks = 0,
    timedoutThresholdSeconds = 0,
  ): Promise<RelayedHeights> {
    const {
      heights,
    } = await this.doCheckAndRelay(
      relayFrom, timedoutThresholdBlocks, timedoutThresholdSeconds,
    );
    this.logger.verbose(`next heights to relay: ${JSON.stringify(heights)}`);
    return heights;
  }

  protected async doCheckAndRelay(
    relayFrom: RelayedHeights,
    timedoutThresholdBlocks = 0,
    timedoutThresholdSeconds = 0,
  ): Promise<{
    heights: RelayedHeights
    info: RelayInfo
  }> {
    // Each side's latest provable header, read once: its height bounds the
    // scan of the side's own packets, and it decides which of the other
    // side's packets have timed out.
    const [provableA, provableB] = await Promise.all([this.provableHeader("A"), this.provableHeader("B")]);
    const packetBoundA = scanBound(provableA);
    const packetBoundB = scanBound(provableB);
    const [packetsA, packetsB] = await Promise.all([this.scanPackets("A", relayFrom.packetHeightA, packetBoundA), this.scanPackets("B", relayFrom.packetHeightB, packetBoundB)]);

    const filteredPacketsA
      = this.packetFilter !== null
        ? packetsA.filter(packet => this.packetFilter?.(packet.packet))
        : packetsA;
    const filteredPacketsB
      = this.packetFilter !== null
        ? packetsB.filter(packet => this.packetFilter?.(packet.packet))
        : packetsB;

    const [
      {
        toSubmit: submitA, toTimeout: timeoutA, toWait: waitA,
      },
      {
        toSubmit: submitB, toTimeout: timeoutB, toWait: waitB,
      },
    ] = await Promise.all([this.splitPackets("A", filteredPacketsA, provableB, timedoutThresholdBlocks, timedoutThresholdSeconds), this.splitPackets("B", filteredPacketsB, provableA, timedoutThresholdBlocks, timedoutThresholdSeconds)]);
    // FIXME: use the returned acks first? Then query for others?
    await Promise.all([this.relayPackets("A", submitA), this.relayPackets("B", submitB)]);

    // let's wait a bit to ensure our newly committed acks are indexed
    await Promise.all([this.endA.client.waitForIndexer(), this.endB.client.waitForIndexer()]);

    const [ackBoundA, ackBoundB] = (await Promise.all([this.provableHeader("A"), this.provableHeader("B")])).map(scanBound);
    const [acksA, acksB] = await Promise.all([this.scanAcks("A", relayFrom.ackHeightA, ackBoundA), this.scanAcks("B", relayFrom.ackHeightB, ackBoundB)]);

    await Promise.all([this.relayAcks("A", acksA), this.relayAcks("B", acksB)]);

    await Promise.all([this.timeoutPackets("A", timeoutA), this.timeoutPackets("B", timeoutB)]);

    const heights = {
      packetHeightA: nextFloor(relayFrom.packetHeightA, boundBefore(packetBoundA, waitA)),
      packetHeightB: nextFloor(relayFrom.packetHeightB, boundBefore(packetBoundB, waitB)),
      ackHeightA: nextFloor(relayFrom.ackHeightA, ackBoundA),
      ackHeightB: nextFloor(relayFrom.ackHeightB, ackBoundB),
    };

    const info: RelayInfo = {
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

  /**
   * A side's latest provable header, the latest one the other side's client
   * can be updated to: the latest block of a Tendermint or gno chain, the
   * latest finalized slot of Ethereum, which trails its head by two epochs
   * or more. A proof the other side can verify is taken at this header or
   * an earlier one.
   */
  private async provableHeader(side: Side): Promise<ProvableHeader> {
    const client = this.getEnds(side).src.client;
    if (isTendermint(client)) {
      const header = await client.latestHeader();
      return {
        height: header.height,
        time: secondsFromDateNanos(header.time),
      };
    }
    if (isGno(client) || isEthereum(client)) {
      const header = await client.latestHeader();
      return {
        height: Number(header.height),
        time: Number(header.time.seconds),
      };
    }
    throw new Error(
      `relaying only supported for Tendermint/Gno/Ethereum clients, got ${client.clientType}`,
    );
  }

  /**
   * Splits the packets a side sent into those to deliver now, those to time
   * out now, and those to leave waiting. A packet is delivered while it is
   * live at the destination's head, where the receive executes, less the
   * configured margin; it is timed out once it is dead at the destination's
   * latest provable header, where the proof of non-receipt is taken, and no
   * margin can bring that header forward. Dead at the head but not yet at
   * the provable header, it waits for a later round.
   *
   * The two headers are one on a Tendermint or gno chain. On Ethereum the
   * provable header is the finalized slot, 13 minutes or more behind the
   * head: deciding timeouts against the head had the loop submit, round
   * after round, a timeout the destination's client could not yet verify.
   */
  private async splitPackets(
    source: Side,
    packets: readonly PacketV2WithMetadata[],
    provable: ProvableHeader,
    timedoutThresholdBlocks: number,
    timedoutThresholdSeconds: number,
  ): Promise<SplitPackets> {
    if (packets.length === 0) {
      return {
        toSubmit: [],
        toTimeout: [],
        toWait: [],
      };
    }
    const {
      dest,
    } = this.getEnds(source);
    const headHeight = await dest.client.timeoutHeight(timedoutThresholdBlocks);
    const headTime = secondsFromDateNanos(await dest.client.currentTime()) + timedoutThresholdSeconds;
    const {
      toSubmit, toTimeout: dead,
    } = splitPendingPackets(headHeight, headTime, packets);
    const {
      toSubmit: toWait, toTimeout,
    } = splitPendingPackets(dest.client.revisionHeight(provable.height), provable.time, dead);
    if (toWait.length > 0) {
      this.logger.info(
        `${toWait.length} packets sent from ${this.chain(source)} wait for the provable header of ${this.otherChain(source)} to pass their timeout`,
      );
    }
    return {
      toSubmit,
      toTimeout,
      toWait,
    };
  }

  /** The pending packets sent in (floor, bound]; none when the bound is not past the floor. */
  private async scanPackets(source: Side, floor: number | undefined, bound: number): Promise<PacketV2WithMetadata[]> {
    if (floor !== undefined && bound <= floor) {
      return [];
    }
    return this.getPendingPackets(source, {
      minHeight: floor,
      maxHeight: bound,
    });
  }

  /** The pending acks written in (floor, bound]; none when the bound is not past the floor. */
  private async scanAcks(source: Side, floor: number | undefined, bound: number): Promise<AckV2WithMetadata[]> {
    if (floor !== undefined && bound <= floor) {
      return [];
    }
    return this.getPendingAcks(source, {
      minHeight: floor,
      maxHeight: bound,
    });
  }

  public async getPendingPackets(
    source: Side,
    opts: QueryOpts = {
    },
  ): Promise<PacketV2WithMetadata[]> {
    this.logger.verbose(`Get pending packets on ${this.chain(source)}`);
    const {
      src, dest,
    } = this.getEnds(source);
    const allPackets = await src.querySentPackets(opts.minHeight, opts.maxHeight) as PacketV2WithMetadata[];
    const toFilter = allPackets.map(({
      packet,
    }) => packet);

    // This gets the subset of packets that were already processed on the receiving chain
    const unreceived = await this.filterUnreceived(toFilter, dest.client.queryUnreceivedPacketsV2.bind(dest.client), packetId);
    const unreceivedPackets = allPackets.filter(({
      packet,
    }) =>
      unreceived[packetId(packet)].has(Number(packet.sequence)),
    );

    // However, some of these may have already been submitted as timeouts on the source chain. Check and filter
    const valid = await Promise.all(
      unreceivedPackets.map(async (packet) => {
        const {
          sourceClient, sequence,
        } = packet.packet;
        try {
          // this throws an error if no commitment there
          await src.client.queryCommitmentsV2(
            sourceClient, sequence,
          );
          return packet;
        }
        catch {
          // Commitment not found - packet may have already been timed out
          return undefined;
        }
      }),
    );
    return valid.filter(isDefined);
  }

  public async getPendingAcks(
    source: Side,
    opts: QueryOpts = {
    },
  ): Promise<AckV2WithMetadata[]> {
    this.logger.verbose(`Get pending acks on ${this.chain(source)}`);
    const {
      src, dest,
    } = this.getEnds(source);
    const allAcks = await src.queryWrittenAcks(opts.minHeight, opts.maxHeight) as AckV2WithMetadata[];
    const filteredAcks
      = this.packetFilter !== null
        ? allAcks.filter(ack => this.packetFilter?.(ack.originalPacket))
        : allAcks;
    const toFilter = filteredAcks.map(({
      originalPacket,
    }) => originalPacket);

    const unreceived = await this.filterUnreceived(toFilter, dest.client.queryUnreceivedAcksV2.bind(dest.client), ackId);

    return filteredAcks.filter(({
      originalPacket: packet,
    }) =>
      unreceived[ackId(packet)].has(Number(packet.sequence)),
    );
  }

  private async filterUnreceived(
    packets: Packet[],
    unreceivedQuery: (
      client: string,
      sequences: readonly number[],
    ) => Promise<number[]>,
    idFunc: (packet: Packet) => string,
  ): Promise<Record<string, Set<number>>> {
    if (packets.length === 0) {
      return {
      };
    }

    const packetsPerDestination: Record<string, number[]> = {
    };
    for (const packet of packets) {
      const key = idFunc(packet);
      if (!packetsPerDestination[key]) {
        packetsPerDestination[key] = [];
      }
      packetsPerDestination[key].push(Number(packet.sequence));
    }
    const unreceivedResponses = await Promise.all(
      Object.entries(packetsPerDestination).map(
        async ([destination, sequences]) => {
          const [client, _] = destination.split(idDelim);
          const notfound = await unreceivedQuery(client, sequences);
          return {
            key: destination,
            sequences: notfound,
          };
        },
      ),
    );
    const unreceived: Record<string, Set<number>> = {
    };
    for (const {
      key, sequences,
    } of unreceivedResponses) {
      unreceived[key] = new Set(sequences);
    }
    return unreceived;
  }

  // this will update the client if needed and relay all provided packets from src -> dest
  // if packets are all older than the last consensusHeight, then we don't update the client.
  //
  // Returns all the acks that are associated with the just submitted packets
  public async relayPackets(
    source: Side,
    packets: readonly PacketV2WithMetadata[],
  ): Promise<AckV2WithMetadata[]> {
    this.logger.info(
      `Relay ${packets.length} packets from ${this.chain(
        source,
      )} => ${this.otherChain(source)}`,
    );
    if (packets.length === 0) {
      return [];
    }
    const {
      src, dest,
    } = this.getEnds(source);

    // check if we need to update client at all
    const neededHeight = Math.max(...packets.map(x => x.height)) + 1;
    const headerHeight = await this.updateClientToHeight(source, neededHeight);

    const submit = packets.map(({
      packet,
    }) => packet);
    const proofs = await Promise.all(
      submit.map(packet => src.client.getPacketProofV2(packet, headerHeight)),
    );
    const {
      events, height, transactionHash,
    }
      = await dest.client.receivePacketsV2(submit, proofs.map(proof => proof.proof), headerHeight);
    const acks = parseAcksFromTxEventsV2(events);
    return acks.map(ack => ({
      height,
      txHash: transactionHash,
      txEvents: events,
      ...ack,
    }));
  }

  // this will update the client if needed and relay all provided acks from src -> dest
  // (yes, dest is where the packet was sent, but the ack was written on src).
  // if acks are all older than the last consensusHeight, then we don't update the client.
  //
  // Returns the block height the acks were included in, or null if no acks sent
  public async relayAcks(
    source: Side,
    acks: readonly AckV2WithMetadata[],
  ): Promise<number | null> {
    this.logger.info(
      `Relay ${acks.length} acks from ${this.chain(
        source,
      )} => ${this.otherChain(source)}`,
    );
    if (acks.length === 0) {
      return null;
    }

    const {
      src, dest,
    } = this.getEnds(source);

    // check if we need to update client at all
    const neededHeight = Math.max(...acks.map(x => x.height)) + 1;
    const headerHeight = await this.updateClientToHeight(source, neededHeight);

    const proofs = await Promise.all(
      acks.map(ack => src.client.getAckProofV2(ack.originalPacket, headerHeight)),
    );
    const {
      height,
    } = await dest.client.acknowledgePacketsV2(
      acks, proofs.map(proof => proof.proof), headerHeight,
    );
    return height;
  }

  // Source: the side that originally sent the packet
  // We need to relay a proof from dest -> source
  public async timeoutPackets(
    source: Side,
    packets: readonly PacketV2WithMetadata[],
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
    const destSide = otherSide(source);

    // We need a header that is after the timeout, not after the packet was committed
    // This can get complex with timeout timestamps. Let's just update to latest
    await dest.client.waitOneBlock();
    const headerHeight = await this.updateClient(destSide);

    const rawPackets = packets.map(({
      packet,
    }) => packet);
    const proofAndSeqs = await Promise.all(
      rawPackets.map(async (packet) => {
        const fakeAck = {
          originalPacket: packet,
          acknowledgement: new Uint8Array(),
        };
        const proof = await dest.client.getTimeoutProofV2(fakeAck.originalPacket, headerHeight);
        return {
          proof,
        };
      }),
    );
    const proofs = proofAndSeqs.map(({
      proof,
    }) => proof);

    const {
      height,
    } = await src.client.timeoutPacketsV2(
      rawPackets, proofs.map(proof => proof.proof), headerHeight,
    );
    return height;
  }

  private getEnds(src: Side): EndpointPair {
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
}

/** A chain's latest provable header: its height, and its time in seconds. */
interface ProvableHeader {
  readonly height: number
  readonly time: number
}

interface SplitPackets {
  readonly toSubmit: readonly PacketV2WithMetadata[]
  readonly toTimeout: readonly PacketV2WithMetadata[]
  readonly toWait: readonly PacketV2WithMetadata[]
}

/**
 * The highest height of a side whose packets and acks can be relayed in
 * this round: one below its latest provable header, as relayPackets and
 * relayAcks prove an event at the height after its block. An event past
 * the bound stays unscanned until the header that proves it exists, and
 * the loop never waits for one.
 *
 * A round scans (floor, bound] and hands the bound back as the next floor,
 * so the scans tile the chain: a head read apart from the scan could stand
 * past the blocks the scan covered, and the blocks between were lost.
 */
const scanBound = (provable: ProvableHeader): number => provable.height - 1;

/**
 * The bound a scan hands back when it leaves packets waiting: one below the
 * earliest of them, so that the next round scans it again. The bound the
 * scan reached would put the packet below every later floor, never to be
 * timed out.
 */
const boundBefore = (bound: number, waiting: readonly PacketV2WithMetadata[]): number =>
  waiting.reduce((b, {
    height,
  }) => Math.min(b, height - 1), bound);

/**
 * The floor of the next scan: the bound this one reached, unless the floor
 * already stood past it (a provable header read behind an earlier one, or a
 * floor recorded before scans were bounded), which no scan may undercut.
 */
const nextFloor = (floor: number | undefined, bound: number): number =>
  floor === undefined ? bound : Math.max(floor, bound);

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
function getEndpoint(
  client: BaseIbcClient,
  clientId: string,
  connectionId?: string,
): BaseEndpoint {
  switch (client.clientType) {
    case ClientType.Tendermint:
      return new TendermintEndpoint(client as TendermintIbcClient, clientId, connectionId);
    case ClientType.Gno:
      return new TendermintEndpoint(client as GnoIbcClient, clientId, connectionId);
    case ClientType.Ethereum:
      return new TendermintEndpoint(client as EthereumIbcClient, clientId, connectionId);
    default:
      throw new Error(`Unsupported client type: ${client.clientType}`);
  }
}
async function createClients(
  nodeA: BaseIbcClient,
  nodeB: BaseIbcClient,
  // number of seconds the client (on B pointing to A) is valid without update
  trustPeriodA?: number | null,
  // number of seconds the client (on A pointing to B) is valid without update
  trustPeriodB?: number | null,
): Promise<string[]> {
  // client on B pointing to A
  let clientIdA = "", clientIdB = "";
  if (isTendermint(nodeA)) {
    const args = await nodeA.buildCreateClientArgs(trustPeriodA);
    const {
      clientId,
    } = await nodeB.createTendermintClient(
      args.clientState, args.consensusState,
    );
    nodeB.logger.info(`Created client for nodeB: ${clientId}`);
    clientIdB = clientId;
  }

  if (isGno(nodeA)) {
    const args = await nodeA.buildCreateClientArgs(trustPeriodA);
    const {
      clientId,
    } = await nodeB.createGnoClient(
      args.clientState, args.consensusState,
    );
    nodeB.logger.info(`Created client for nodeB: ${clientId}`);
    clientIdB = clientId;
  }

  if (isEthereum(nodeA)) {
    const args = await nodeA.buildCreateClientArgs(trustPeriodA);
    const {
      clientId,
    } = await nodeB.createEthereumClient(
      args.clientState, args.consensusState,
    );
    nodeB.logger.info(`Created client for nodeB: ${clientId}`);
    clientIdB = clientId;
  }

  // client on A pointing to B
  if (isTendermint(nodeB)) {
    const args2 = await nodeB.buildCreateClientArgs(trustPeriodB);
    const {
      clientId,
    } = await nodeA.createTendermintClient(
      args2.clientState, args2.consensusState,
    );
    nodeA.logger.info(`Created client for nodeA: ${clientId}`);
    clientIdA = clientId;
  }

  if (isGno(nodeB)) {
    const args2 = await nodeB.buildCreateClientArgs(trustPeriodB);
    const {
      clientId,
    } = await nodeA.createGnoClient(
      args2.clientState, args2.consensusState,
    );
    nodeA.logger.info(`Created client for nodeA: ${clientId}`);
    clientIdA = clientId;
  }

  if (isEthereum(nodeB)) {
    const args2 = await nodeB.buildCreateClientArgs(trustPeriodB);
    const {
      clientId,
    } = await nodeA.createEthereumClient(
      args2.clientState, args2.consensusState,
    );
    nodeA.logger.info(`Created client for nodeA: ${clientId}`);
    clientIdA = clientId;
  }
  return [clientIdA.trim(), clientIdB.trim()];
}
