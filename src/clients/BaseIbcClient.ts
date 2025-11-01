/* istanbul ignore file -- @preserve */
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
  return clientState != null && (clientState as TendermintClientState).chainId !== undefined;
}
export function isTendermintConsensusState(consensusState: ReturnType<typeof decodeConsensusState>): consensusState is TendermintConsensusState {
  return consensusState != null && (consensusState as TendermintConsensusState).nextValidatorsHash !== undefined;
}

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

  /**
   * Base class for all IBC clients across different chain types.
   *
   * Provides the core functionality that all IBC client implementations must provide,
   * including client management, connection/channel handshakes, packet relay, and proof queries.
   *
   * This class uses TypeScript generics to maintain type safety across different light client types.
   * Implementations should provide specific types for headers, client states, consensus states, etc.
   *
   * @template T - IbcClientTypes defining header, clientState, consensusState, clientArgs, and lightClientHeader types
   *
   * @remarks
   * Key responsibilities:
   * - Create and update light clients on the connected chain
   * - Perform connection and channel handshakes (IBC v1)
   * - Register counterparty clients (IBC v2)
   * - Relay packets, acknowledgements, and timeouts
   * - Generate and verify ICS23 proofs
   * - Query chain state and events
   *
   * @example
   * ```typescript
   * // Extend for a specific chain type
   * class TendermintIbcClient extends BaseIbcClient<TendermintIbcClientTypes> {
   *   // Implement abstract methods
   * }
   * ```
   */

  /* ========== Basic Chain Information Methods ========== */

  /**
   * Gets the chain ID of the connected chain.
   * @returns The chain identifier (e.g., "cosmoshub-4", "osmosis-1")
   */
  abstract getChainId(): Promise<string>;

  /**
   * Gets the current block time of the connected chain.
   * @returns Current timestamp with nanosecond precision
   */
  abstract currentTime(): Promise<ReadonlyDateWithNanoseconds>;

  /**
   * Gets the current block height of the connected chain.
   * @returns Current block height as a number
   */
  abstract currentHeight(): Promise<number>;

  /**
   * Gets the current height with revision information.
   * @returns Height object with revisionNumber and revisionHeight
   */
  abstract currentRevision(): Promise<Height>;

  /**
   * Creates a Height object from a block number using this chain's revision number.
   * @param height - Block height number
   * @returns Height object with this chain's revision number
   */
  abstract revisionHeight(height: number): Height;

  /**
   * Ensures a height value includes the correct revision number for this chain.
   * @param height - Height as number or Height object
   * @returns Height object with verified revision number
   * @throws Error if provided Height has wrong revision number
   */
  abstract ensureRevisionHeight(height: number | Height): Height;

  /**
   * Calculates a future timeout height.
   * @param blocksInFuture - Number of blocks in the future
   * @returns Height object representing the timeout
   */
  abstract timeoutHeight(blocksInFuture: number): Promise<Height>;

  /**
   * Gets the block header at a specific height.
   * @param height - Block height to query
   * @returns Block header (type depends on chain implementation)
   */
  abstract header(height: number): Promise<T["header"]>;

  /**
   * Gets the latest block header.
   * @returns Latest block header
   */
  abstract latestHeader(): Promise<T["header"]>;

  /**
   * Waits for one block to be produced on the chain.
   * Used to ensure proofs are available after transactions.
   */
  abstract waitOneBlock(): Promise<void>;

  /**
   * Waits for the indexer to process recent transactions.
   * Used before querying for newly committed data.
   */
  abstract waitForIndexer(): Promise<void>;

  /* ========== Light Client Management ========== */

  /**
   * Gets the unbonding period for a specific client.
   * @param clientId - The client identifier
   * @returns Unbonding period in seconds
   */
  abstract getUnbondingPeriod(clientId: string): Promise<number>;

  /* ========== Client Creation and Updates ========== */

  /**
   * Creates a new Tendermint light client on this chain.
   *
   * @param clientState - The client state for the new light client
   * @param consensusState - The consensus state for the new light client
   * @returns Result including the generated client ID
   * @throws Error if client creation transaction fails
   *
   * @example
   * ```typescript
   * const { clientId } = await client.createTendermintClient(
   *   clientState,
   *   consensusState
   * );
   * console.log(`Created client: ${clientId}`);
   * ```
   */
  abstract createTendermintClient(clientState: TendermintClientState, consensusState: TendermintConsensusState): Promise<CreateClientResult>;

  /**
   * Updates an existing light client with latest state from source chain.
   *
   * @param clientId - The client identifier to update
   * @param src - The source chain client to fetch latest state from
   * @returns The height that was updated to
   * @throws Error if update fails or client is expired
   *
   * @example
   * ```typescript
   * // Update client on chain B with latest from chain A
   * const height = await clientB.updateClient("07-tendermint-0", clientA);
   * ```
   */
  abstract updateClient(clientId: string, src: BaseIbcClient): Promise<Height>;

  /**
   * Updates a Tendermint light client with a specific header.
   *
   * @param clientId - The client identifier to update
   * @param header - The Tendermint header to update with
   * @returns Transaction result
   * @throws Error if update transaction fails
   *
   * @todo Ensure this abstracts properly for different client types (Tendermint, Gno, etc.)
   */
  abstract updateTendermintClient(clientId: string, header: TendermintHeader): Promise<MsgResult>;

  /**
   * Registers a counterparty client for IBC v2 handshaking.
   *
   * @param clientId - The local client identifier
   * @param counterpartyClientId - The client ID on the counterparty chain
   * @param merklePrefix - The merkle path prefix for the counterparty
   * @returns Transaction result
   * @throws Error if registration transaction fails
   *
   * @example
   * ```typescript
   * await client.registerCounterParty(
   *   "07-tendermint-0",
   *   "07-tendermint-1",
   *   Buffer.from("ibc", "utf-8")
   * );
   * ```
   */
  abstract registerCounterParty(clientId: string, counterpartyClientId: string, merklePrefix: Uint8Array): Promise<MsgResult>;

  /* ========== Connection Handshake (IBC v1) ========== */

  /**
   * Initiates a new connection (IBC v1 ConnOpenInit).
   * @param clientId - Local client ID
   * @param remoteClientId - Client ID on remote chain
   * @returns Result including the generated connection ID
   */
  abstract connOpenInit(clientId: string, remoteClientId: string): Promise<CreateConnectionResult>;

  /**
   * Responds to connection init (IBC v1 ConnOpenTry).
   * @param clientId - Local client ID
   * @param proof - Connection handshake proof from remote chain
   * @returns Result including the generated connection ID
   */
  abstract connOpenTry(clientId: string, proof: ConnectionHandshakeProof): Promise<CreateConnectionResult>;

  /**
   * Acknowledges connection try (IBC v1 ConnOpenAck).
   * @param connectionId - Local connection ID
   * @param proof - Connection handshake proof from remote chain
   * @returns Transaction result
   */
  abstract connOpenAck(connectionId: string, proof: ConnectionHandshakeProof): Promise<MsgResult>;

  /**
   * Confirms connection open (IBC v1 ConnOpenConfirm).
   * @param connectionId - Local connection ID
   * @param proof - Connection handshake proof from remote chain
   * @returns Transaction result
   */
  abstract connOpenConfirm(connectionId: string, proof: ConnectionHandshakeProof): Promise<MsgResult>;

  /* ========== Channel Handshake (IBC v1) ========== */

  /**
   * Initiates a new channel (IBC v1 ChanOpenInit).
   */
  abstract channelOpenInit(portId: string, remotePortId: string, ordering: Order, connectionId: string, version: string): Promise<CreateChannelResult>;

  /**
   * Responds to channel init (IBC v1 ChanOpenTry).
   */
  abstract channelOpenTry(portId: string, remote: ChannelInfo, ordering: Order, connectionId: string, version: string, counterpartyVersion: string, proof: ChannelHandshakeProof): Promise<CreateChannelResult>;

  /**
   * Acknowledges channel try (IBC v1 ChanOpenAck).
   */
  abstract channelOpenAck(portId: string, channelId: string, counterpartyChannelId: string, counterpartyVersion: string, proof: ChannelHandshakeProof): Promise<MsgResult>;

  /**
   * Confirms channel open (IBC v1 ChanOpenConfirm).
   */
  abstract channelOpenConfirm(portId: string, channelId: string, proof: ChannelHandshakeProof): Promise<MsgResult>;

  /**
   * Gets proof for channel handshake.
   */
  abstract getChannelHandshakeProof(portId: string, channelId: string, proofHeight: Height): Promise<ChannelHandshakeProof>;

  /**
   * Gets proof for connection handshake.
   */
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
