import {
  BaseIbcClient,
} from "../clients/BaseIbcClient.js";
import {
  BaseEndpoint,
} from "./BaseEndpoint.js";

export class TendermintEndpoint extends BaseEndpoint {
  public constructor(
    client: BaseIbcClient,
    clientID: string,
    connectionID?: string,
  ) {
    super(client, clientID, connectionID);
  }

  public chainId(): string {
    return this.client.chainId;
  }

  public async querySentPackets(minHeight: number | undefined, maxHeight: number | undefined) {
    if (this.version === 1 && this.connectionID) {
      return await this.client.querySentPackets(this.connectionID, minHeight, maxHeight);
    }
    else {
      return await this.client.querySentPacketsV2(this.clientID, minHeight, maxHeight);
    }
  }

  public async queryWrittenAcks(minHeight: number | undefined, maxHeight: number | undefined) {
    if (this.version === 1 && this.connectionID) {
      return await this.client.queryWrittenAcks(this.connectionID, minHeight, maxHeight);
    }
    else {
      return await this.client.queryWrittenAcksV2(this.clientID, minHeight, maxHeight);
    }
  }
}
