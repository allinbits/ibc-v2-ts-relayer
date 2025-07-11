/* istanbul ignore file -- @preserve */
import {
  BaseIbcClient,
} from "../clients/BaseIbcClient";
import {
  AckV2WithMetadata, AckWithMetadata, PacketV2WithMetadata, PacketWithMetadata,
} from "../types";

export abstract class BaseEndpoint {
  public readonly client: BaseIbcClient;

  public readonly clientID: string;

  public readonly connectionID: string | undefined;

  public readonly version: 1 | 2 = 1; // Default to version 1 for compatibility

  public constructor(
    client: BaseIbcClient,
    clientID: string,
    connectionID?: string,
  ) {
    this.client = client;
    this.clientID = clientID;
    if (connectionID) {
      this.connectionID = connectionID;
    }
    else {
      this.version = 2;
    }
  }

  abstract chainId(): string;
  abstract querySentPackets(minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[] | PacketV2WithMetadata[]>;
  abstract queryWrittenAcks(minHeight: number | undefined, maxHeight: number | undefined): Promise<AckWithMetadata[] | AckV2WithMetadata[]>;
}
