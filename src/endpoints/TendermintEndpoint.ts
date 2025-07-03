import { toHex } from "@cosmjs/encoding";
import { fromTendermintEvent } from "@cosmjs/stargate";

import { BaseIbcClient } from "../clients/BaseIbcClient";
import { AckWithMetadata,PacketWithMetadata } from "../types";
import { parseAcksFromTxEvents, parsePacketsFromBlockResult, parsePacketsFromTendermintEvents } from "../utils/utils";
import { BaseEndpoint } from "./BaseEndpoint";

export class TendermintEndpoint extends BaseEndpoint {

  public constructor(
    client: BaseIbcClient,
    clientID: string,
    connectionID: string,
  ) {
    super(client, clientID, connectionID);
  }

  public chainId(): string {
    return this.client.chainId;
  }

  public getLatestCommit() {
    return this.client.getTendermintCommit();
  }
  protected async getPacketsFromBlockEvents(minHeight: number | undefined, maxHeight: number | undefined) {
    let query = `send_packet.packet_connection='${this.connectionID}'`;
    if (minHeight) {
      query = `${query} AND block.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND block.height<=${maxHeight}`;
    }

    const search = await this.client.searchTendermintBlocks(query);
    const resultsNested = await Promise.all(
      search.blocks.map(async ({ block }) => {
        const height = block.header.height;
        const result = await this.client.getTendermintBlockResults(height);
        return parsePacketsFromBlockResult(result).map((packet) => ({
          packet,
          height,
          sender: "",
        }));
      }),
    );

    return ([] as PacketWithMetadata[]).concat(...resultsNested);
  }
  protected async getPacketsFromTxs(minHeight: number | undefined, maxHeight: number | undefined) {

    let query = `send_packet.packet_connection='${this.connectionID}'`;
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.client.searchTendermintTxs(query);
    const resultsNested = search.txs.map(
      ({ height, result }): PacketWithMetadata[] =>
        parsePacketsFromTendermintEvents(result.events).map((packet) => ({
          packet,
          height,
        })),
    );
    return resultsNested.flat();
  }
  public async querySentPackets(minHeight: number | undefined, maxHeight: number | undefined) {

    const txsPackets = await this.getPacketsFromTxs(minHeight, maxHeight);
    const eventsPackets = await this.getPacketsFromBlockEvents(minHeight, maxHeight);
    return ([] as PacketWithMetadata[])
      .concat(...txsPackets)
      .concat(...eventsPackets);
  }
  public async queryWrittenAcks(minHeight: number | undefined, maxHeight: number | undefined) {

    let query = `write_acknowledgement.packet_connection='${this.connectionID}'`;
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.client.searchTendermintTxs( query );
    const out = search.txs.flatMap(({ height, result, hash }) => {
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

}

