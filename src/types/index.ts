import {
  Any,
} from "@atomone/atomone-types/google/protobuf/any.js";
import {
  Packet,
} from "@atomone/atomone-types/ibc/core/channel/v1/channel.js";
import {
  Packet as PacketV2,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";
import {
  ClientState as TendermintClientState, ConsensusState as TendermintConsensusState,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  ProofOps,
} from "@atomone/atomone-types/tendermint/crypto/proof.js";
import {
  Event,
} from "@cosmjs/stargate";
import {
  comet38, tendermint37,
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
  queryNodeA?: string
  chainIdB: string
  nodeB: string
  queryNodeB?: string
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
  gasAdjustment: number
}
export interface RelayedHeights {
  id: number
  relayPathId: number
  packetHeightA: number
  packetHeightB: number
  ackHeightA: number
  ackHeightB: number
}

/** Which end of a relay path a record refers to. */
export type PathSide = "A" | "B";

export enum MisbehaviourStatus {
  /** Detected by the monitor, waiting for the relayer to submit it. */
  Pending = "pending",
  /** Recorded by a monitor running in dry-run mode; never submitted. */
  DryRun = "dry_run",
  /** The relayer submitted evidence and the client is now frozen. */
  Confirmed = "confirmed",
  /** Submission failed permanently (see `error`). */
  Failed = "failed",
}

export enum MisbehaviourKind {
  /** A stored consensus state disagrees with the source chain's own header. */
  Fork = "fork",
  /** A stored consensus state matches the header except for its timestamp. */
  Time = "time",
}

/**
 * Misbehaviour detected by the monitor on the client that `side`'s chain uses
 * to track its counterparty. The relayer picks up pending records and submits
 * the evidence.
 */
export interface MisbehaviourEvidence {
  id: number
  relayPathId: number
  side: PathSide
  hostChainId: string
  clientId: string
  revisionNumber: number
  /** Height of the consensus state that conflicts with the source chain. */
  revisionHeight: number
  /** Highest consensus height below the conflict that the monitor verified. */
  trustedRevisionHeight: number
  kind: MisbehaviourKind
  /** Base64 protobuf of the offending header, when it could be recovered. */
  conflictingHeader: string | null
  conflictingHeaderTypeUrl: string | null
  status: MisbehaviourStatus
  attempts: number
  txHash: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export type NewMisbehaviourEvidence = Omit<MisbehaviourEvidence, "id" | "status" | "attempts" | "txHash" | "error" | "createdAt" | "updatedAt"> & {
  status: MisbehaviourStatus.Pending | MisbehaviourStatus.DryRun
};

export type MisbehaviourEvidenceUpdate = Partial<Pick<MisbehaviourEvidence, "status" | "attempts" | "txHash" | "error">>;

/** Light client status, as reported by ibc-go and the Gno IBC core realm. */
export enum ClientStatus {
  Active = "Active",
  Frozen = "Frozen",
  Expired = "Expired",
  Unknown = "Unknown",
  Unauthorized = "Unauthorized",
}

/**
 * The fields of a stored consensus state that the monitor compares with the
 * source chain's header at the same height.
 */
export interface ConsensusStateSummary {
  revisionNumber: bigint
  revisionHeight: bigint
  /** Nanoseconds since the Unix epoch. */
  timestampNanos: bigint
  /** The Gno realm renders timestamps in whole seconds only. */
  timestampPrecision: "nanoseconds" | "seconds"
  root: Uint8Array
  nextValidatorsHash: Uint8Array
}

/** The header fields a light client derives its consensus state from. */
export interface HeaderSummary {
  height: number
  /** Nanoseconds since the Unix epoch. */
  timestampNanos: bigint
  appHash: Uint8Array
  nextValidatorsHash: Uint8Array
}

/** Highest consensus height the monitor has checked on one side of a path. */
export interface MonitorCursor {
  id: number
  relayPathId: number
  side: PathSide
  lastCheckedRevisionHeight: number
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
export type CometHeader = tendermint37.Header | comet38.Header;
export type CometCommitResponse
  = | tendermint37.CommitResponse
    | comet38.CommitResponse;
export type BlockSearchResponse
  = | tendermint37.BlockSearchResponse
    | comet38.BlockSearchResponse;
export type TxSearchResponse
  = | tendermint37.TxSearchResponse
    | comet38.TxSearchResponse;
export type BlockResultsResponse
  = | tendermint37.BlockResultsResponse
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
