import { Event } from "@cosmjs/stargate";
import { comet38, tendermint34, tendermint37 } from "@cosmjs/tendermint-rpc";
import { Any } from "cosmjs-types/google/protobuf/any";
import { Packet } from "cosmjs-types/ibc/core/channel/v1/channel";
import { Height } from "cosmjs-types/ibc/core/client/v1/client";
import { ClientState as TendermintClientState, ConsensusState as TendermintConsensusState } from "cosmjs-types/ibc/lightclients/tendermint/v1/tendermint";

export enum ChainType {
    Cosmos = "cosmos",
    Ethereum = "ethereum",
    Gno = "gno",
}
export interface RelayPaths {
    id: number;
    chainIdA: string;
    nodeA: string;
    chainIdB: string;
    nodeB: string;
    chainTypeA: ChainType;
    chainTypeB: ChainType;
    clientA: string;
    clientB: string;
    version: number;
}
export interface RelayedHeights {
    id: number;
    relayPathId: number;
    relayHeightA: number;
    relayHeightB: number;
    ackHeightA: number;
    ackHeightB: number;
}

export interface ConnectionHandshakeProof {
  clientId: string;
  connectionId: string;
  clientState?: Any;
  proofHeight: Height;
  // proof of the state of the connection on remote chain
  proofConnection: Uint8Array;
  // proof of client state included in message
  proofClient: Uint8Array;
  // proof of client consensus state
  proofConsensus: Uint8Array;
  // last header height of this chain known by the remote chain
  consensusHeight?: Height;
}

export interface MsgResult {
  readonly events: readonly Event[];
  /** Transaction hash (might be used as transaction ID). Guaranteed to be non-empty upper-case hex */
  readonly transactionHash: string;
  /** block height where this transaction was committed - only set if we send 'block' mode */
  readonly height: number;
}

export type CreateClientResult = MsgResult & {
  readonly clientId: string;
};

export type CreateConnectionResult = MsgResult & {
  readonly connectionId: string;
};

export type CreateChannelResult = MsgResult & {
  readonly channelId: string;
};

export interface ChannelHandshake {
  id: ChannelInfo;
  proofHeight: Height;
  // proof of the state of the channel on remote chain
  proof: Uint8Array;
}
export interface Ack {
  readonly acknowledgement: Uint8Array;
  readonly originalPacket: Packet;
}
export interface ChannelInfo {
  readonly portId: string;
  readonly channelId: string;
}
export type CometHeader = tendermint34.Header | tendermint37.Header | comet38.Header;
export type CometCommitResponse =
  | tendermint34.CommitResponse
  | tendermint37.CommitResponse
  | comet38.CommitResponse;
export type BlockSearchResponse = 
  | tendermint34.BlockSearchResponse
  | tendermint37.BlockSearchResponse
  | comet38.BlockSearchResponse;
export interface CreateClientArgs {
  clientState: TendermintClientState;
  consensusState: TendermintConsensusState;
}  

export interface PacketWithMetadata {
  packet: Packet;
  // block it was in, must query proofs >= height
  height: number;
}

export type AckWithMetadata = Ack & {
  // block the ack was in, must query proofs >= height
  height: number;
  /**
   * The hash of the transaction in which the ack was found.
   * Encoded as upper case hex.
   */
  txHash: string;
  /**
   * The events of the transaction in which the ack was found.
   * Please note that the events do not necessarily belong to the ack.
   */
  txEvents: readonly Event[];
};