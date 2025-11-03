/* eslint-disable max-lines */
import {
  Any,
} from "@atomone/cosmos-ibc-types/build/google/protobuf/any.js";
import {
  MsgTransfer,
} from "@atomone/cosmos-ibc-types/build/ibc/applications/transfer/v1/tx.js";
import {
  Order, Packet, State,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/channel.js";
import {
  MsgAcknowledgement,
  MsgChannelOpenAck,
  MsgChannelOpenConfirm,
  MsgChannelOpenInit,
  MsgChannelOpenTry,
  MsgRecvPacket,
  MsgTimeout,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/tx.js";
import {
  Acknowledgement, Packet as PacketV2,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/packet.js";
import {
  MsgAcknowledgement as MsgAcknowledgementV2, MsgRecvPacket as MsgRecvPacketV2, MsgSendPacket, MsgTimeout as MsgTimeoutV2,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/tx.js";
import {
  Height,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/client.js";
import {
  MsgCreateClient,
  MsgUpdateClient,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/tx.js";
import {
  MsgRegisterCounterparty,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v2/tx.js";
import {
  QueryConnectionResponse,
} from "@atomone/cosmos-ibc-types/build/ibc/core/connection/v1/query.js";
import {
  MsgConnectionOpenAck,
  MsgConnectionOpenConfirm,
  MsgConnectionOpenInit,
  MsgConnectionOpenTry,
} from "@atomone/cosmos-ibc-types/build/ibc/core/connection/v1/tx.js";
import {
  ClientState, ConsensusState,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  ClientState as TendermintClientState,
  ConsensusState as TendermintConsensusState,
  Header as TendermintHeader,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  Commit, Header, SignedHeader,
} from "@atomone/cosmos-ibc-types/build/tendermint/types/types.js";
import {
  blockIDFlagFromJSON, ValidatorSet,
} from "@atomone/cosmos-ibc-types/build/tendermint/types/validator.js";
import {
  OfflineSigner, Registry,
} from "@cosmjs/proto-signing";
import {
  AuthExtension,
  BankExtension,
  defaultRegistryTypes,
  fromTendermintEvent,
  GasPrice,
  IbcExtension,
  isDeliverTxFailure,
  QueryClient,
  setupAuthExtension,
  setupBankExtension,
  setupIbcExtension,
  setupStakingExtension,
  SigningStargateClient,
  SigningStargateClientOptions,
  StakingExtension,
} from "@cosmjs/stargate";
import {
  CometClient, connectComet, ReadonlyDateWithNanoseconds,
} from "@cosmjs/tendermint-rpc";
import {
  arrayContentEquals, assert, sleep,
} from "@cosmjs/utils";

import {
  Ack, AckV2, AckV2WithMetadata, AckWithMetadata, BlockResultsResponse, BlockSearchResponse, ChannelHandshakeProof, ChannelInfo, ClientType, CometCommitResponse, CometHeader, ConnectionHandshakeProof, CreateChannelResult, CreateClientArgs, CreateClientResult, CreateConnectionResult, DataProof, FullProof, MsgResult, PacketV2WithMetadata, PacketWithMetadata, ProvenQuery, TxSearchResponse,
} from "../../types/index.js";
import {
  createDeliverTxFailureMessage, parseRevisionNumber,
} from "../../utils/utils.js";
import {
  IbcV2Extension, setupIbcV2Extension,
} from "../../v2queries/ibc.js";
import {
  BaseIbcClient, BaseIbcClientOptions, isTendermint,
} from "../BaseIbcClient.js";
import {
  ProofQueries,
} from "./modules/ProofQueries.js";
import {
  TxQueries,
} from "./modules/TxQueries.js";
import {
  ClientManagement,
} from "./modules/ClientManagement.js";
import {
  ConnectionHandshake,
} from "./modules/ConnectionHandshake.js";
import {
  ChannelHandshake,
} from "./modules/ChannelHandshake.js";
import {
  PacketHandling,
} from "./modules/PacketHandling.js";

function ibcRegistry(): Registry {
  return new Registry([...defaultRegistryTypes, ["/ibc.core.client.v1.MsgCreateClient", MsgCreateClient], ["/ibc.core.client.v1.MsgUpdateClient", MsgUpdateClient], ["/ibc.core.client.v2.MsgRegisterCounterparty", MsgRegisterCounterparty], ["/ibc.core.connection.v1.MsgConnectionOpenInit", MsgConnectionOpenInit], ["/ibc.core.connection.v1.MsgConnectionOpenTry", MsgConnectionOpenTry], ["/ibc.core.connection.v1.MsgConnectionOpenAck", MsgConnectionOpenAck], ["/ibc.core.connection.v1.MsgConnectionOpenConfirm", MsgConnectionOpenConfirm], ["/ibc.core.channel.v1.MsgChannelOpenInit", MsgChannelOpenInit], ["/ibc.core.channel.v1.MsgChannelOpenTry", MsgChannelOpenTry], ["/ibc.core.channel.v1.MsgChannelOpenAck", MsgChannelOpenAck], ["/ibc.core.channel.v1.MsgChannelOpenConfirm", MsgChannelOpenConfirm], ["/ibc.core.channel.v1.MsgRecvPacket", MsgRecvPacket], ["/ibc.core.channel.v1.MsgAcknowledgement", MsgAcknowledgement], ["/ibc.core.channel.v1.MsgTimeout", MsgTimeout], ["/ibc.core.channel.v2.MsgSendPacket", MsgSendPacket], ["/ibc.core.channel.v2.MsgRecvPacket", MsgRecvPacketV2], ["/ibc.core.channel.v2.MsgAcknowledgement", MsgAcknowledgementV2], ["/ibc.core.channel.v2.MsgTimeout", MsgTimeoutV2], ["/ibc.applications.transfer.v1.MsgTransfer", MsgTransfer]]);
}
export type TendermintIbcClientOptions = SigningStargateClientOptions & BaseIbcClientOptions & {
  gasPrice: GasPrice
};

export interface TendermintIbcClientTypes {
  header: CometHeader
  consensusState: TendermintConsensusState
  clientState: TendermintClientState
  clientArgs: CreateClientArgs
  lightClientHeader: TendermintHeader
}
export class TendermintIbcClient extends BaseIbcClient<TendermintIbcClientTypes> {
  public readonly gasPrice: GasPrice;
  public readonly sign: SigningStargateClient;
  public readonly tm: CometClient;

  public readonly query: QueryClient
    & AuthExtension
    & BankExtension
    & IbcExtension
    & IbcV2Extension
    & StakingExtension;

  private readonly proofQueries: ProofQueries;
  private readonly txQueries: TxQueries;
  private readonly clientManagement: ClientManagement;
  private readonly connectionHandshake: ConnectionHandshake;
  private readonly channelHandshake: ChannelHandshake;
  private readonly packetHandling: PacketHandling;

  public static async connectWithSigner(
    endpoint: string,
    signer: OfflineSigner,
    options: Partial<TendermintIbcClientOptions>,
  ): Promise<TendermintIbcClient> {
    options.senderAddress = (await signer.getAccounts())[0].address;
    // override any registry setup, use the other options
    const mergedOptions = {
      ...options,
      registry: ibcRegistry(),
    };
    const signingClient = await SigningStargateClient.connectWithSigner(
      endpoint, signer, mergedOptions,
    );
    const tmClient = await connectComet(endpoint);
    const chainId = await signingClient.getChainId();
    options.chainId = chainId;
    options.clientType = ClientType.Tendermint;
    options.revisionNumber = parseRevisionNumber(chainId);
    return new TendermintIbcClient(
      signingClient, tmClient, options as TendermintIbcClientOptions,
    );
  }

  private constructor(
    signingClient: SigningStargateClient,
    tmClient: CometClient,
    options: TendermintIbcClientOptions,
  ) {
    super(options);
    this.sign = signingClient;
    this.tm = tmClient;
    this.gasPrice = options.gasPrice;
    this.query = QueryClient.withExtensions(
      tmClient, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension, setupIbcV2Extension,
    );
    this.proofQueries = new ProofQueries(this);
    this.txQueries = new TxQueries(this);
    this.clientManagement = new ClientManagement(this);
    this.connectionHandshake = new ConnectionHandshake(this);
    this.channelHandshake = new ChannelHandshake(this);
    this.packetHandling = new PacketHandling(this);
  }

  public revisionHeight(height: number): Height {
    return Height.fromPartial({
      revisionHeight: BigInt(height),
      revisionNumber: this.revisionNumber,
    });
  }

  public ensureRevisionHeight(height: number | Height): Height {
    if (typeof height === "number") {
      return Height.fromPartial({
        revisionHeight: BigInt(height),
        revisionNumber: this.revisionNumber,
      });
    }
    if (height.revisionNumber !== this.revisionNumber) {
      throw new Error(
        `Using incorrect revisionNumber ${height.revisionNumber} on chain with ${this.revisionNumber}`,
      );
    }
    return height;
  }

  public async timeoutHeight(blocksInFuture: number): Promise<Height> {
    const header = await this.latestHeader();
    return this.revisionHeight(header.height + blocksInFuture);
  }

  public getChainId(): Promise<string> {
    this.logger.verbose("Get chain ID");
    return this.sign.getChainId();
  }

  public async header(height: number): Promise<CometHeader> {
    this.logger.verbose(`Get header for height ${height}`);
    // TODO: expose header method on tmClient and use that
    const resp = await this.tm.blockchain(height, height);
    return resp.blockMetas[0].header;
  }

  public async latestHeader(): Promise<CometHeader> {
    // TODO: expose header method on tmClient and use that
    const block = await this.tm.block();
    return block.block.header;
  }

  public async currentTime(): Promise<ReadonlyDateWithNanoseconds> {
    // const status = await this.tm.status();
    // return status.syncInfo.latestBlockTime;
    return (await this.latestHeader()).time;
  }

  public async currentHeight(): Promise<number> {
    const status = await this.tm.status();
    return status.syncInfo.latestBlockHeight;
  }

  public async currentRevision(): Promise<Height> {
    const block = await this.currentHeight();
    return this.revisionHeight(block);
  }

  public async waitOneBlock(): Promise<void> {
    // ensure this works
    const start = await this.currentHeight();
    let end: number;
    do {
      await sleep(this.estimatedBlockTime);
      end = await this.currentHeight();
    } while (end === start);
    // TODO: this works but only for websocket connections, is there some code that falls back to polling in cosmjs?
    // await firstEvent(this.tm.subscribeNewBlockHeader());
  }

  // we may have to wait a bit before a tx returns and making queries on the event log
  public async waitForIndexer(): Promise<void> {
    await sleep(this.estimatedIndexerTime);
  }

  public getTendermintCommit(height?: number): Promise<CometCommitResponse> {
    return this.clientManagement.getTendermintCommit(height);
  }

  /** Returns the unbonding period in seconds */
  public async getUnbondingPeriod(): Promise<number> {
    return this.clientManagement.getUnbondingPeriod();
  }

  public async getSignedHeader(height?: number): Promise<SignedHeader> {
    return this.clientManagement.getSignedHeader(height);
  }

  public async lastKnownHeight(clientId: string): Promise<number> {
    return this.clientManagement.lastKnownHeight(clientId);
  }

  public async getValidatorSet(height: number): Promise<ValidatorSet> {
    return this.clientManagement.getValidatorSet(height);
  }

  public async buildHeader(lastHeight: number): Promise<TendermintHeader> {
    return this.clientManagement.buildHeader(lastHeight);
  }

  public async getConsensusStateAtHeight(clientId: string, consensusHeight?: Height): Promise<Any> {
    return this.clientManagement.getConsensusStateAtHeight(clientId, consensusHeight);
  }

  public async getLatestClientState(clientId: string): Promise<Any> {
    return this.clientManagement.getLatestClientState(clientId);
  }

  // trustedHeight must be proven by the client on the destination chain
  // and include a proof for the connOpenInit (eg. must be 1 or more blocks after the
  // block connOpenInit Tx was in).
  //
  // pass a header height that was previously updated to on the remote chain using updateClient.
  // note: the queries will be for the block before this header, so the proofs match up (appHash is on H+1)
  public async getConnectionHandshakeProof(
    clientId: string,
    connectionId: string,
    headerHeight: Height | number,
  ): Promise<ConnectionHandshakeProof> {
    return this.proofQueries.getConnectionHandshakeProof(clientId, connectionId, headerHeight);
  }

  public async getChannelHandshakeProof(
    portId: string,
    channelId: string,
    headerHeight: Height | number,
  ): Promise<ChannelHandshakeProof> {
    return this.proofQueries.getChannelHandshakeProof(portId, channelId, headerHeight);
  }

  public async getPacketProof(
    packet: Packet,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    return this.proofQueries.getPacketProof(packet, headerHeight);
  }

  public async getAckProof(
    originalPacket: Packet,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    return this.proofQueries.getAckProof(originalPacket, headerHeight);
  }

  public async getTimeoutProof(
    originalPacket: Packet,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    return this.proofQueries.getTimeoutProof(originalPacket, headerHeight);
  }

  public async getPacketProofV2(
    packet: PacketV2,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    return this.proofQueries.getPacketProofV2(packet, headerHeight);
  }

  public async getAckProofV2(
    originalPacket: PacketV2,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    return this.proofQueries.getAckProofV2(originalPacket, headerHeight);
  }

  public async getTimeoutProofV2(
    originalPacket: PacketV2,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    return this.proofQueries.getTimeoutProofV2(originalPacket, headerHeight);
  }

  /*
  These are helpers to query, build data and submit a message
  Currently all prefixed with doXxx, but please look for better naming
  */

  // Updates existing client on this chain with data from src chain.
  // Returns the height that was updated to.
  public async updateClient(
    clientId: string,
    src: BaseIbcClient,
  ): Promise<Height> {
    return this.clientManagement.updateClient(clientId, src);
  }

  public async createTendermintClient(
    clientState: TendermintClientState,
    consensusState: TendermintConsensusState,
  ): Promise<CreateClientResult> {
    return this.clientManagement.createTendermintClient(clientState, consensusState);
  }

  public async updateTendermintClient(
    clientId: string,
    header: TendermintHeader,
  ): Promise<MsgResult> {
    return this.clientManagement.updateTendermintClient(clientId, header);
  }

  public async connOpenInit(
    clientId: string,
    remoteClientId: string,
  ): Promise<CreateConnectionResult> {
    return this.connectionHandshake.connOpenInit(clientId, remoteClientId);
  }

  public async connOpenTry(
    myClientId: string,
    proof: ConnectionHandshakeProof,
  ): Promise<CreateConnectionResult> {
    return this.connectionHandshake.connOpenTry(myClientId, proof);
  }

  public async connOpenAck(
    myConnectionId: string,
    proof: ConnectionHandshakeProof,
  ): Promise<MsgResult> {
    return this.connectionHandshake.connOpenAck(myConnectionId, proof);
  }

  public async connOpenConfirm(
    myConnectionId: string,
    proof: ConnectionHandshakeProof,
  ): Promise<MsgResult> {
    return this.connectionHandshake.connOpenConfirm(myConnectionId, proof);
  }

  public async channelOpenInit(
    portId: string,
    remotePortId: string,
    ordering: Order,
    connectionId: string,
    version: string,
  ): Promise<CreateChannelResult> {
    return this.channelHandshake.channelOpenInit(portId, remotePortId, ordering, connectionId, version);
  }

  public async channelOpenTry(
    portId: string,
    remote: ChannelInfo,
    ordering: Order,
    connectionId: string,
    version: string,
    counterpartyVersion: string,
    proof: ChannelHandshakeProof,
  ): Promise<CreateChannelResult> {
    return this.channelHandshake.channelOpenTry(portId, remote, ordering, connectionId, version, counterpartyVersion, proof);
  }

  public async channelOpenAck(
    portId: string,
    channelId: string,
    counterpartyChannelId: string,
    counterpartyVersion: string,
    proof: ChannelHandshakeProof,
  ): Promise<MsgResult> {
    return this.channelHandshake.channelOpenAck(portId, channelId, counterpartyChannelId, counterpartyVersion, proof);
  }

  public async channelOpenConfirm(
    portId: string,
    channelId: string,
    proof: ChannelHandshakeProof,
  ): Promise<MsgResult> {
    return this.channelHandshake.channelOpenConfirm(portId, channelId, proof);
  }

  public receivePacket(
    packet: Packet,
    proofCommitment: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.receivePacket(packet, proofCommitment, proofHeight);
  }

  public async receivePackets(
    packets: readonly Packet[],
    proofCommitments: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.receivePackets(packets, proofCommitments, proofHeight);
  }

  public receivePacketV2(
    packet: PacketV2,
    proofCommitment: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.receivePacketV2(packet, proofCommitment, proofHeight);
  }

  public async receivePacketsV2(
    packets: readonly PacketV2[],
    proofCommitments: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.receivePacketsV2(packets, proofCommitments, proofHeight);
  }

  public acknowledgePacket(
    ack: Ack,
    proofAcked: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.acknowledgePacket(ack, proofAcked, proofHeight);
  }

  public async acknowledgePackets(
    acks: readonly Ack[],
    proofAckeds: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.acknowledgePackets(acks, proofAckeds, proofHeight);
  }

  public acknowledgePacketV2(
    ack: AckV2,
    proofAcked: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.acknowledgePacketV2(ack, proofAcked, proofHeight);
  }

  public async acknowledgePacketsV2(
    acks: readonly AckV2[],
    proofAckeds: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.acknowledgePacketsV2(acks, proofAckeds, proofHeight);
  }

  public timeoutPacket(
    packet: Packet,
    proofUnreceived: Uint8Array,
    nextSequenceRecv: bigint,
    proofHeight: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.timeoutPacket(packet, proofUnreceived, nextSequenceRecv, proofHeight);
  }

  public async timeoutPackets(
    packets: Packet[],
    proofsUnreceived: Uint8Array[],
    nextSequenceRecv: bigint[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.timeoutPackets(packets, proofsUnreceived, nextSequenceRecv, proofHeight);
  }

  public timeoutPacketV2(
    packet: PacketV2,
    proofUnreceived: Uint8Array,
    proofHeight: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.timeoutPacketV2(packet, proofUnreceived, proofHeight);
  }

  public async getChannelV1Type(portId: string, channelId: string): Promise<Order> {
    return this.channelHandshake.getChannelV1Type(portId, channelId);
  }

  public async timeoutPacketsV2(
    packets: PacketV2[],
    proofsUnreceived: Uint8Array[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    return this.packetHandling.timeoutPacketsV2(packets, proofsUnreceived, proofHeight);
  }

  public async queryRawProof(store: string, queryKey: Uint8Array, proofHeight: number): Promise<ProvenQuery> {
    return this.proofQueries.queryRawProof(store, queryKey, proofHeight);
  }

  public async registerCounterParty(clientId: string, counterpartyClientId: string, merklePrefix: Uint8Array): Promise<MsgResult> {
    this.logger.verbose(
      `Register Counterparty : ${counterpartyClientId} => ${clientId}`,
    );
    const senderAddress = this.senderAddress;
    const msg = {
      typeUrl: "/ibc.core.client.v2.MsgRegisterCounterparty",
      value: MsgRegisterCounterparty.fromPartial({
        clientId,
        counterpartyClientId,
        counterpartyMerklePrefix: [merklePrefix, new Uint8Array()],
        signer: senderAddress,
      }),
    };
    this.logger.debug("MsgRegisterCounterparty", msg);

    const result = await this.sign.signAndBroadcast(
      senderAddress, [msg], "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    return result;
  }

  public async getTendermintConsensusState(clientId: string, consensusHeight: Height, proofHeight: Height): Promise<{
    consensusState: ConsensusState
    proof: Uint8Array
  }> {
    return this.proofQueries.getTendermintConsensusState(clientId, consensusHeight, proofHeight);
  }

  public async getTendermintClientState(clientId: string, proofHeight: Height): Promise<{
    clientState: ClientState
    proof: Uint8Array
  }> {
    return this.proofQueries.getTendermintClientState(clientId, proofHeight);
  }

  public async getRawChannelProof(portId: string, channelId: string, proofHeight: Height): Promise<DataProof> {
    return this.proofQueries.getRawChannelProof(portId, channelId, proofHeight);
  }

  public async getRawReceiptProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    return this.proofQueries.getRawReceiptProof(portId, channelId, sequence, proofHeight);
  }

  public async getRawReceiptProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    return this.proofQueries.getRawReceiptProofV2(clientId, sequence, proofHeight);
  }

  public async getRawPacketCommitmentProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    return this.proofQueries.getRawPacketCommitmentProof(portId, channelId, sequence, proofHeight);
  }

  public async getRawPacketCommitmentProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    return this.proofQueries.getRawPacketCommitmentProofV2(clientId, sequence, proofHeight);
  }

  public async getRawPacketAcknowledgementProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    return this.proofQueries.getRawPacketAcknowledgementProof(portId, channelId, sequence, proofHeight);
  }

  public async getRawPacketAcknowledgementProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    return this.proofQueries.getRawPacketAcknowledgementProofV2(clientId, sequence, proofHeight);
  }

  public async getRawClientStateProof(clientId: string, proofHeight: Height): Promise<FullProof> {
    return this.proofQueries.getRawClientStateProof(clientId, proofHeight);
  }

  public async getRawConsensusStateProof(clientId: string, consensusHeight: Height, proofHeight: Height): Promise<FullProof> {
    return this.proofQueries.getRawConsensusStateProof(clientId, consensusHeight, proofHeight);
  }

  public async getRawConnectionProof(connectionId: string, proofHeight: Height): Promise<FullProof> {
    return this.proofQueries.getRawConnectionProof(connectionId, proofHeight);
  }

  public async getNextSequenceRecv(portId: string, channelId: string): Promise<bigint> {
    return this.txQueries.getNextSequenceRecv(portId, channelId);
  }

  public async getConnection(connectionId: string): Promise<Partial<QueryConnectionResponse>> {
    return this.connectionHandshake.getConnection(connectionId);
  }

  public async getCounterparty(clientId: string): Promise<string> {
    return this.connectionHandshake.getCounterparty(clientId);
  }

  public async searchTendermintBlocks(query: string): Promise<BlockSearchResponse> {
    return this.txQueries.searchTendermintBlocks(query);
  }

  public async getTendermintBlockResults(height: number): Promise<BlockResultsResponse> {
    return this.txQueries.getTendermintBlockResults(height);
  }

  public async searchTendermintTxs(query: string): Promise<TxSearchResponse> {
    return this.txQueries.searchTendermintTxs(query);
  }

  public async querySentPackets(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[]> {
    return this.txQueries.querySentPackets(connectionId, minHeight, maxHeight);
  }

  public async querySentPacketsV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketV2WithMetadata[]> {
    return this.txQueries.querySentPacketsV2(clientId, minHeight, maxHeight);
  }

  public async queryWrittenAcks(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<AckWithMetadata[]> {
    return this.txQueries.queryWrittenAcks(connectionId, minHeight, maxHeight);
  }

  public async queryWrittenAcksV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<AckV2WithMetadata[]> {
    return this.txQueries.queryWrittenAcksV2(clientId, minHeight, maxHeight);
  }

  public async queryUnreceivedPackets(portId: string, channelId: string, sequences: readonly number[]) {
    return this.txQueries.queryUnreceivedPackets(portId, channelId, sequences);
  }

  public async queryUnreceivedPacketsV2(clientId: string, sequences: readonly number[]) {
    return this.txQueries.queryUnreceivedPacketsV2(clientId, sequences);
  }

  public async queryCommitments(portId: string, channelId: string, sequence: bigint): Promise<Uint8Array> {
    return this.txQueries.queryCommitments(portId, channelId, sequence);
  }

  public async queryCommitmentsV2(clientId: string, sequence: bigint): Promise<Uint8Array> {
    return this.txQueries.queryCommitmentsV2(clientId, sequence);
  }

  public async queryUnreceivedAcks(portId: string, channelId: string, sequences: readonly number[]) {
    return this.txQueries.queryUnreceivedAcks(portId, channelId, sequences);
  }

  public async queryUnreceivedAcksV2(clientId: string, sequences: readonly number[]) {
    return this.txQueries.queryUnreceivedAcksV2(clientId, sequences);
  }

  public async buildCreateClientArgs(trustPeriodSec?: number | null): Promise<CreateClientArgs> {
    return this.clientManagement.buildCreateClientArgs(trustPeriodSec);
  }

  async getPacketsFromBlockEvents(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[]> {
    return this.txQueries.getPacketsFromBlockEvents(connectionId, minHeight, maxHeight);
  }

  async getPacketsFromTxs(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[]> {
    return this.txQueries.getPacketsFromTxs(connectionId, minHeight, maxHeight);
  }

  async getPacketsFromBlockEventsV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketV2WithMetadata[]> {
    return this.txQueries.getPacketsFromBlockEventsV2(clientId, minHeight, maxHeight);
  }

  async getPacketsFromTxsV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketV2WithMetadata[]> {
    return this.txQueries.getPacketsFromTxsV2(clientId, minHeight, maxHeight);
  }
}
