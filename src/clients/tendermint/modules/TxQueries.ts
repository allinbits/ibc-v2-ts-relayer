/**
 * TxQueries module for TendermintIbcClient
 *
 * Handles all IBC transaction and event queries including:
 * - Block and transaction searches
 * - Packet queries (sent packets, commitments)
 * - Acknowledgement queries (written acks, unreceived acks)
 * - Event parsing from blocks and transactions
 * - Both IBC v1 and v2 query support
 *
 * This module is responsible for querying the chain for IBC events and packets
 * from both transaction logs and block results.
 */

import {
  fromTendermintEvent,
} from "@cosmjs/stargate";
import {
  toHex,
} from "@cosmjs/encoding";

import type {
  AckV2WithMetadata,
  AckWithMetadata,
  BlockResultsResponse,
  BlockSearchResponse,
  PacketV2WithMetadata,
  PacketWithMetadata,
  TxSearchResponse,
} from "../../../types/index.js";
import {
  parseAcksFromTxEvents,
  parseAcksFromTxEventsV2,
  parsePacketsFromBlockResult,
  parsePacketsFromBlockResultV2,
  parsePacketsFromTendermintEvents,
  parsePacketsFromTendermintEventsV2,
} from "../../../utils/utils.js";
import type {
  TendermintIbcClient,
} from "../IbcClient.js";

/**
 * TxQueries helper class for TendermintIbcClient.
 *
 * This class contains all transaction and event query methods. It's designed to be
 * used internally by TendermintIbcClient through composition.
 */
export class TxQueries {
  constructor(private client: TendermintIbcClient) {}

  /**
   * Searches for blocks matching a query string.
   *
   * @param query - Tendermint query string (e.g., "send_packet.packet_connection='connection-0'")
   * @returns Block search results containing matching blocks
   */
  public async searchTendermintBlocks(query: string): Promise<BlockSearchResponse> {
    const search = await this.client.tm.blockSearchAll({
      query,
    });
    return search;
  }

  /**
   * Gets block results (begin/end block events) for a specific height.
   *
   * @param height - The block height to query
   * @returns Block results containing events from begin_block and end_block
   */
  public async getTendermintBlockResults(height: number): Promise<BlockResultsResponse> {
    const result = await this.client.tm.blockResults(height);
    return result;
  }

  /**
   * Searches for transactions matching a query string.
   *
   * @param query - Tendermint query string (e.g., "write_acknowledgement.packet_connection='connection-0'")
   * @returns Transaction search results containing matching transactions
   */
  public async searchTendermintTxs(query: string): Promise<TxSearchResponse> {
    const search = await this.client.tm.txSearchAll({
      query,
    });
    return search;
  }

  /**
   * Queries all sent packets for an IBC v1 connection within a height range.
   *
   * Combines results from both transaction events and block events.
   *
   * @param connectionId - The connection ID to query packets for
   * @param minHeight - Minimum block height (inclusive), undefined for no lower bound
   * @param maxHeight - Maximum block height (inclusive), undefined for no upper bound
   * @returns Array of packets with metadata (height, hash, events)
   */
  public async querySentPackets(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[]> {
    const txsPackets = await this.getPacketsFromTxs(connectionId, minHeight, maxHeight);
    const eventsPackets = await this.getPacketsFromBlockEvents(connectionId, minHeight, maxHeight);
    return ([] as PacketWithMetadata[])
      .concat(...txsPackets)
      .concat(...eventsPackets);
  }

  /**
   * Queries all sent packets for an IBC v2 client within a height range.
   *
   * Combines results from both transaction events and block events.
   *
   * @param clientId - The client ID to query packets for
   * @param minHeight - Minimum block height (inclusive), undefined for no lower bound
   * @param maxHeight - Maximum block height (inclusive), undefined for no upper bound
   * @returns Array of v2 packets with metadata (height, hash, events)
   */
  public async querySentPacketsV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketV2WithMetadata[]> {
    const txsPackets = await this.getPacketsFromTxsV2(clientId, minHeight, maxHeight);
    const eventsPackets = await this.getPacketsFromBlockEventsV2(clientId, minHeight, maxHeight);
    return ([] as PacketV2WithMetadata[])
      .concat(...txsPackets)
      .concat(...eventsPackets);
  }

  /**
   * Queries all written acknowledgements for an IBC v1 connection within a height range.
   *
   * @param connectionId - The connection ID to query acknowledgements for
   * @param minHeight - Minimum block height (inclusive), undefined for no lower bound
   * @param maxHeight - Maximum block height (inclusive), undefined for no upper bound
   * @returns Array of acknowledgements with metadata (height, hash, events)
   */
  public async queryWrittenAcks(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<AckWithMetadata[]> {
    let query = `write_acknowledgement.packet_connection='${connectionId}'`;
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintTxs(query);
    const out = search.txs.flatMap(({
      height, result, hash,
    }) => {
      const events = result.events.map(fromTendermintEvent);
      // const sender = logs.findAttribute(parsedLogs, 'message', 'sender').value;
      return parseAcksFromTxEvents(events).map(
        (ack): AckWithMetadata => ({
          height,
          txHash: toHex(hash).toUpperCase(),
          txEvents: events,
          ...ack,
        }),
      );
    });
    return out;
  }

  /**
   * Queries all written acknowledgements for an IBC v2 client within a height range.
   *
   * @param clientId - The client ID to query acknowledgements for
   * @param minHeight - Minimum block height (inclusive), undefined for no lower bound
   * @param maxHeight - Maximum block height (inclusive), undefined for no upper bound
   * @returns Array of v2 acknowledgements with metadata (height, hash, events)
   */
  public async queryWrittenAcksV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<AckV2WithMetadata[]> {
    // TODO: Get V2 acks from events
    let query = `write_acknowledgement.packet_dest_client='${clientId}'`;
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintTxs(query);
    const out = search.txs.flatMap(({
      height, result, hash,
    }) => {
      const events = result.events.map(fromTendermintEvent);
      // const sender = logs.findAttribute(parsedLogs, 'message', 'sender').value;
      return parseAcksFromTxEventsV2(events).map(
        (ack): AckV2WithMetadata => ({
          height,
          txHash: toHex(hash).toUpperCase(),
          txEvents: events,
          ...ack,
        }),
      );
    });
    return out;
  }

  /**
   * Queries which packet sequences have not been received on the destination for IBC v1.
   *
   * @param portId - The port ID
   * @param channelId - The channel ID
   * @param sequences - Array of packet sequences to check
   * @returns Array of sequence numbers that have not been received
   */
  public async queryUnreceivedPackets(portId: string, channelId: string, sequences: readonly number[]) {
    const res = await this.client.query.ibc.channel.unreceivedPackets(
      portId, channelId, sequences,
    );
    return res.sequences.map(seq => Number(seq));
  }

  /**
   * Queries which packet sequences have not been received on the destination for IBC v2.
   *
   * @param clientId - The client ID
   * @param sequences - Array of packet sequences to check
   * @returns Array of sequence numbers that have not been received
   */
  public async queryUnreceivedPacketsV2(clientId: string, sequences: readonly number[]) {
    const res = await this.client.query.ibc.channelV2.unreceivedPackets(
      clientId, sequences,
    );
    return res.sequences.map(seq => Number(seq));
  }

  /**
   * Queries the packet commitment for a specific sequence on IBC v1.
   *
   * @param portId - The port ID
   * @param channelId - The channel ID
   * @param sequence - The packet sequence number
   * @returns The packet commitment hash
   */
  public async queryCommitments(portId: string, channelId: string, sequence: bigint): Promise<Uint8Array> {
    const res = await this.client.query.ibc.channel.packetCommitment(
      portId, channelId, Number(sequence),
    );
    return res.commitment;
  }

  /**
   * Queries the packet commitment for a specific sequence on IBC v2.
   *
   * @param clientId - The client ID
   * @param sequence - The packet sequence number
   * @returns The packet commitment hash
   */
  public async queryCommitmentsV2(clientId: string, sequence: bigint): Promise<Uint8Array> {
    const res = await this.client.query.ibc.channelV2.packetCommitment(
      clientId, Number(sequence),
    );
    return res.commitment;
  }

  /**
   * Queries which acknowledgement sequences have not been received on the source for IBC v1.
   *
   * @param portId - The port ID
   * @param channelId - The channel ID
   * @param sequences - Array of acknowledgement sequences to check
   * @returns Array of sequence numbers that have not been received
   */
  public async queryUnreceivedAcks(portId: string, channelId: string, sequences: readonly number[]) {
    const res = await this.client.query.ibc.channel.unreceivedAcks(
      portId, channelId, sequences,
    );
    return res.sequences.map(seq => Number(seq));
  }

  /**
   * Queries which acknowledgement sequences have not been received on the source for IBC v2.
   *
   * @param clientId - The client ID
   * @param sequences - Array of acknowledgement sequences to check
   * @returns Array of sequence numbers that have not been received
   */
  public async queryUnreceivedAcksV2(clientId: string, sequences: readonly number[]) {
    const res = await this.client.query.ibc.channelV2.unreceivedAcks(
      clientId, sequences,
    );
    return res.sequences.map(seq => Number(seq));
  }

  /**
   * Gets packets from block events (begin_block/end_block) for IBC v1.
   *
   * @param connectionId - The connection ID to filter packets
   * @param minHeight - Minimum block height (inclusive), undefined for no lower bound
   * @param maxHeight - Maximum block height (inclusive), undefined for no upper bound
   * @returns Array of packets with metadata from block events
   */
  async getPacketsFromBlockEvents(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[]> {
    let query = `send_packet.packet_connection='${connectionId}'`;
    if (minHeight) {
      query = `${query} AND block.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND block.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintBlocks(query);
    const resultsNested = await Promise.all(
      search.blocks.map(async ({
        block,
      }) => {
        const height = block.header.height;
        const result = await this.getTendermintBlockResults(height);
        return parsePacketsFromBlockResult(result).map(packet => ({
          packet,
          height,
          sender: "",
        }));
      }),
    );

    return ([] as PacketWithMetadata[]).concat(...resultsNested);
  }

  /**
   * Gets packets from transaction events for IBC v1.
   *
   * @param connectionId - The connection ID to filter packets
   * @param minHeight - Minimum block height (inclusive), undefined for no lower bound
   * @param maxHeight - Maximum block height (inclusive), undefined for no upper bound
   * @returns Array of packets with metadata from transaction events
   */
  async getPacketsFromTxs(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[]> {
    let query = `send_packet.packet_connection='${connectionId}'`;
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintTxs(query);
    const resultsNested = search.txs.map(
      ({
        height, result,
      }): PacketWithMetadata[] =>
        parsePacketsFromTendermintEvents(result.events).map(packet => ({
          packet,
          height,
        })),
    );
    return resultsNested.flat();
  }

  /**
   * Gets packets from block events (begin_block/end_block) for IBC v2.
   *
   * @param clientId - The client ID to filter packets
   * @param minHeight - Minimum block height (inclusive), undefined for no lower bound
   * @param maxHeight - Maximum block height (inclusive), undefined for no upper bound
   * @returns Array of v2 packets with metadata from block events
   */
  async getPacketsFromBlockEventsV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketV2WithMetadata[]> {
    let query = `send_packet.packet_source_client='${clientId}'`;
    if (minHeight) {
      query = `${query} AND block.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND block.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintBlocks(query);
    const resultsNested = await Promise.all(
      search.blocks.map(async ({
        block,
      }) => {
        const height = block.header.height;
        const result = await this.getTendermintBlockResults(height);
        return parsePacketsFromBlockResultV2(result).map(packet => ({
          packet,
          height,
          sender: "",
        }));
      }),
    );

    return ([] as PacketV2WithMetadata[]).concat(...resultsNested);
  }

  /**
   * Gets packets from transaction events for IBC v2.
   *
   * @param clientId - The client ID to filter packets
   * @param minHeight - Minimum block height (inclusive), undefined for no lower bound
   * @param maxHeight - Maximum block height (inclusive), undefined for no upper bound
   * @returns Array of v2 packets with metadata from transaction events
   */
  async getPacketsFromTxsV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketV2WithMetadata[]> {
    let query = `send_packet.packet_source_client='${clientId}'`;
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintTxs(query);
    const resultsNested = search.txs.map(
      ({
        height, result,
      }): PacketV2WithMetadata[] =>
        parsePacketsFromTendermintEventsV2(result.events).map(packet => ({
          packet,
          height,
        })),
    );
    return resultsNested.flat();
  }

  /**
   * Gets the next sequence number expected to be received on a channel for IBC v1.
   *
   * @param portId - The port ID
   * @param channelId - The channel ID
   * @returns The next sequence number to be received
   * @throws Error if no next sequence is found
   */
  public async getNextSequenceRecv(portId: string, channelId: string): Promise<bigint> {
    const sequence = await this.client.query.ibc.channel.nextSequenceReceive(portId, channelId);
    this.client.logger.debug(`Next sequence receive for port ${portId} and channel ${channelId}`, sequence);
    if (!sequence) {
      throw new Error(`No next sequence receive found for port ${portId} and channel ${channelId}`);
    }
    return sequence.nextSequenceReceive;
  }
}
