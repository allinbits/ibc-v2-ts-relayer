import {
  Any,
} from "@atomone/cosmos-ibc-types/google/protobuf/any.js";
import {
  Packet,
} from "@atomone/cosmos-ibc-types/ibc/core/channel/v1/channel.js";
import {
  Packet as PacketV2,
} from "@atomone/cosmos-ibc-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/cosmos-ibc-types/ibc/core/client/v1/client.js";
import {
  ClientState as TendermintClientState, ConsensusState as TendermintConsensusState,
} from "@atomone/cosmos-ibc-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  ProofOps,
} from "@atomone/cosmos-ibc-types/tendermint/crypto/proof.js";
import {
  Event,
} from "@cosmjs/stargate";
import {
  comet38, tendermint34, tendermint37,
} from "@cosmjs/tendermint-rpc";
import {
  ibc,
} from "@gnolang/gno-types";

export enum ChainType {
  Cosmos = "cosmos",
  Ethereum = "ethereum",
  Gno = "gno",
}
export type AnyClientState = TendermintClientState | ibc.lightclients.gno.v1.gno.ClientState;
export type AnyConsensusState = TendermintConsensusState | ibc.lightclients.gno.v1.gno.ConsensusState;
export interface RelayPaths {
  id: number
  chainIdA: string
  nodeA: string
  chainIdB: string
  nodeB: string
  chainTypeA: ChainType
  chainTypeB: ChainType
  clientA: string
  clientB: string
  version: number
}
export interface ChainFees {
  id: number
  chainId: string
  gasPrice: number
  gasDenom: string
}
export interface RelayedHeights {
  id: number
  relayPathId: number
  packetHeightA: number
  packetHeightB: number
  ackHeightA: number
  ackHeightB: number
}

export interface ConnectionHandshakeProof {
  clientId: string
  connectionId: string
  clientState?: Any
  proofHeight: Height
  // proof of the state of the connection on remote chain
  proofConnection: Uint8Array
  // proof of client state included in message
  proofClient: Uint8Array
  // proof of client consensus state
  proofConsensus: Uint8Array
  // last header height of this chain known by the remote chain
  consensusHeight?: Height
}

export interface MsgResult {
  readonly events: readonly Event[]

  /** Transaction hash (might be used as transaction ID). Guaranteed to be non-empty upper-case hex */
  readonly transactionHash: string

  /** block height where this transaction was committed - only set if we send 'block' mode */
  readonly height: number
}

export type CreateClientResult = MsgResult & {
  readonly clientId: string
};

export type CreateConnectionResult = MsgResult & {
  readonly connectionId: string
};

export type CreateChannelResult = MsgResult & {
  readonly channelId: string
};

export interface ChannelHandshakeProof {
  id: ChannelInfo
  proofHeight: Height
  // proof of the state of the channel on remote chain
  proof: Uint8Array
}
export interface Ack {
  readonly acknowledgement: Uint8Array
  readonly originalPacket: Packet
}
export interface AckV2 {
  readonly acknowledgement: Uint8Array
  readonly originalPacket: PacketV2
}
export interface ChannelInfo {
  readonly portId: string
  readonly channelId: string
}
export type CometHeader = tendermint34.Header | tendermint37.Header | comet38.Header;
export type CometCommitResponse
  = | tendermint34.CommitResponse
    | tendermint37.CommitResponse
    | comet38.CommitResponse;
export type BlockSearchResponse
  = | tendermint34.BlockSearchResponse
    | tendermint37.BlockSearchResponse
    | comet38.BlockSearchResponse;
export type TxSearchResponse
  = | tendermint34.TxSearchResponse
    | tendermint37.TxSearchResponse
    | comet38.TxSearchResponse;
export type BlockResultsResponse
  = | tendermint34.BlockResultsResponse
    | tendermint37.BlockResultsResponse
    | comet38.BlockResultsResponse;
export interface CreateClientArgs {
  clientState: TendermintClientState | ibc.lightclients.gno.v1.gno.ClientState
  consensusState: TendermintConsensusState | ibc.lightclients.gno.v1.gno.ConsensusState
}

export enum ClientType {
  Tendermint = "tendermint",
  Gno = "gno",
  Ethereum = "ethereum",
}
export interface PacketWithMetadata {
  packet: Packet
  // block it was in, must query proofs >= height
  height: number
}

export interface PacketV2WithMetadata {
  packet: PacketV2
  // block it was in, must query proofs >= height
  height: number
}

export type AckWithMetadata = Ack & {
  // block the ack was in, must query proofs >= height
  height: number

  /**
     * The hash of the transaction in which the ack was found.
     * Encoded as upper case hex.
     */
  txHash: string

  /**
     * The events of the transaction in which the ack was found.
     * Please note that the events do not necessarily belong to the ack.
     */
  txEvents: readonly Event[]
};

export type AckV2WithMetadata = AckV2 & {
  // block the ack was in, must query proofs >= height
  height: number

  /**
     * The hash of the transaction in which the ack was found.
     * Encoded as upper case hex.
     */
  txHash: string

  /**
     * The events of the transaction in which the ack was found.
     * Please note that the events do not necessarily belong to the ack.
     */
  txEvents: readonly Event[]
};
export interface ProvenQuery {
  readonly key: Uint8Array
  readonly value: Uint8Array
  readonly proof: ProofOps
  readonly height: number
}
export interface FullProof {
  data: Any
  proof: Uint8Array
  proofHeight: Height
}
export interface DataProof {
  data: Uint8Array
  proof: Uint8Array
  proofHeight: Height
}
export interface QueryOpts {
  minHeight?: number
  maxHeight?: number
}
