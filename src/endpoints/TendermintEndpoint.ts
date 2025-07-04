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

  public async querySentPackets(minHeight: number | undefined, maxHeight: number | undefined) {

    return await this.client.querySentPackets(this.connectionID,minHeight, maxHeight);

  }
  public async queryWrittenAcks(minHeight: number | undefined, maxHeight: number | undefined) {

    return await this.client.queryWrittenAcks(this.connectionID,minHeight, maxHeight);

  }

}

