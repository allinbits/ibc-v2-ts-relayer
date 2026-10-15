import {
  Any,
} from "@atomone/atomone-types/google/protobuf/any.js";
import {
  Order, Packet,
} from "@atomone/atomone-types/ibc/core/channel/v1/channel.js";
import {
  Packet as PacketV2,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";
import {
  QueryConnectionResponse,
} from "@atomone/atomone-types/ibc/core/connection/v1/query.js";
import {
  ClientState as TendermintClientState, ConsensusState as TendermintConsensusState, Header as TendermintHeader,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  ReadonlyDateWithNanoseconds,
} from "@cosmjs/tendermint-rpc";
import {
  ibc,
} from "@gnolang/gno-types";
import {
  Account, createPublicClient, createWalletClient, http, HttpTransport, PublicClient, WalletClient,
} from "viem";
import * as winston from "winston";

import {
  Ack, AckV2, AckV2WithMetadata, AckWithMetadata, AnyClientState, AnyConsensusState, ChannelHandshakeProof, ChannelInfo, ClientStatus, ClientType, ConnectionHandshakeProof, ConsensusStateSummary, CreateChannelResult, CreateClientResult, CreateConnectionResult, DataProof, FullProof, HeaderSummary, MsgResult, PacketV2WithMetadata, PacketWithMetadata,
} from "../../types/index.js";
import {
  BaseIbcClient,
} from "../BaseIbcClient.js";
import {
  BeaconClient,
} from "./beacon.js";
import * as host from "./host.js";
import * as source from "./source.js";
import {
  EthereumChainConfig, EthereumClientState, EthereumConsensusState, EthereumHeader, EthereumLightClientHeader,
} from "./types.js";

export interface EthereumIbcClientTypes {
  header: EthereumHeader
  clientState: EthereumClientState
  consensusState: EthereumConsensusState
  lightClientHeader: EthereumLightClientHeader
}

export interface EthereumIbcClientOptions {
  logger: winston.Logger
  /** Milliseconds between blocks; 12s slots by default. */
  estimatedBlockTime?: number
}

const NOT_ON_ETHEREUM = "IBC v1 is not supported on Ethereum";

export type EthereumPublicClient = PublicClient<HttpTransport>;
export type EthereumWalletClient = WalletClient<HttpTransport, undefined, Account>;

// viem's types assume strict mode, which this repo does not enable: without
// strictNullChecks its inferred client types do not line up, so they are
// cast to the declared ones here, in one place.
function newPublicClient(url: string): EthereumPublicClient {
  return createPublicClient({
    transport: http(url),
  }) as unknown as EthereumPublicClient;
}

function newWalletClient(account: Account, url: string): EthereumWalletClient {
  return createWalletClient({
    account,
    transport: http(url),
  }) as unknown as EthereumWalletClient;
}

/**
 * An Ethereum chain running the solidity-ibc-eureka ICS26 router.
 *
 * As a source, it builds sync-committee updates (from a beacon node) and
 * storage proofs (eth_getProof at finalized blocks) for the Ethereum light
 * client on gno.land: see source.ts. Heights on this side are beacon slots.
 *
 * As a host, it keeps GnoLightClient contracts behind the router and relays
 * packets to it: see host.ts.
 */
export class EthereumIbcClient extends BaseIbcClient<EthereumIbcClientTypes> {
  public readonly publicClient: EthereumPublicClient;
  /** Serves eth_getProof at finalized blocks. */
  public readonly proofClient: EthereumPublicClient;
  public readonly walletClient: EthereumWalletClient;
  public readonly account: Account;
  public readonly beacon: BeaconClient;
  public readonly config: EthereumChainConfig;
  /**
   * GnoLightClient contracts this relayer deployed with createGnoClient that
   * still wait for registerCounterParty to add them to the router, by the
   * client id the router will assign.
   */
  public readonly pendingClients = new Map<string, `0x${string}`>();

  private constructor(
    chainId: string,
    rpcEndpoint: string,
    account: Account,
    config: EthereumChainConfig,
    options: EthereumIbcClientOptions,
  ) {
    super({
      chainId,
      rpcEndpoint,
      logger: options.logger,
      senderAddress: account.address,
      estimatedBlockTime: options.estimatedBlockTime ?? 12000,
      estimatedIndexerTime: 0,
      revisionNumber: 0n,
      clientType: ClientType.Ethereum,
    });
    this.account = account;
    this.config = config;
    this.publicClient = newPublicClient(rpcEndpoint);
    this.proofClient = newPublicClient(config.proofRpc ?? rpcEndpoint);
    this.walletClient = newWalletClient(account, rpcEndpoint);
    this.beacon = new BeaconClient(config.beacon);
  }

  public static async connectWithSigner(
    rpcEndpoint: string,
    account: Account,
    config: EthereumChainConfig,
    options: EthereumIbcClientOptions,
  ): Promise<EthereumIbcClient> {
    const chainId = await newPublicClient(rpcEndpoint).getChainId();
    return new EthereumIbcClient(chainId.toString(), rpcEndpoint, account, config, options);
  }

  public revisionHeight(height: number): Height {
    return Height.fromPartial({
      revisionNumber: this.revisionNumber,
      revisionHeight: BigInt(height),
    });
  }

  public ensureRevisionHeight(height: number | Height): Height {
    if (typeof height === "number") {
      return this.revisionHeight(height);
    }
    if (height.revisionNumber !== this.revisionNumber) {
      throw new Error(`Using incorrect revisionNumber ${height.revisionNumber} on chain with ${this.revisionNumber}`);
    }
    return height;
  }

  public disconnect(): void {
    // HTTP transports hold no connection.
  }

  // --- Ethereum as a source: source.ts ---

  public async getChainId(): Promise<string> {
    return source.getChainId(this);
  }

  public async currentTime(): Promise<ReadonlyDateWithNanoseconds> {
    return source.currentTime(this);
  }

  public async currentHeight(): Promise<number> {
    return source.currentHeight(this);
  }

  public async currentRevision(): Promise<Height> {
    return source.currentRevision(this);
  }

  public async timeoutHeight(blocksInFuture: number): Promise<Height> {
    return source.timeoutHeight(this, blocksInFuture);
  }

  public async header(height: number): Promise<EthereumHeader> {
    return source.header(this, height);
  }

  public async latestHeader(): Promise<EthereumHeader> {
    return source.latestHeader(this);
  }

  public async waitOneBlock(): Promise<void> {
    return source.waitOneBlock(this);
  }

  public async waitForIndexer(): Promise<void> {
    return source.waitForIndexer(this);
  }

  public async getRawReceiptProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    return source.getRawReceiptProofV2(this, clientId, sequence, proofHeight);
  }

  public async getRawPacketCommitmentProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    return source.getRawPacketCommitmentProofV2(this, clientId, sequence, proofHeight);
  }

  public async getRawPacketAcknowledgementProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    return source.getRawPacketAcknowledgementProofV2(this, clientId, sequence, proofHeight);
  }

  public async getPacketProofV2(packet: PacketV2, headerHeight: Height | number): Promise<DataProof> {
    return source.getPacketProofV2(this, packet, headerHeight);
  }

  public async getAckProofV2(packet: PacketV2, headerHeight: Height | number): Promise<DataProof> {
    return source.getAckProofV2(this, packet, headerHeight);
  }

  public async getTimeoutProofV2(packet: PacketV2, headerHeight: Height | number): Promise<DataProof> {
    return source.getTimeoutProofV2(this, packet, headerHeight);
  }

  /**
   * The updates that bring a counterparty's client of this chain, trusting
   * slot lastHeight, to finality at or past targetHeight. Pass
   * nextSyncCommitteeKnown = false when its trusted state does not know the
   * next sync committee yet.
   */
  public async buildHeader(lastHeight: number, targetHeight?: number, nextSyncCommitteeKnown = true): Promise<EthereumLightClientHeader> {
    return source.buildHeader(this, lastHeight, targetHeight, nextSyncCommitteeKnown);
  }

  public async buildCreateClientArgs(_trustPeriodSec?: number | null): Promise<{
    clientState: EthereumClientState
    consensusState: EthereumConsensusState
  }> {
    return source.buildCreateClientArgs(this);
  }

  public async getHeaderSummary(height: number): Promise<HeaderSummary> {
    return source.getHeaderSummary(this, height);
  }

  public async querySentPacketsV2(clientID: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketV2WithMetadata[]> {
    return source.querySentPacketsV2(this, clientID, minHeight, maxHeight);
  }

  public async queryWrittenAcksV2(clientID: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<AckV2WithMetadata[]> {
    return source.queryWrittenAcksV2(this, clientID, minHeight, maxHeight);
  }

  public async queryUnreceivedPacketsV2(clientId: string, sequences: readonly number[]): Promise<number[]> {
    return source.queryUnreceivedPacketsV2(this, clientId, sequences);
  }

  public async queryUnreceivedAcksV2(clientId: string, sequences: readonly number[]): Promise<number[]> {
    return source.queryUnreceivedAcksV2(this, clientId, sequences);
  }

  public async queryCommitmentsV2(clientId: string, sequence: bigint): Promise<Uint8Array> {
    return source.queryCommitmentsV2(this, clientId, sequence);
  }

  public async getCounterparty(clientId: string): Promise<string> {
    return source.getCounterparty(this, clientId);
  }

  // --- Ethereum as a host of gno light clients: host.ts ---

  public async getUnbondingPeriod(clientId: string): Promise<number> {
    return host.getUnbondingPeriod(this, clientId);
  }

  public async createGnoClient(clientState: ibc.lightclients.gno.v1.gno.ClientState, consensusState: ibc.lightclients.gno.v1.gno.ConsensusState): Promise<CreateClientResult> {
    return host.createGnoClient(this, clientState, consensusState);
  }

  public async updateClient(clientId: string, src: BaseIbcClient): Promise<Height> {
    return host.updateClient(this, clientId, src);
  }

  public async updateGnoClient(clientId: string, header: ibc.lightclients.gno.v1.gno.Header): Promise<MsgResult> {
    return host.updateGnoClient(this, clientId, header);
  }

  public async registerCounterParty(clientId: string, counterpartyClientId: string, merklePrefix: Uint8Array, merklePathPrefix?: Uint8Array): Promise<MsgResult> {
    return host.registerCounterParty(this, clientId, counterpartyClientId, merklePrefix, merklePathPrefix);
  }

  public async getClientStatus(clientId: string): Promise<ClientStatus> {
    return host.getClientStatus(this, clientId);
  }

  public async getConsensusStatesAfter(clientId: string, type: ClientType, afterRevisionHeight: bigint, limit: number): Promise<ConsensusStateSummary[]> {
    return host.getConsensusStatesAfter(this, clientId, type, afterRevisionHeight, limit);
  }

  public async findConflictingHeader(clientId: string, height: Height): Promise<Any | undefined> {
    return host.findConflictingHeader(this, clientId, height);
  }

  public async submitMisbehaviour(clientId: string, misbehaviour: Any): Promise<MsgResult> {
    return host.submitMisbehaviour(this, clientId, misbehaviour);
  }

  public async submitConflictingHeader(clientId: string, src: BaseIbcClient, trustedHeight: number, targetHeight: number): Promise<number> {
    return host.submitConflictingHeader(this, clientId, src, trustedHeight, targetHeight);
  }

  public async receivePacketsV2(packets: readonly PacketV2[], proofCommitments: readonly Uint8Array[], proofHeight?: Height): Promise<MsgResult> {
    return host.receivePacketsV2(this, packets, proofCommitments, proofHeight);
  }

  public async acknowledgePacketsV2(acks: readonly AckV2[], proofAckeds: readonly Uint8Array[], proofHeight?: Height): Promise<MsgResult> {
    return host.acknowledgePacketsV2(this, acks, proofAckeds, proofHeight);
  }

  public async timeoutPacketsV2(packets: PacketV2[], proofsUnreceived: Uint8Array[], proofHeight: Height): Promise<MsgResult> {
    return host.timeoutPacketsV2(this, packets, proofsUnreceived, proofHeight);
  }

  public async getLatestClientState(clientId: string, type: ClientType): Promise<AnyClientState> {
    return host.getLatestClientState(this, clientId, type);
  }

  public async getConsensusStateAtHeight(clientId: string, type: ClientType, consensusHeight?: Height): Promise<AnyConsensusState> {
    return host.getConsensusStateAtHeight(this, clientId, type, consensusHeight);
  }

  // --- Light clients Ethereum does not host ---

  public async createTendermintClient(_clientState: TendermintClientState, _consensusState: TendermintConsensusState): Promise<CreateClientResult> {
    throw new Error("Tendermint light clients are not supported on Ethereum by this relayer");
  }

  public async updateTendermintClient(_clientId: string, _header: TendermintHeader): Promise<MsgResult> {
    throw new Error("Tendermint light clients are not supported on Ethereum by this relayer");
  }

  public async createEthereumClient(_clientState: EthereumClientState, _consensusState: EthereumConsensusState): Promise<CreateClientResult> {
    throw new Error("Ethereum light clients are not supported on Ethereum");
  }

  public async updateEthereumClient(_clientId: string, _updates: EthereumLightClientHeader): Promise<MsgResult> {
    throw new Error("Ethereum light clients are not supported on Ethereum");
  }

  // --- IBC v1 ---

  public async connOpenInit(_clientId: string, _remoteClientId: string): Promise<CreateConnectionResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async connOpenTry(_clientId: string, _proof: ConnectionHandshakeProof): Promise<CreateConnectionResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async connOpenAck(_connectionId: string, _proof: ConnectionHandshakeProof): Promise<MsgResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async connOpenConfirm(_connectionId: string, _proof: ConnectionHandshakeProof): Promise<MsgResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async channelOpenInit(_portId: string, _remotePortId: string, _ordering: Order, _connectionId: string, _version: string): Promise<CreateChannelResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async channelOpenTry(_portId: string, _remote: ChannelInfo, _ordering: Order, _connectionId: string, _version: string, _counterpartyVersion: string, _proof: ChannelHandshakeProof): Promise<CreateChannelResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async channelOpenAck(_portId: string, _channelId: string, _counterpartyChannelId: string, _counterpartyVersion: string, _proof: ChannelHandshakeProof): Promise<MsgResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async channelOpenConfirm(_portId: string, _channelId: string, _proof: ChannelHandshakeProof): Promise<MsgResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getChannelHandshakeProof(_portId: string, _channelId: string, _proofHeight: Height): Promise<ChannelHandshakeProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getConnectionHandshakeProof(_clientId: string, _connectionId: string, _proofHeight: Height): Promise<ConnectionHandshakeProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getRawChannelProof(_portId: string, _channelId: string, _proofHeight: Height): Promise<DataProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getRawReceiptProof(_portId: string, _channelId: string, _sequence: bigint, _proofHeight: Height): Promise<DataProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getRawPacketCommitmentProof(_portId: string, _channelId: string, _sequence: bigint, _proofHeight: Height): Promise<DataProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getRawPacketAcknowledgementProof(_portId: string, _channelId: string, _sequence: bigint, _proofHeight: Height): Promise<DataProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getRawClientStateProof(_clientId: string, _proofHeight?: Height): Promise<FullProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getRawConsensusStateProof(_clientId: string, _consensusHeight: Height, _proofHeight?: Height): Promise<FullProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getRawConnectionProof(_connectionId: string, _proofHeight: Height): Promise<FullProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getPacketProof(_packet: Packet, _headerHeight: Height | number): Promise<DataProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getAckProof(_packet: Packet, _headerHeight: Height | number): Promise<DataProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getTimeoutProof(_packet: Packet, _headerHeight: Height | number): Promise<DataProof> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async receivePackets(_packets: readonly Packet[], _proofCommitments: readonly Uint8Array[], _proofHeight?: Height): Promise<MsgResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async acknowledgePackets(_acks: readonly Ack[], _proofAckeds: readonly Uint8Array[], _proofHeight?: Height): Promise<MsgResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async timeoutPackets(_packets: Packet[], _proofsUnreceived: Uint8Array[], _nextSequenceRecv: bigint[], _proofHeight: Height): Promise<MsgResult> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async querySentPackets(_connectionId: string, _minHeight: number | undefined, _maxHeight: number | undefined): Promise<PacketWithMetadata[]> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async queryWrittenAcks(_connectionId: string, _minHeight: number | undefined, _maxHeight: number | undefined): Promise<AckWithMetadata[]> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async queryUnreceivedPackets(_portId: string, _channelId: string, _sequences: readonly number[]): Promise<number[]> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async queryUnreceivedAcks(_portId: string, _channelId: string, _sequences: readonly number[]): Promise<number[]> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async queryCommitments(_portId: string, _channelId: string, _sequence: bigint): Promise<Uint8Array> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getConnection(_connectionId: string): Promise<Partial<QueryConnectionResponse>> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getChannelV1Type(_portId: string, _channelId: string): Promise<Order> {
    throw new Error(NOT_ON_ETHEREUM);
  }

  public async getNextSequenceRecv(_portId: string, _channelId: string): Promise<bigint> {
    throw new Error(NOT_ON_ETHEREUM);
  }
}
