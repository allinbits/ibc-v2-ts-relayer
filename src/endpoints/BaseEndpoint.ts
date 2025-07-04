import { CommitResponse } from "@cosmjs/tendermint-rpc";

import { BaseIbcClient } from "../clients/BaseIbcClient";
import { AckWithMetadata, ClientType, PacketWithMetadata } from "../types";

export abstract class BaseEndpoint {
  public readonly client: BaseIbcClient;
  public readonly clientID: string;
  public readonly connectionID: string;

  public constructor(
    client: BaseIbcClient,
    clientID: string,
    connectionID: string,
  ) {
    this.client = client;
    this.clientID = clientID;
    this.connectionID = connectionID;
  }
  
  abstract chainId(): string;
  abstract querySentPackets(minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[]>;
  abstract queryWrittenAcks(minHeight: number | undefined, maxHeight: number | undefined): Promise<AckWithMetadata[]>
}