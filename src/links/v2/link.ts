import {
  Packet,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";
import {
  arrayContentEquals,
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
 * this round, counted both in waits and in the time that many blocks take.
 * Ethereum finality normally takes two to three epochs (64 to 96 slots);
 * past this the relay loop retries later rather than hanging.
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
    // A halted chain never produces the block waitOneBlock waits for, so
    // the wait is bounded in time as well as in blocks.
    const deadline = Date.now() + MAX_HEADER_WAIT_BLOCKS * src.estimatedBlockTime;
    for (let waited = 0; height < minHeight; waited++) {
      if (waited >= MAX_HEADER_WAIT_BLOCKS || Date.now() >= deadline) {
        throw new Error(
          `${this.chain(source)} has not reached height ${minHeight} after ${waited} blocks (latest provable header: ${height}); retry later`,
        );
      }
      await src.waitOneBlock(deadline);
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
    const [packetBoundA, packetBoundB] = await Promise.all([this.scanBound("A", provableA), this.scanBound("B", provableB)]);
    const [scannedA, scannedB] = await Promise.all([this.scanPackets("A", relayFrom.packetHeightA, packetBoundA), this.scanPackets("B", relayFrom.packetHeightB, packetBoundB)]);
    const packetsA = scannedA.pending;
    const packetsB = scannedB.pending;

    const filteredPacketsA = this.filterPackets(packetsA);
    const filteredPacketsB = this.filterPackets(packetsB);

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

    const [ackProvableA, ackProvableB] = await Promise.all([this.provableHeader("A"), this.provableHeader("B")]);
    const [ackBoundA, ackBoundB] = await Promise.all([this.scanBound("A", ackProvableA), this.scanBound("B", ackProvableB)]);
    const [ackScanA, ackScanB] = await Promise.all([this.scanAcks("A", relayFrom.ackHeightA, ackBoundA), this.scanAcks("B", relayFrom.ackHeightB, ackBoundB)]);
    const acksA = ackScanA.pending;
    const acksB = ackScanB.pending;

    await Promise.all([this.relayAcks("A", acksA), this.relayAcks("B", acksB)]);

    // A timeout is proven at a header no older than the one that classified
    // it: an older one can predate the timeout.
    await Promise.all([this.timeoutPackets("A", timeoutA, provableB.height), this.timeoutPackets("B", timeoutB, provableA.height)]);

    // A floor stays below every event whose effect is not final yet, so
    // that a later round, after a restart too, scans it again: packets
    // waiting to time out, and those whose receipt, timeout or ack a reorg
    // of the chain holding it could still undo. That covers this round's
    // transactions on such a chain, and earlier rounds' ones the scan found
    // there in its latest state but not yet in its finalized one.
    const heights = {
      packetHeightA: nextFloor(relayFrom.packetHeightA, boundBefore(packetBoundA, [...waitA, ...this.filterPackets(scannedA.unsettled), ...this.awaitingFinality("B", submitA), ...this.awaitingFinality("A", timeoutA)])),
      packetHeightB: nextFloor(relayFrom.packetHeightB, boundBefore(packetBoundB, [...waitB, ...this.filterPackets(scannedB.unsettled), ...this.awaitingFinality("A", submitB), ...this.awaitingFinality("B", timeoutB)])),
      ackHeightA: nextFloor(relayFrom.ackHeightA, boundBefore(ackBoundA, [...ackScanA.unsettled, ...this.awaitingFinality("B", acksA)])),
      ackHeightB: nextFloor(relayFrom.ackHeightB, boundBefore(ackBoundB, [...ackScanB.unsettled, ...this.awaitingFinality("A", acksB)])),
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

  private filterPackets(packets: readonly PacketV2WithMetadata[]): readonly PacketV2WithMetadata[] {
    return this.packetFilter !== null
      ? packets.filter(packet => this.packetFilter?.(packet.packet))
      : packets;
  }

  /**
   * The items whose transactions this round sent to a side's chain, if a
   * reorg there can still undo them: Ethereum's writes return after one
   * confirmation, well before finality. Tendermint and gno blocks are final
   * once committed.
   */
  private awaitingFinality<T>(chain: Side, items: readonly T[]): readonly T[] {
    return isEthereum(this.getEnds(chain).src.client) ? items : [];
  }

  /**
   * How far past an event's height the first header that can prove it is,
   * on a side's chain. A Tendermint or gno header commits to the app hash of
   * the block before it: 1. An Ethereum finalized slot's state root already
   * holds its own block's events before Gloas: see eventProofOffset.
   */
  private async proofOffset(side: Side, height: number): Promise<number> {
    const client = this.getEnds(side).src.client;
    return isEthereum(client) ? client.eventProofOffset(height) : 1;
  }

  /** The lowest header of a side that proves every one of the events at heights. */
  private async provingHeight(side: Side, heights: readonly number[]): Promise<number> {
    const proving = await Promise.all(heights.map(async h => h + await this.proofOffset(side, h)));
    return Math.max(...proving);
  }

  /**
   * The highest height of a side whose packets and acks can be relayed in
   * this round: the highest its latest provable header proves, as
   * relayPackets and relayAcks need a header at proofOffset past an event.
   * An event past the bound stays unscanned until the header that proves it
   * exists, and the loop never waits for one.
   *
   * A round scans (floor, bound] and hands the bound back as the next floor,
   * so the scans tile the chain: a head read apart from the scan could stand
   * past the blocks the scan covered, and the blocks between were lost.
   */
  private async scanBound(side: Side, provable: ProvableHeader): Promise<number> {
    const [offset, horizon] = await Promise.all([this.proofOffset(side, provable.height), this.getEnds(side).src.client.scanHorizon()]);
    // Nor past the height the side's event source has served: the round
    // hands the bound back as the next floor, and a floor past events the
    // source has yet to serve (a lagging indexer or RPC) skips them for good.
    return Math.min(provable.height - offset, horizon);
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

  /** The packets sent in (floor, bound]; none when the bound is not past the floor. */
  private async scanPackets(source: Side, floor: number | undefined, bound: number): Promise<Scan<PacketV2WithMetadata>> {
    if (floor !== undefined && bound <= floor) {
      return emptyScan();
    }
    return this.findPendingPackets(source, {
      minHeight: floor,
      maxHeight: bound,
    });
  }

  /** The acks written in (floor, bound]; none when the bound is not past the floor. */
  private async scanAcks(source: Side, floor: number | undefined, bound: number): Promise<Scan<AckV2WithMetadata>> {
    if (floor !== undefined && bound <= floor) {
      return emptyScan();
    }
    return this.findPendingAcks(source, {
      minHeight: floor,
      maxHeight: bound,
    });
  }

  public async getPendingPackets(
    source: Side,
    opts: QueryOpts = {
    },
  ): Promise<PacketV2WithMetadata[]> {
    return (await this.findPendingPackets(source, opts)).pending;
  }

  /**
   * The packets a side sent in a window that are neither received nor timed
   * out, and those whose receipt or timeout is not final yet.
   */
  private async findPendingPackets(source: Side, opts: QueryOpts): Promise<Scan<PacketV2WithMetadata>> {
    this.logger.verbose(`Get pending packets on ${this.chain(source)}`);
    const {
      src, dest,
    } = this.getEnds(source);
    const allPackets = await src.querySentPackets(opts.minHeight, opts.maxHeight) as PacketV2WithMetadata[];

    // The packets the receiving chain has no receipt for.
    const unreceived = await this.filterUnreceived(allPackets.map(({
      packet,
    }) => packet), dest.client.queryUnreceivedPacketsV2.bind(dest.client), packetId);
    const isUnreceived = ({
      packet,
    }: PacketV2WithMetadata) => unreceived[packetId(packet)].has(packet.sequence);
    const unreceivedPackets = allPackets.filter(isUnreceived);
    const received = allPackets.filter(p => !isUnreceived(p));

    // Of those, the ones still committed on the source, not yet timed out.
    // This query fails as a whole when the chain does not answer: reading
    // each commitment on its own took any error for an absent commitment,
    // dropping a pending packet below the next floor for good.
    const committed = await this.filterUnreceived(unreceivedPackets.map(({
      packet,
    }) => packet), src.client.queryUnreceivedAcksV2.bind(src.client), ackId);
    const isCommitted = ({
      packet,
    }: PacketV2WithMetadata) => committed[ackId(packet)].has(packet.sequence);

    // A timed-out packet's send is at its own height on the source.
    const [receiptsNotFinal, timeoutsNotFinal] = await Promise.all([this.receiptsNotFinal(dest.client, received), this.clearedNotFinal(src.client, unreceivedPackets.filter(p => !isCommitted(p)), p => p.packet, p => p.height)]);
    return {
      pending: unreceivedPackets.filter(isCommitted),
      unsettled: [...receiptsNotFinal, ...timeoutsNotFinal],
    };
  }

  public async getPendingAcks(
    source: Side,
    opts: QueryOpts = {
    },
  ): Promise<AckV2WithMetadata[]> {
    return (await this.findPendingAcks(source, opts)).pending;
  }

  /**
   * The acks a side wrote in a window that the packet's sender has not
   * processed, and those it has processed but not finally yet.
   */
  private async findPendingAcks(source: Side, opts: QueryOpts): Promise<Scan<AckV2WithMetadata>> {
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
    const isUnreceived = ({
      originalPacket: packet,
    }: AckV2WithMetadata) => unreceived[ackId(packet)].has(packet.sequence);

    const acked = filteredAcks.filter(a => !isUnreceived(a));
    let unsettled: AckV2WithMetadata[] = [];
    if (acked.length > 0 && isEthereum(dest.client)) {
      // The packets were sent on the destination, at heights the acks do
      // not carry; each was proven to this side's client of it, so it was
      // sent at or below that client's latest height.
      const clientState = await src.client.getLatestClientState(src.clientID, dest.client.clientType);
      const proven = Number((clientState as {
        latestHeight?: Height
      }).latestHeight?.revisionHeight ?? Number.MAX_SAFE_INTEGER);
      unsettled = await this.clearedNotFinal(dest.client, acked, a => a.originalPacket, () => proven);
    }
    return {
      pending: filteredAcks.filter(isUnreceived),
      unsettled,
    };
  }

  /**
   * Of the packets a chain holds a receipt for, those it does not hold one
   * for in its finalized state: a reorg can still undo their receive, and
   * only Ethereum's state can be reorged.
   */
  private async receiptsNotFinal(chain: BaseIbcClient, packets: readonly PacketV2WithMetadata[]): Promise<PacketV2WithMetadata[]> {
    if (!isEthereum(chain) || packets.length === 0) {
      return [];
    }
    const {
      number,
    } = await chain.finalizedSnapshot();
    const unreceived = await this.filterUnreceived(packets.map(({
      packet,
    }) => packet), (client, sequences) => chain.queryUnreceivedPacketsV2(client, sequences, number), packetId);
    return packets.filter(({
      packet,
    }) => unreceived[packetId(packet)].has(packet.sequence));
  }

  /**
   * Of the packets whose commitment a chain has cleared, by an ack or a
   * timeout, those whose clearing is not final: still committed in its
   * finalized state, where a reorg can still undo the clearing, and only
   * Ethereum's state can be reorged. sentBy gives a height the packet was
   * sent at or before: a finalized state older than that, from an RPC that
   * lags, has no commitment because the send is not in it yet, and proves
   * nothing about the clearing.
   */
  private async clearedNotFinal<T>(chain: BaseIbcClient, items: readonly T[], packetOf: (item: T) => Packet, sentBy: (item: T) => number): Promise<T[]> {
    if (!isEthereum(chain) || items.length === 0) {
      return [];
    }
    const snapshot = await chain.finalizedSnapshot();
    const before = items.filter(item => sentBy(item) > snapshot.slot);
    const covered = items.filter(item => sentBy(item) <= snapshot.slot);
    if (before.length > 0) {
      this.logger.info(`${before.length} cleared packets on ${chain.chainId} were sent after its RPC's finalized slot ${snapshot.slot}: held until it passes them`);
    }
    const committed = await this.filterUnreceived(covered.map(packetOf), (client, sequences) => chain.queryUnreceivedAcksV2(client, sequences, snapshot.number), ackId);
    return [
      ...before,
      ...covered.filter((item) => {
        const packet = packetOf(item);
        return committed[ackId(packet)].has(packet.sequence);
      }),
    ];
  }

  private async filterUnreceived(
    packets: Packet[],
    unreceivedQuery: (
      client: string,
      sequences: readonly bigint[],
    ) => Promise<bigint[]>,
    idFunc: (packet: Packet) => string,
  ): Promise<Record<string, Set<bigint>>> {
    if (packets.length === 0) {
      return {
      };
    }

    const sequencesPerClient: Record<string, bigint[]> = {
    };
    for (const packet of packets) {
      const key = idFunc(packet);
      if (!sequencesPerClient[key]) {
        sequencesPerClient[key] = [];
      }
      sequencesPerClient[key].push(packet.sequence);
    }
    const unreceivedResponses = await Promise.all(
      Object.entries(sequencesPerClient).map(
        async ([client, sequences]) => {
          const notfound = await unreceivedQuery(client, sequences);
          return {
            key: client,
            sequences: notfound,
          };
        },
      ),
    );
    const unreceived: Record<string, Set<bigint>> = {
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
    const neededHeight = await this.provingHeight(source, packets.map(x => x.height));
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
    const neededHeight = await this.provingHeight(source, acks.map(x => x.height));
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
  //
  // minProofHeight is the destination's header the packets were found timed
  // out against: the proof is taken at it or a later one, never an earlier
  // one, whose time can be before the timeout.
  public async timeoutPackets(
    source: Side,
    packets: readonly PacketV2WithMetadata[],
    minProofHeight?: number,
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

    let headerHeight: Height;
    if (minProofHeight === undefined) {
      // We need a header that is after the timeout, not after the packet was committed
      // This can get complex with timeout timestamps. Let's just update to latest
      await dest.client.waitOneBlock();
      headerHeight = await this.updateClient(destSide);
    }
    else {
      // An update can land below the header that classified the packets,
      // as when a lagging beacon node serves an older finalized slot.
      headerHeight = await this.updateClientToHeight(destSide, minProofHeight);
      if (Number(headerHeight.revisionHeight) < minProofHeight) {
        throw new Error(`timeout proof height ${headerHeight.revisionHeight} on ${this.otherChain(source)} is below ${minProofHeight}, the header the packets timed out at`);
      }
    }

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
 * What a scan of a window found: the events to act on, and those already
 * acted on whose effect is not final yet, which hold the floor below them.
 */
interface Scan<T> {
  readonly pending: T[]
  readonly unsettled: T[]
}

const emptyScan = <T>(): Scan<T> => ({
  pending: [],
  unsettled: [],
});

/**
 * The bound a scan hands back when it leaves events held: one below the
 * earliest of them, so that the next round scans it again. The bound the
 * scan reached would put the event below every later floor, never to be
 * timed out or relayed again.
 */
const boundBefore = (bound: number, waiting: readonly {
  height: number
}[]): number =>
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

/**
 * The client a packet's receipt is kept under, on its destination, and the
 * one its commitment is kept under, on its source: filterUnreceived asks
 * once per client, with every sequence, which stay bigints throughout, as a
 * uint64 sequence past 2^53 has no exact number.
 */
const packetId = (packet: Packet) => packet.destinationClient;
const ackId = (packet: Packet) => packet.sourceClient;

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
