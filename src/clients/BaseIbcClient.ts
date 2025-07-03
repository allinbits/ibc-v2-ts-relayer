import { BlockResultsResponse, ReadonlyDateWithNanoseconds, TxSearchResponse } from "@cosmjs/tendermint-rpc";
import { Order, Packet } from "cosmjs-types/ibc/core/channel/v1/channel";
import { QueryNextSequenceReceiveResponse } from "cosmjs-types/ibc/core/channel/v1/query";
import { Height } from "cosmjs-types/ibc/core/client/v1/client";
import { QueryClientStateResponse, QueryConsensusStateResponse } from "cosmjs-types/ibc/core/client/v1/query";
import { QueryConnectionResponse } from "cosmjs-types/ibc/core/connection/v1/query";
import { ClientState as TendermintClientState, ConsensusState as TendermintConsensusState, Header as TendermintHeader } from "cosmjs-types/ibc/lightclients/tendermint/v1/tendermint";
import { SignedHeader } from "cosmjs-types/tendermint/types/types";
import { ValidatorSet } from "cosmjs-types/tendermint/types/validator";
import winston from "winston";

import { Ack, BlockSearchResponse, ChannelHandshake, ChannelInfo, CometCommitResponse, ConnectionHandshakeProof,CreateChannelResult,CreateClientArgs,CreateClientResult, CreateConnectionResult, MsgResult } from "../types";

export type BaseIbcClientOptions = {
  chainId: string;
  rpcEndpoint: string;
  logger: winston.Logger;
  senderAddress: string;
  estimatedBlockTime: number;
  estimatedIndexerTime: number;
  revisionNumber?: bigint;
}

export abstract class BaseIbcClient {
  /**
   * The chain ID of the chain this client is connected to.
   */
  public readonly chainId: string;
  /**
   * The RPC endpoint of the chain this client is connected to.
   */
  public readonly rpcEndpoint: string;
  public readonly estimatedBlockTime: number;
  public readonly estimatedIndexerTime: number;
  public readonly senderAddress: string;
  public logger: winston.Logger;
  public revisionNumber: bigint;

  public constructor(options: BaseIbcClientOptions) {
    this.chainId = options.chainId;
    this.rpcEndpoint = options.rpcEndpoint;
    this.logger = options.logger;
    this.estimatedBlockTime = options.estimatedBlockTime;
    this.estimatedIndexerTime = options.estimatedIndexerTime;
    this.senderAddress = options.senderAddress;
    this.revisionNumber = options.revisionNumber ?? 1n;
  }

  abstract createTendermintClient(clientState: TendermintClientState, consensusState: TendermintConsensusState) : Promise<CreateClientResult>;
  abstract registerCounterParty(clientId: string, counterpartyClientId: string, merklePrefix: Uint8Array): Promise<void>;
  abstract getTendermintConsensusState(clientId: string, height?: number): Promise<TendermintConsensusState>;
  abstract getTendermintClientState(clientId: string, height?: number): Promise<TendermintClientState>;
  abstract getChannelProof(portId: string, channelId: string, proofHeight: Height) : Promise<ChannelHandshake>;
  abstract getReceiptProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height) : Promise<Uint8Array>;
  abstract getPacketCommitmentProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<Uint8Array>;
  abstract getPacketAcknowledgementProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height) : Promise<Uint8Array>;
  abstract getNextSequenceRecvProof(portId: string, channelId: string, proofHeight: Height) : Promise<QueryNextSequenceReceiveResponse>;
  abstract getConnectionProof(clientId:string, connectionId: string, proofHeight: Height) : Promise<ConnectionHandshakeProof>
  abstract getClientStateProof(clientId: string, proofHeight?: Height): Promise<QueryClientStateResponse & {proofHeight: Height}>;
  abstract getConsensusStateProof(clientId: string, consensusHeight: Height, proofHeight?: Height): Promise<QueryConsensusStateResponse>;
  abstract updateClient(clientId: string, src: BaseIbcClient): Promise<Height>
  abstract getConnection(connectionId: string): Promise<QueryConnectionResponse>;
  abstract getUnbondingPeriod(clientId: string): Promise<number>;
  abstract connOpenInit(clientId: string, remoteClientId: string) : Promise<CreateConnectionResult>;
  abstract connOpenTry(clientId: string, proof: ConnectionHandshakeProof) : Promise<CreateConnectionResult>;
  abstract connOpenAck(connectionId: string, proof: ConnectionHandshakeProof): Promise<MsgResult> ;
  abstract connOpenConfirm(connectionId: string, proof: ConnectionHandshakeProof): Promise<MsgResult>;
  abstract channelOpenInit(portId: string, remotePortId: string, ordering: Order, connectionId: string, version: string): Promise<CreateChannelResult>;
  abstract channelOpenTry(portId: string, remote: ChannelInfo, ordering: Order, connectionId: string, version: string, counterpartyVersion: string, proof: ChannelHandshake): Promise<CreateChannelResult>;
  abstract channelOpenAck(portId: string, channelId: string, counterpartyChannelId: string, counterpartyVersion: string, proof: ChannelHandshake): Promise<MsgResult>;
  abstract channelOpenConfirm(portId: string, channelId: string, proof: ChannelHandshake): Promise<MsgResult>;
  abstract revisionHeight(height: number): Height;
  abstract getTendermintCommit(height?: number): Promise<CometCommitResponse>;
  abstract ensureRevisionHeight(height: number | Height): Height;
  abstract timeoutHeight(blocksInFuture: number): Promise<Height>;
  abstract getChainId(): Promise<string>;
  abstract header(height: number): Promise<unknown>;
  abstract latestHeader(): Promise<unknown>;
  abstract currentTime(): Promise<ReadonlyDateWithNanoseconds>;
  abstract currentHeight(): Promise<number>;
  abstract currentRevision(): Promise<Height>;
  abstract searchTendermintBlocks(query: string): Promise<BlockSearchResponse>;
  abstract getTendermintBlockResults(height: number): Promise<BlockResultsResponse>;
  abstract searchTendermintTxs(query: string): Promise<TxSearchResponse>;
  abstract getValidatorSet(height: number): Promise<ValidatorSet>;
  abstract getSignedHeader(height?: number): Promise<SignedHeader>;
  abstract buildTendermintHeader(lastHeight: number): Promise<TendermintHeader>;
  abstract updateTendermintClient(clientId: string, header: TendermintHeader): Promise<MsgResult>;
  abstract receivePackets(packets: readonly Packet[], proofCommitments: readonly Uint8Array[], proofHeight?: Height): Promise<MsgResult>;
  abstract acknowledgePackets(acks: readonly Ack[], proofAckeds: readonly Uint8Array[], proofHeight?: Height): Promise<MsgResult>;
  abstract timeoutPackets(packets: Packet[], proofsUnreceived: Uint8Array[], nextSequenceRecv: bigint[], proofHeight: Height): Promise<MsgResult>;
  abstract buildCreateTendermintClientArgs(src: BaseIbcClient,trustPeriodSec?: number | null,): Promise<CreateClientArgs>;
}