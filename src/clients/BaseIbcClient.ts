import {
  Any,
} from "@atomone/cosmos-ibc-types/build/google/protobuf/any";
import {
  Order, Packet,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/channel";
import {
  Packet as PacketV2,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/packet";
import {
  Height,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/client";
import {
  QueryConnectionResponse,
} from "@atomone/cosmos-ibc-types/build/ibc/core/connection/v1/query";
import {
  ClientState as TendermintClientState, ConsensusState as TendermintConsensusState, Header as TendermintHeader,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/tendermint/v1/tendermint";
import {
  ReadonlyDateWithNanoseconds,
} from "@cosmjs/tendermint-rpc";
import * as winston from "winston";

import {
  Ack, AckV2, AckV2WithMetadata, AckWithMetadata, ChannelHandshakeProof, ChannelInfo, ClientType, ConnectionHandshakeProof, CreateChannelResult, CreateClientResult, CreateConnectionResult, DataProof, FullProof, MsgResult, PacketV2WithMetadata, PacketWithMetadata,
} from "../types";
import {
  decodeClientState, decodeConsensusState,
} from "../utils/utils";
import {
  TendermintIbcClient,
} from "./tendermint/IbcClient";

export type BaseIbcClientOptions = {
  chainId: string
  rpcEndpoint: string
  logger: winston.Logger
  senderAddress: string
  estimatedBlockTime: number
  estimatedIndexerTime: number
  revisionNumber?: bigint
  clientType: ClientType
};

export interface IbcClientTypes {
  header: unknown
  clientState: unknown
  consensusState: unknown
  clientArgs: unknown
  lightClientHeader: unknown
}

export function isTendermint(client: BaseIbcClient): client is TendermintIbcClient {
  return client.clientType === ClientType.Tendermint;
}
export function isTendermintClientState(clientState: ReturnType<typeof decodeClientState>): clientState is TendermintClientState {
  if ((clientState as TendermintClientState).chainId) {
    return true;
  }
  else {
    return false;
  }
}
export function isTendermintConsensusState(consensusState: ReturnType<typeof decodeConsensusState>): consensusState is TendermintConsensusState {
  if ((consensusState as TendermintConsensusState).nextValidatorsHash) {
    return true;
  }
  else {
    return false;
  }
}

/*
 *export function isGno(client: BaseIbcClient): client is GnoIbcClient {
 *  return client.clientType === ClientType.Gno;
 *}
 */
export abstract class BaseIbcClient<T extends IbcClientTypes = IbcClientTypes> {
  /**
     * The chain ID of the chain this client is connected to.
     */
  public readonly chainId: string;

  /**
     * The RPC endpoint of the chain this client is connected to.
     */
  public readonly rpcEndpoint: string;

  public readonly clientType: ClientType;

  public readonly estimatedBlockTime: number;

  public readonly estimatedIndexerTime: number;

  public readonly senderAddress: string;

  public logger: winston.Logger;

  public revisionNumber: bigint;

  public constructor(options: BaseIbcClientOptions) {
    this.chainId = options.chainId;
    this.clientType = options.clientType;
    this.rpcEndpoint = options.rpcEndpoint;
    this.logger = options.logger;
    this.estimatedBlockTime = options.estimatedBlockTime;
    this.estimatedIndexerTime = options.estimatedIndexerTime;
    this.senderAddress = options.senderAddress;
    this.revisionNumber = options.revisionNumber ?? 1n;
  }

  /*
     * This is the base class for all IBC clients.
     *
     * It provides the basic functionality that all IBC clients should implement.
     * It is not meant to be used directly, but rather extended by other classes.
     * Implementations of those classes should provide a type to provide as the gerneric type parameter T
     * to identify the specific types for the client, consensus state, header and client args.
     * It provides methods to create and manage IBC clients, connections, channels, and packets.
     * It also provides methods to query the state of the IBC clients, connections, channels, and packets.
     * It provides methods to handle the proofs and headers required for IBC operations.
     *
     * Important things to note:
     * - Each IBC client implementation must implement methods to create and manage light clients of all necessary types
     *   (e.g. Tendermint, Gno etc.)
     * - Similarly, those methods make use of helper methods that query the chain for necessary data.
     * - - For example, `getTendermintConsensusState` queries the chain for the consensus state of a Tendermint light client.
     * - - This makes use of getConsensusStateProof which implements thw ay to obtain the proof (be it ABCI query, a contract query etc).
     *
     * An attempt has been made to clean up the abstractions as much as possible but for ease of implementation where necessary,
     * the original Cosmos data structures have been used
     *
     */

  /* Basic helper methods for the connected chain (self-explantory) */

  abstract getChainId(): Promise<string>;
  abstract currentTime(): Promise<ReadonlyDateWithNanoseconds>;
  abstract currentHeight(): Promise<number>;
  abstract currentRevision(): Promise<Height>;
  abstract revisionHeight(height: number): Height;
  abstract ensureRevisionHeight(height: number | Height): Height;
  abstract timeoutHeight(blocksInFuture: number): Promise<Height>;
  abstract header(height: number): Promise<T["header"]>;
  abstract latestHeader(): Promise<T["header"]>;
  abstract waitOneBlock(): Promise<void>;
  abstract waitForIndexer(): Promise<void>;

  /* helper methods for specific clients on this chain */
  abstract getUnbondingPeriod(clientId: string): Promise<number>;

  /* Client creation and updating Txs */
  abstract createTendermintClient(clientState: TendermintClientState, consensusState: TendermintConsensusState): Promise<CreateClientResult>;
  abstract updateClient(clientId: string, src: BaseIbcClient): Promise<Height>;

  /*
     * TODO: ensure this abtracts properly regardless of src client type (e.g. Tendermint, Gno etc.)
     * It should identify the src client type and call the appropriate method to update the client from the ones below:
     */
  abstract updateTendermintClient(clientId: string, header: TendermintHeader): Promise<MsgResult>;

  /* Registering counterparty client for IBC v2 handshaking  Tx */
  abstract registerCounterParty(clientId: string, counterpartyClientId: string, merklePrefix: Uint8Array): Promise<MsgResult>;

  /* Connection and channel handling for IBC v1 handshaking Txs */
  abstract connOpenInit(clientId: string, remoteClientId: string): Promise<CreateConnectionResult>;
  abstract connOpenTry(clientId: string, proof: ConnectionHandshakeProof): Promise<CreateConnectionResult>;
  abstract connOpenAck(connectionId: string, proof: ConnectionHandshakeProof): Promise<MsgResult>;
  abstract connOpenConfirm(connectionId: string, proof: ConnectionHandshakeProof): Promise<MsgResult>;
  abstract channelOpenInit(portId: string, remotePortId: string, ordering: Order, connectionId: string, version: string): Promise<CreateChannelResult>;
  abstract channelOpenTry(portId: string, remote: ChannelInfo, ordering: Order, connectionId: string, version: string, counterpartyVersion: string, proof: ChannelHandshakeProof): Promise<CreateChannelResult>;
  abstract channelOpenAck(portId: string, channelId: string, counterpartyChannelId: string, counterpartyVersion: string, proof: ChannelHandshakeProof): Promise<MsgResult>;
  abstract channelOpenConfirm(portId: string, channelId: string, proof: ChannelHandshakeProof): Promise<MsgResult>;
  abstract getChannelHandshakeProof(portId: string, channelId: string, proofHeight: Height): Promise<ChannelHandshakeProof>;
  abstract getConnectionHandshakeProof(clientId: string, connectionId: string, proofHeight: Height): Promise<ConnectionHandshakeProof>;

  /*
     * Raw proof-fetching methods. These methods are used to fetch the raw proofs for various IBC operations in ICS23 format
     * e.g. for a Cosmos SDK chain they use ABCI queries
     * They return the proven value as a proto-encoded Any, the ICS23 proof as a Uint8Array and the proofHeight.
     */

  abstract getRawChannelProof(portId: string, channelId: string, proofHeight: Height): Promise<DataProof>;
  abstract getRawReceiptProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<DataProof>;
  abstract getRawPacketCommitmentProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<DataProof>;
  abstract getRawPacketAcknowledgementProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<DataProof>;

  abstract getRawReceiptProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof>;
  abstract getRawPacketCommitmentProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof>;
  abstract getRawPacketAcknowledgementProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof>;

  abstract getRawClientStateProof(clientId: string, proofHeight?: Height): Promise<FullProof>;
  abstract getRawConsensusStateProof(clientId: string, consensusHeight: Height, proofHeight?: Height): Promise<FullProof>;
  abstract getRawConnectionProof(connectionId: string, proofHeight: Height): Promise<FullProof>;

  /*
     * Helper proof methods. These methods wrap the raw proof-fetching methods for packet operations simplifying calls by ensuring
     * the appropriate proofHeight is used based on packet data.
     */
  abstract getPacketProof(packet: Packet, headerHeight: Height | number): Promise<DataProof>;
  abstract getAckProof(packet: Packet, headerHeight: Height | number): Promise<DataProof>;
  abstract getTimeoutProof(packet: Packet, headerHeight: Height | number): Promise<DataProof>;
  abstract getPacketProofV2(packet: PacketV2, headerHeight: Height | number): Promise<DataProof>;
  abstract getAckProofV2(packet: PacketV2, headerHeight: Height | number): Promise<DataProof>;
  abstract getTimeoutProofV2(packet: PacketV2, headerHeight: Height | number): Promise<DataProof>;

  /*
     * Methods to build the header or client creation data to provide to counterparty clients
     * Concrete return types to be provided by the specific client implementations
     */
  abstract buildHeader(lastHeight: number): Promise<T["lightClientHeader"]>;
  abstract buildCreateClientArgs(trustPeriodSec?: number | null,): Promise<T["clientArgs"]>;

  /*
     * Packet handling methods. Rceived/ack/timeout packets are handled by the relayer and sent to the chain.
     */
  abstract receivePackets(packets: readonly Packet[], proofCommitments: readonly Uint8Array[], proofHeight?: Height): Promise<MsgResult>;
  abstract receivePacketsV2(packets: readonly PacketV2[], proofCommitments: readonly Uint8Array[], proofHeight?: Height): Promise<MsgResult>;
  abstract acknowledgePackets(acks: readonly Ack[], proofAckeds: readonly Uint8Array[], proofHeight?: Height): Promise<MsgResult>;
  abstract acknowledgePacketsV2(acks: readonly AckV2[], proofAckeds: readonly Uint8Array[], proofHeight?: Height): Promise<MsgResult>;
  abstract timeoutPackets(packets: Packet[], proofsUnreceived: Uint8Array[], nextSequenceRecv: bigint[], proofHeight: Height): Promise<MsgResult>;
  abstract timeoutPacketsV2(packets: PacketV2[], proofsUnreceived: Uint8Array[], proofHeight: Height): Promise<MsgResult>;

  /*
     * Methods to query for sent or unreceived packets and acks for a specific connection.
     */

  abstract querySentPackets(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[]>;
  abstract queryWrittenAcks(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<AckWithMetadata[]>;
  abstract querySentPacketsV2(clientID: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketV2WithMetadata[]>;
  abstract queryWrittenAcksV2(clientID: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<AckV2WithMetadata[]>;
  abstract queryUnreceivedPackets(portId: string, channelId: string, sequences: readonly number[]): Promise<number[]>;
  abstract queryUnreceivedAcks(portId: string, channelId: string, sequences: readonly number[]): Promise<number[]>;
  abstract queryCommitments(portId: string, channelId: string, sequence: bigint): Promise<Uint8Array>;
  abstract queryUnreceivedPacketsV2(clientId: string, sequences: readonly number[]): Promise<number[]>;
  abstract queryUnreceivedAcksV2(clientId: string, sequences: readonly number[]): Promise<number[]>;
  abstract queryCommitmentsV2(clientId: string, sequence: bigint): Promise<Uint8Array>;

  /*
     * Methods to get basic IBC connection and client information.
     */
  abstract getConnection(connectionId: string): Promise<Partial<QueryConnectionResponse>>;
  abstract getCounterparty(clientId: string): Promise<string>;
  abstract getChannelV1Type(portId: string, channelId: string): Promise<Order>;
  abstract getLatestClientState(clientId: string): Promise<Any>;
  abstract getConsensusStateAtHeight(clientId: string, consensusHeight?: Height): Promise<Any>;
  abstract getNextSequenceRecv(portId: string, channelId: string): Promise<bigint>;
}
