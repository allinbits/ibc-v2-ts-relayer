/* eslint-disable max-lines */
import { Any } from "@atomone/cosmos-ibc-types/build/google/protobuf/any";
import { MsgTransfer } from "@atomone/cosmos-ibc-types/build/ibc/applications/transfer/v1/tx";
import { Order, Packet, State } from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/channel";
import {
  MsgAcknowledgement,
  MsgChannelOpenAck,
  MsgChannelOpenConfirm,
  MsgChannelOpenInit,
  MsgChannelOpenTry,
  MsgRecvPacket,
  MsgTimeout,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/tx";
import { MsgAcknowledgement as MsgAcknowledgementV2, MsgRecvPacket as MsgRecvPacketV2, MsgSendPacket, MsgTimeout as MsgTimeoutV2 } from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/tx";
import { Height } from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/client";
import {
  MsgCreateClient,
  MsgUpdateClient,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/tx";
import { MsgRegisterCounterparty } from "@atomone/cosmos-ibc-types/build/ibc/core/client/v2/tx";
import { Version } from "@atomone/cosmos-ibc-types/build/ibc/core/connection/v1/connection";
import { QueryConnectionResponse } from "@atomone/cosmos-ibc-types/build/ibc/core/connection/v1/query";
import {
  MsgConnectionOpenAck,
  MsgConnectionOpenConfirm,
  MsgConnectionOpenInit,
  MsgConnectionOpenTry,
} from "@atomone/cosmos-ibc-types/build/ibc/core/connection/v1/tx";
import { ClientState, ConsensusState } from "@atomone/cosmos-ibc-types/build/ibc/lightclients/tendermint/v1/tendermint";
import {
  ClientState as TendermintClientState,
  ConsensusState as TendermintConsensusState,
  Header as TendermintHeader,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/tendermint/v1/tendermint";
import { Commit, Header, SignedHeader } from "@atomone/cosmos-ibc-types/build/tendermint/types/types";
import { blockIDFlagFromJSON, ValidatorSet } from "@atomone/cosmos-ibc-types/build/tendermint/types/validator";
import { toAscii, toHex } from "@cosmjs/encoding";
import { OfflineSigner, Registry } from "@cosmjs/proto-signing";
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
import { CometClient, connectComet, ReadonlyDateWithNanoseconds } from "@cosmjs/tendermint-rpc";
import { arrayContentEquals, assert, sleep } from "@cosmjs/utils";

import { Ack, AckWithMetadata,BlockResultsResponse, BlockSearchResponse, ChannelHandshakeProof, ChannelInfo, ClientType, CometCommitResponse, CometHeader, ConnectionHandshakeProof, CreateChannelResult, CreateClientArgs, CreateClientResult, CreateConnectionResult, DataProof, FullProof, MsgResult, PacketWithMetadata, ProvenQuery, TxSearchResponse } from "../../types";
import { buildTendermintClientState, buildTendermintConsensusState, checkAndParseOp, convertProofsToIcs23, createDeliverTxFailureMessage, deepCloneAndMutate, heightQueryString, mapRpcPubKeyToProto, parseAcksFromTxEvents, parsePacketsFromBlockResult, parsePacketsFromTendermintEvents, parseRevisionNumber, presentPacketData, subtractBlock, timestampFromDateNanos, toBase64AsAny, toIntHeight } from "../../utils/utils";
import { BaseIbcClient, BaseIbcClientOptions, isTendermint } from "../BaseIbcClient";

function ibcRegistry(): Registry {
  return new Registry([
    ...defaultRegistryTypes,
    ["/ibc.core.client.v1.MsgCreateClient", MsgCreateClient],
    ["/ibc.core.client.v1.MsgUpdateClient", MsgUpdateClient],
    ["/ibc.core.client.v2.MsgRegisterCounterparty", MsgRegisterCounterparty],
    ["/ibc.core.connection.v1.MsgConnectionOpenInit", MsgConnectionOpenInit],
    ["/ibc.core.connection.v1.MsgConnectionOpenTry", MsgConnectionOpenTry],
    ["/ibc.core.connection.v1.MsgConnectionOpenAck", MsgConnectionOpenAck],
    [
      "/ibc.core.connection.v1.MsgConnectionOpenConfirm",
      MsgConnectionOpenConfirm,
    ],
    ["/ibc.core.channel.v1.MsgChannelOpenInit", MsgChannelOpenInit],
    ["/ibc.core.channel.v1.MsgChannelOpenTry", MsgChannelOpenTry],
    ["/ibc.core.channel.v1.MsgChannelOpenAck", MsgChannelOpenAck],
    ["/ibc.core.channel.v1.MsgChannelOpenConfirm", MsgChannelOpenConfirm],
    ["/ibc.core.channel.v1.MsgRecvPacket", MsgRecvPacket],
    ["/ibc.core.channel.v1.MsgAcknowledgement", MsgAcknowledgement],
    ["/ibc.core.channel.v1.MsgTimeout", MsgTimeout],
    ["/ibc.core.channel.v2.MsgSendPacket", MsgSendPacket],
    ["/ibc.core.channel.v2.MsgRecvPacket", MsgRecvPacketV2],
    ["/ibc.core.channel.v2.MsgAcknowledgement", MsgAcknowledgementV2],
    ["/ibc.core.channel.v2.MsgTimeout", MsgTimeoutV2],
    ["/ibc.applications.transfer.v1.MsgTransfer", MsgTransfer],
  ]);
}
export type TendermintIbcClientOptions = SigningStargateClientOptions & BaseIbcClientOptions & {
  gasPrice: GasPrice;
};


const defaultMerklePrefix = {
  keyPrefix: toAscii("ibc"),
};
const defaultConnectionVersion: Version = {
  identifier: "1",
  features: ["ORDER_ORDERED", "ORDER_UNORDERED"],
};
// this is a sane default, but we can revisit it
const defaultDelayPeriod = 0n;

export interface TendermintIbcClientTypes {
  header: CometHeader;
  consensusState: TendermintConsensusState;
  clientState: TendermintClientState;
  clientArgs: CreateClientArgs;
  lightClientHeader: TendermintHeader;
}
export class TendermintIbcClient extends BaseIbcClient<TendermintIbcClientTypes> {

  public readonly gasPrice: GasPrice;
  public readonly sign: SigningStargateClient;
  public readonly tm: CometClient;

  public readonly query: QueryClient &
    AuthExtension &
    BankExtension &
    IbcExtension &
    StakingExtension;
  public static async connectWithSigner(
    endpoint: string,
    signer: OfflineSigner,
    options: Partial<TendermintIbcClientOptions>
  ): Promise<TendermintIbcClient> {
    options.senderAddress = (await signer.getAccounts())[0].address;
    // override any registry setup, use the other options
    options.gasPrice =  GasPrice.fromString('0.025token');
    const mergedOptions = {
      ...options,
      registry: ibcRegistry(),
    };
    const signingClient = await SigningStargateClient.connectWithSigner(
      endpoint,
      signer,
      mergedOptions,
    );
    const tmClient = await connectComet(endpoint);
    const chainId = await signingClient.getChainId();
    options.chainId = chainId;
    options.clientType = ClientType.Tendermint;
    options.revisionNumber = parseRevisionNumber(chainId);
    return new TendermintIbcClient(
      signingClient,
      tmClient,
      options as TendermintIbcClientOptions,
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
      tmClient,
      setupAuthExtension,
      setupBankExtension,
      setupIbcExtension,
      setupStakingExtension,
    );
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
    this.logger.verbose(
      height === undefined
        ? "Get latest commit"
        : `Get commit for height ${height}`,
    );
    return this.tm.commit(height);
  }

  /** Returns the unbonding period in seconds */
  public async getUnbondingPeriod(): Promise<number> {
    const { params } = await this.query.staking.params();
    const seconds = Number(params?.unbondingTime?.seconds ?? 0);
    if (!seconds) {
      throw new Error("No unbonding period found");
    }
    this.logger.verbose("Queried unbonding period", { seconds });
    return seconds;
  }

  public async getSignedHeader(height?: number): Promise<SignedHeader> {
    const { header: rpcHeader, commit: rpcCommit } =
      await this.getTendermintCommit(height);
    const header = Header.fromPartial({
      ...rpcHeader,
      version: {
        block: BigInt(rpcHeader.version.block),
        app: BigInt(rpcHeader.version.app),
      },
      height: BigInt(rpcHeader.height),
      time: timestampFromDateNanos(rpcHeader.time),
      lastBlockId: {
        hash: rpcHeader.lastBlockId?.hash,
        partSetHeader: rpcHeader.lastBlockId?.parts,
      },
    });

    const signatures = rpcCommit.signatures.map((sig) => ({
      ...sig,
      timestamp: sig.timestamp && timestampFromDateNanos(sig.timestamp),
      blockIdFlag: blockIDFlagFromJSON(sig.blockIdFlag),
    }));
    const commit = Commit.fromPartial({
      height: BigInt(rpcCommit.height),
      round: rpcCommit.round,
      blockId: {
        hash: rpcCommit.blockId.hash,
        partSetHeader: rpcCommit.blockId.parts,
      },
      signatures,
    });
    // For the vote sign bytes, it checks (from the commit):
    //   Height, Round, BlockId, TimeStamp, ChainID

    return { header, commit };
  }
  public async lastKnownHeight(clientId: string): Promise<number> {
    const rawClientState = await this.getLatestClientState(clientId);
    const clientState = ClientState.decode(rawClientState.value);
    return Number(clientState.latestHeight?.revisionHeight ?? 0);

  }
  public async getValidatorSet(height: number): Promise<ValidatorSet> {
    this.logger.verbose(`Get validator set for height ${height}`);
    // we need to query the header to find out who the proposer was, and pull them out
    const { proposerAddress } = await this.header(height);
    const validators = await this.tm.validatorsAll(height);
    const mappedValidators = validators.validators.map((val) => ({
      address: val.address,
      pubKey: mapRpcPubKeyToProto(val.pubkey),
      votingPower: val.votingPower,
      proposerPriority: val.proposerPriority
        ? BigInt(val.proposerPriority)
        : undefined,
    }));
    const totalPower = validators.validators.reduce(
      (accumulator, v) => accumulator + v.votingPower,
      BigInt(0),
    );
    const proposer = mappedValidators.find((val) =>
      arrayContentEquals(val.address, proposerAddress),
    );
    return ValidatorSet.fromPartial({
      validators: mappedValidators,
      totalVotingPower: totalPower,
      proposer,
    });
  }

  // this builds a header to update a remote client.
  // you must pass the last known height on the remote side so we can properly generate it.
  // it will update to the latest state of this chain.
  //
  // This is the logic that validates the returned struct:
  // ibc check: https://github.com/cosmos/cosmos-sdk/blob/v0.41.0/x/ibc/light-clients/07-tendermint/types/update.go#L87-L167
  // tendermint check: https://github.com/tendermint/tendermint/blob/v0.34.3/light/verifier.go#L19-L79
  // sign bytes: https://github.com/tendermint/tendermint/blob/v0.34.3/types/validator_set.go#L762-L821
  //   * https://github.com/tendermint/tendermint/blob/v0.34.3/types/validator_set.go#L807-L810
  //   * https://github.com/tendermint/tendermint/blob/v0.34.3/types/block.go#L780-L809
  //   * https://github.com/tendermint/tendermint/blob/bf9e36d02d2eb22f6fe8961d0d7d3d34307ba38e/types/canonical.go#L54-L65
  //
  // For the vote sign bytes, it checks (from the commit):
  //   Height, Round, BlockId, TimeStamp, ChainID
  public async buildHeader(lastHeight: number): Promise<TendermintHeader> {
    const signedHeader = await this.getSignedHeader();
    // "assert that trustedVals is NextValidators of last trusted header"
    // https://github.com/cosmos/cosmos-sdk/blob/v0.41.0/x/ibc/light-clients/07-tendermint/types/update.go#L74
    const validatorHeight = lastHeight + 1;
    /* eslint @typescript-eslint/no-non-null-assertion: "off" */
    const curHeight = Number(signedHeader.header!.height);
    return TendermintHeader.fromPartial({
      signedHeader,
      validatorSet: await this.getValidatorSet(curHeight),
      trustedHeight: this.revisionHeight(lastHeight),
      trustedValidators: await this.getValidatorSet(validatorHeight),
    });
  }
  public async getConsensusStateAtHeight(clientId: string, consensusHeight?: Height): Promise<Any> {
    const revisionHeight = consensusHeight ? Number(consensusHeight.revisionHeight) : undefined;
    const consensusState =  await this.query.ibc.client.consensusState(clientId, revisionHeight);
    if (!consensusState.consensusState) {
      throw new Error(`Consensus state not found for client ID ${clientId} at height ${consensusHeight}`);
    }
    return consensusState.consensusState;
  }
  public async getLatestClientState(clientId: string): Promise<Any> {

    const clientState = await this.query.ibc.client.state(clientId);
    if (!clientState || !clientState.clientState) {
      throw new Error(`Client state not found for client ID ${clientId}`);
    }
    return clientState.clientState;  
    
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
    const proofHeight = this.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const {
      data: clientState,
      proof: proofClient,
      // proofHeight,
    } = await this.getRawClientStateProof(clientId, queryHeight);

    // This is the most recent state we have on this chain of the other
    const { latestHeight: consensusHeight } =
      await this.query.ibc.client.stateTm(clientId);
    assert(consensusHeight);

    // get the init proof
    const { proof: proofConnection } =
      await this.getRawConnectionProof(
        connectionId,
        queryHeight,
      );

    // get the consensus proof
    const { proof: proofConsensus } =
      await this.getRawConsensusStateProof(
        clientId,
        consensusHeight,
        queryHeight,
      );

    return {
      clientId,
      clientState,
      connectionId,
      proofHeight,
      proofConnection,
      proofClient,
      proofConsensus,
      consensusHeight,
    };
  }

  public async getChannelHandshakeProof(
    portId: string,
    channelId: string,
    headerHeight: Height | number,
  ): Promise<ChannelHandshakeProof> {
    const proofHeight = this.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const { proof } = await this.getRawChannelProof(
      portId,
      channelId,
      queryHeight,
    );

    return {
      id: {
        portId,
        channelId,
      },
      proofHeight,
      proof,
    };
  }

  public async getPacketProof(
    packet: Packet,
    headerHeight: Height | number,
  ): Promise<FullProof> {
    const proofHeight = this.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawPacketCommitmentProof(
      packet.sourcePort,
      packet.sourceChannel,
      packet.sequence,
      queryHeight,
    );

    return proof;
  }

  public async getAckProof(
    originalPacket: Packet,
    headerHeight: Height | number,
  ): Promise<FullProof> {
    const proofHeight = this.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawPacketAcknowledgementProof(
      originalPacket.destinationPort,
      originalPacket.destinationChannel,
      originalPacket.sequence,
      queryHeight,
    );
    return proof;
  }

  public async getTimeoutProof(
    originalPacket: Packet,
    headerHeight: Height | number,
  ): Promise<FullProof> {
    const proofHeight = this.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawReceiptProof(
      originalPacket.destinationPort,
      originalPacket.destinationChannel,
      originalPacket.sequence,
      queryHeight,
    );
    return proof;
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
    const { latestHeight } = await this.query.ibc.client.stateTm(clientId);
    let height: number = 0;
    if (isTendermint(src)) {
      const header = await src.buildHeader(toIntHeight(latestHeight));    
      await this.updateTendermintClient(clientId, header);
      height = Number(header.signedHeader?.header?.height ?? 0);
    }
    return src.revisionHeight(height);
  }

  public async createTendermintClient(
    clientState: TendermintClientState,
    consensusState: TendermintConsensusState,
  ): Promise<CreateClientResult> {
    this.logger.verbose(`Create Tendermint client`);
    const senderAddress = this.senderAddress;
    const createMsg = {
      typeUrl: "/ibc.core.client.v1.MsgCreateClient",
      value: MsgCreateClient.fromPartial({
        signer: senderAddress,
        clientState: {
          typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
          value: TendermintClientState.encode(clientState).finish(),
        },
        consensusState: {
          typeUrl: "/ibc.lightclients.tendermint.v1.ConsensusState",
          value: TendermintConsensusState.encode(consensusState).finish(),
        },
      }),
    };
    this.logger.debug("MsgCreateClient", createMsg);

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [createMsg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    const clientId = result.events
      .find((x) => x.type == "create_client")
      ?.attributes.find((x) => x.key == "client_id")?.value;
    if (!clientId) {
      throw new Error("Could not read TX events.");
    }

    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
      clientId,
    };
  }

  public async updateTendermintClient(
    clientId: string,
    header: TendermintHeader,
  ): Promise<MsgResult> {
    this.logger.verbose(`Update Tendermint client ${clientId}`);
    const senderAddress = this.senderAddress;
    const updateMsg = {
      typeUrl: "/ibc.core.client.v1.MsgUpdateClient",
      value: MsgUpdateClient.fromPartial({
        signer: senderAddress,
        clientId,
        clientMessage: {
          typeUrl: "/ibc.lightclients.tendermint.v1.Header",
          value: TendermintHeader.encode(header).finish(),
        },
      }),
    };

    this.logger.debug(
      `MsgUpdateClient`,
      deepCloneAndMutate(updateMsg, (mutableMsg) => {
        if (mutableMsg.value.clientMessage?.value) {
          mutableMsg.value.clientMessage.value = toBase64AsAny(
            mutableMsg.value.clientMessage.value,
          );
        }
      }),
    );

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [updateMsg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
  }

  public async connOpenInit(
    clientId: string,
    remoteClientId: string,
  ): Promise<CreateConnectionResult> {
    this.logger.info(`Connection open init: ${clientId} => ${remoteClientId}`);
    const senderAddress = this.senderAddress;
    const msg = {
      typeUrl: "/ibc.core.connection.v1.MsgConnectionOpenInit",
      value: MsgConnectionOpenInit.fromPartial({
        clientId,
        counterparty: {
          clientId: remoteClientId,
          prefix: defaultMerklePrefix,
        },
        version: defaultConnectionVersion,
        delayPeriod: defaultDelayPeriod,
        signer: senderAddress,
      }),
    };
    this.logger.debug(`MsgConnectionOpenInit`, msg);

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    const connectionId = result.events
      .find((x) => x.type == "connection_open_init")
      ?.attributes.find((x) => x.key == "connection_id")?.value;
    if (!connectionId) {
      throw new Error("Could not read TX events.");
    }

    this.logger.debug(`Connection open init successful: ${connectionId}`);
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
      connectionId,
    };
  }

  public async connOpenTry(
    myClientId: string,
    proof: ConnectionHandshakeProof,
  ): Promise<CreateConnectionResult> {
    this.logger.info(
      `Connection open try: ${myClientId} => ${proof.clientId} (${proof.connectionId})`,
    );
    const senderAddress = this.senderAddress;
    const {
      clientId,
      connectionId,
      clientState,
      proofHeight,
      proofConnection: proofInit,
      proofClient,
      proofConsensus,
      consensusHeight,
    } = proof;
    const msg = {
      typeUrl: "/ibc.core.connection.v1.MsgConnectionOpenTry",
      value: MsgConnectionOpenTry.fromPartial({
        clientId: myClientId,
        counterparty: {
          clientId,
          connectionId,
          prefix: defaultMerklePrefix,
        },
        delayPeriod: defaultDelayPeriod,
        counterpartyVersions: [defaultConnectionVersion],
        signer: senderAddress,
        clientState,
        proofHeight,
        proofInit,
        proofClient,
        proofConsensus,
        consensusHeight,
      }),
    };
    this.logger.debug(
      "MsgConnectionOpenTry",
      deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofClient = toBase64AsAny(
          mutableMsg.value.proofClient,
        );
        mutableMsg.value.proofConsensus = toBase64AsAny(
          mutableMsg.value.proofConsensus,
        );
        mutableMsg.value.proofInit = toBase64AsAny(mutableMsg.value.proofInit);
      }),
    );

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    const myConnectionId = result.events
      .find((x) => x.type == "connection_open_try")
      ?.attributes.find((x) => x.key == "connection_id")?.value;
    if (!myConnectionId) {
      throw new Error("Could not read TX events.");
    }

    this.logger.debug(
      `Connection open try successful: ${myConnectionId} => ${connectionId}`,
    );
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
      connectionId: myConnectionId,
    };
  }

  public async connOpenAck(
    myConnectionId: string,
    proof: ConnectionHandshakeProof,
  ): Promise<MsgResult> {
    this.logger.info(
      `Connection open ack: ${myConnectionId} => ${proof.connectionId}`,
    );
    const senderAddress = this.senderAddress;
    const {
      connectionId,
      clientState,
      proofHeight,
      proofConnection: proofTry,
      proofClient,
      proofConsensus,
      consensusHeight,
    } = proof;
    const msg = {
      typeUrl: "/ibc.core.connection.v1.MsgConnectionOpenAck",
      value: MsgConnectionOpenAck.fromPartial({
        connectionId: myConnectionId,
        counterpartyConnectionId: connectionId,
        version: defaultConnectionVersion,
        signer: senderAddress,
        clientState,
        proofHeight,
        proofTry,
        proofClient,
        proofConsensus,
        consensusHeight,
      }),
    };
    this.logger.debug(
      "MsgConnectionOpenAck",
      deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofConsensus = toBase64AsAny(
          mutableMsg.value.proofConsensus,
        );
        mutableMsg.value.proofTry = toBase64AsAny(mutableMsg.value.proofTry);
        mutableMsg.value.proofClient = toBase64AsAny(
          mutableMsg.value.proofClient,
        );
      }),
    );

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
  }

  public async connOpenConfirm(
    myConnectionId: string,
    proof: ConnectionHandshakeProof,
  ): Promise<MsgResult> {
    this.logger.info(`Connection open confirm: ${myConnectionId}`);
    const senderAddress = this.senderAddress;
    const { proofHeight, proofConnection: proofAck } = proof;
    const msg = {
      typeUrl: "/ibc.core.connection.v1.MsgConnectionOpenConfirm",
      value: MsgConnectionOpenConfirm.fromPartial({
        connectionId: myConnectionId,
        signer: senderAddress,
        proofHeight,
        proofAck,
      }),
    };
    this.logger.debug(
      "MsgConnectionOpenConfirm",
      deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofAck = toBase64AsAny(mutableMsg.value.proofAck);
      }),
    );

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
  }

  public async channelOpenInit(
    portId: string,
    remotePortId: string,
    ordering: Order,
    connectionId: string,
    version: string,
  ): Promise<CreateChannelResult> {
    this.logger.verbose(
      `Channel open init: ${portId} => ${remotePortId} (${connectionId})`,
    );
    const senderAddress = this.senderAddress;
    const msg = {
      typeUrl: "/ibc.core.channel.v1.MsgChannelOpenInit",
      value: MsgChannelOpenInit.fromPartial({
        portId,
        channel: {
          state: State.STATE_INIT,
          ordering,
          counterparty: {
            portId: remotePortId,
          },
          connectionHops: [connectionId],
          version,
        },
        signer: senderAddress,
      }),
    };
    this.logger.debug("MsgChannelOpenInit", msg);

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    const channelId = result.events
      .find((x) => x.type == "channel_open_init")
      ?.attributes.find((x) => x.key == "channel_id")?.value;
    if (!channelId) {
      throw new Error("Could not read TX events.");
    }

    this.logger.debug(`Channel open init successful: ${channelId}`);
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
      channelId,
    };
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
    this.logger.verbose(
      `Channel open try: ${portId} => ${remote.portId} (${remote.channelId})`,
    );
    const senderAddress = this.senderAddress;
    const { proofHeight, proof: proofInit } = proof;
    const msg = {
      typeUrl: "/ibc.core.channel.v1.MsgChannelOpenTry",
      value: MsgChannelOpenTry.fromPartial({
        portId,
        counterpartyVersion,
        channel: {
          state: State.STATE_TRYOPEN,
          ordering,
          counterparty: remote,
          connectionHops: [connectionId],
          version,
        },
        proofInit,
        proofHeight,
        signer: senderAddress,
      }),
    };
    this.logger.debug(
      "MsgChannelOpenTry",
      deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofInit = toBase64AsAny(mutableMsg.value.proofInit);
      }),
    );

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    const channelId = result.events
      .find((x) => x.type == "channel_open_try")
      ?.attributes.find((x) => x.key == "channel_id")?.value;
    if (!channelId) {
      throw new Error("Could not read TX events.");
    }

    this.logger.debug(
      `Channel open try successful: ${channelId} => ${remote.channelId})`,
    );
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
      channelId,
    };
  }

  public async channelOpenAck(
    portId: string,
    channelId: string,
    counterpartyChannelId: string,
    counterpartyVersion: string,
    proof: ChannelHandshakeProof,
  ): Promise<MsgResult> {
    this.logger.verbose(
      `Channel open ack for port ${portId}: ${channelId} => ${counterpartyChannelId}`,
    );
    const senderAddress = this.senderAddress;
    const { proofHeight, proof: proofTry } = proof;
    const msg = {
      typeUrl: "/ibc.core.channel.v1.MsgChannelOpenAck",
      value: MsgChannelOpenAck.fromPartial({
        portId,
        channelId,
        counterpartyChannelId,
        counterpartyVersion,
        proofTry,
        proofHeight,
        signer: senderAddress,
      }),
    };
    this.logger.debug(
      "MsgChannelOpenAck",
      deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofTry = toBase64AsAny(mutableMsg.value.proofTry);
      }),
    );

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
  }

  public async channelOpenConfirm(
    portId: string,
    channelId: string,
    proof: ChannelHandshakeProof,
  ): Promise<MsgResult> {
    this.logger.verbose(
      `Chanel open confirm for port ${portId}: ${channelId} => ${proof.id.channelId}`,
    );
    const senderAddress = this.senderAddress;
    const { proofHeight, proof: proofAck } = proof;
    const msg = {
      typeUrl: "/ibc.core.channel.v1.MsgChannelOpenConfirm",
      value: MsgChannelOpenConfirm.fromPartial({
        portId,
        channelId,
        proofAck,
        proofHeight,
        signer: senderAddress,
      }),
    };
    this.logger.debug(
      "MsgChannelOpenConfirm",
      deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofAck = toBase64AsAny(mutableMsg.value.proofAck);
      }),
    );

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
  }

  public receivePacket(
    packet: Packet,
    proofCommitment: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.receivePackets([packet], [proofCommitment], proofHeight);
  }

  public async receivePackets(
    packets: readonly Packet[],
    proofCommitments: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    this.logger.verbose(`Receive ${packets.length} packets..`);
    if (packets.length !== proofCommitments.length) {
      throw new Error(
        `Have ${packets.length} packets, but ${proofCommitments.length} proofs`,
      );
    }
    if (packets.length === 0) {
      throw new Error("Must submit at least 1 packet");
    }

    const senderAddress = this.senderAddress;
    const msgs = [];
    for (const i in packets) {
      const packet = packets[i];
      this.logger.verbose(
        `Sending packet #${packet.sequence} from ${this.chainId}:${packet.sourceChannel}`,
        presentPacketData(packet.data),
      );
      const msg = {
        typeUrl: "/ibc.core.channel.v1.MsgRecvPacket",
        value: MsgRecvPacket.fromPartial({
          packet,
          proofCommitment: proofCommitments[i],
          proofHeight,
          signer: senderAddress,
        }),
      };
      msgs.push(msg);
    }
    this.logger.debug("MsgRecvPacket(s)", {
      msgs: msgs.map((msg) =>
        deepCloneAndMutate(msg, (mutableMsg) => {
          mutableMsg.value.proofCommitment = toBase64AsAny(
            mutableMsg.value.proofCommitment,
          );
          if (mutableMsg.value.packet?.data) {
            mutableMsg.value.packet.data = toBase64AsAny(
              mutableMsg.value.packet.data,
            );
          }
        }),
      ),
    });
    const result = await this.sign.signAndBroadcast(
      senderAddress,
      msgs,
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
  }

  public acknowledgePacket(
    ack: Ack,
    proofAcked: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.acknowledgePackets([ack], [proofAcked], proofHeight);
  }

  public async acknowledgePackets(
    acks: readonly Ack[],
    proofAckeds: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    this.logger.verbose(`Acknowledge ${acks.length} packets...`);
    if (acks.length !== proofAckeds.length) {
      throw new Error(
        `Have ${acks.length} acks, but ${proofAckeds.length} proofs`,
      );
    }
    if (acks.length === 0) {
      throw new Error("Must submit at least 1 ack");
    }

    const senderAddress = this.senderAddress;
    const msgs = [];
    for (const i in acks) {
      const packet = acks[i].originalPacket;
      const acknowledgement = acks[i].acknowledgement;

      this.logger.verbose(
        `Ack packet #${packet.sequence} from ${this.chainId}:${packet.sourceChannel}`,
        {
          packet: presentPacketData(packet.data),
          ack: presentPacketData(acknowledgement),
        },
      );
      const msg = {
        typeUrl: "/ibc.core.channel.v1.MsgAcknowledgement",
        value: MsgAcknowledgement.fromPartial({
          packet,
          acknowledgement,
          proofAcked: proofAckeds[i],
          proofHeight,
          signer: senderAddress,
        }),
      };
      msgs.push(msg);
    }
    this.logger.debug("MsgAcknowledgement(s)", {
      msgs: msgs.map((msg) =>
        deepCloneAndMutate(msg, (mutableMsg) => {
          mutableMsg.value.acknowledgement = toBase64AsAny(
            mutableMsg.value.acknowledgement,
          );
          mutableMsg.value.proofAcked = toBase64AsAny(
            mutableMsg.value.proofAcked,
          );
          if (mutableMsg.value.packet?.data) {
            mutableMsg.value.packet.data = toBase64AsAny(
              mutableMsg.value.packet.data,
            );
          }
        }),
      ),
    });
    const result = await this.sign.signAndBroadcast(
      senderAddress,
      msgs,
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
  }

  public timeoutPacket(
    packet: Packet,
    proofUnreceived: Uint8Array,
    nextSequenceRecv: bigint,
    proofHeight: Height,
  ): Promise<MsgResult> {
    return this.timeoutPackets(
      [packet],
      [proofUnreceived],
      [nextSequenceRecv],
      proofHeight,
    );
  }

  public async timeoutPackets(
    packets: Packet[],
    proofsUnreceived: Uint8Array[],
    nextSequenceRecv: bigint[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    if (packets.length !== proofsUnreceived.length) {
      throw new Error("Packets and proofs must be same length");
    }
    if (packets.length !== nextSequenceRecv.length) {
      throw new Error("Packets and sequences must be same length");
    }

    this.logger.verbose(`Timeout ${packets.length} packets...`);
    const senderAddress = this.senderAddress;

    const msgs = [];
    for (const i in packets) {
      const packet = packets[i];
      this.logger.verbose(
        `Timeout packet #${packet.sequence} from ${this.chainId}:${packet.sourceChannel}`,
        presentPacketData(packet.data),
      );

      const msg = {
        typeUrl: "/ibc.core.channel.v1.MsgTimeout",
        value: MsgTimeout.fromPartial({
          packet,
          proofUnreceived: proofsUnreceived[i],
          nextSequenceRecv: nextSequenceRecv[i],
          proofHeight,
          signer: senderAddress,
        }),
      };
      msgs.push(msg);
    }

    this.logger.debug("MsgTimeout", {
      msgs: msgs.map((msg) =>
        deepCloneAndMutate(msg, (mutableMsg) => {
          if (mutableMsg.value.packet?.data) {
            mutableMsg.value.packet.data = toBase64AsAny(
              mutableMsg.value.packet.data,
            );
          }
          mutableMsg.value.proofUnreceived = toBase64AsAny(
            mutableMsg.value.proofUnreceived,
          );
        }),
      ),
    });
    const result = await this.sign.signAndBroadcast(
      senderAddress,
      msgs,
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
  }
  public async queryRawProof(store: string, queryKey: Uint8Array, proofHeight: number): Promise<ProvenQuery> {

    const { key, value, height, proof, code, log } = await this.tm.abciQuery({
      path: `/store/${store}/key`,
      data: queryKey,
      height: proofHeight,
      prove: true
    });

    if (code) {
      throw new Error(`Query failed with (${code}): ${log}`);
    }

    if (!arrayContentEquals(queryKey, key)) {
      throw new Error(`Response key ${toHex(key)} doesn't match query key ${toHex(queryKey)}`);
    }

    if (!height) {
      throw new Error("No query height returned");
    }
    if (!proof || proof.ops.length !== 2) {
      throw new Error(`Expected 2 proof ops, got ${proof?.ops.length ?? 0}. Are you using stargate?`);
    }

    // we don't need the results, but we can ensure the data is the proper format
    checkAndParseOp(proof.ops[0], "ics23:iavl", key);
    checkAndParseOp(proof.ops[1], "ics23:simple", toAscii(store));

    return {
      key: key,
      value: value,
      height: height,
      // need to clone this: readonly input / writeable output
      proof: {
        ops: [...proof.ops],
      },
    };
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
      senderAddress,
      [msg],
      "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    return result;
  }
  public async getTendermintConsensusState(clientId: string, consensusHeight: Height, proofHeight: Height): Promise<{ consensusState: ConsensusState, proof: Uint8Array }> {

    const state = await this.getRawConsensusStateProof(clientId, consensusHeight, proofHeight);
    if (!state.data) {
      throw new Error(`No consensus state found for client ${clientId} at height ${consensusHeight}`);
    }
    return { consensusState: ConsensusState.decode(state.data.value), proof: state.proof };

  }
  public async getTendermintClientState(clientId: string, proofHeight: Height): Promise<{ clientState: ClientState, proof: Uint8Array }> {

    const state = await this.getRawClientStateProof(clientId, proofHeight);
    if (!state.data) {
      throw new Error(`No proven client state found for client ${clientId} at height ${proofHeight}`);
    }
    return { clientState: ClientState.decode(state.data.value), proof: state.proof };
  }

  public async getRawChannelProof(portId: string, channelId: string, proofHeight: Height): Promise<FullProof> {

    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = toAscii(
      `channelEnds/ports/${portId}/channels/${channelId}`,
    );
    const proven = await this.queryRawProof(
      "ibc",
      key,
      Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
    return { data: Any.decode(proven.value), proof, proofHeight };
  }
  public async getRawReceiptProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<FullProof> {

    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = toAscii(
      `receipts/ports/${portId}/channels/${channelId}/sequences/${sequence}`,
    );
    const proven = await this.queryRawProof(
      "ibc",
      key,
      Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
    return { data: Any.decode(proven.value), proof, proofHeight };
  }
  public async getRawPacketCommitmentProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<FullProof> {

    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = toAscii(
      `commitments/ports/${portId}/channels/${channelId}/sequences/${sequence}`,
    );
    const proven = await this.queryRawProof(
      "ibc",
      key,
      Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);

    return { data: Any.decode(proven.value), proof, proofHeight };
  }
  public async getRawPacketAcknowledgementProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<FullProof> {

    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = toAscii(
      `acks/ports/${portId}/channels/${channelId}/sequences/${sequence}`,
    );
    const proven = await this.queryRawProof(
      "ibc",
      key,
      Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);

    return { data: Any.decode(proven.value), proof, proofHeight };
  }
  public async getRawNextSequenceRecvProof(portId: string, channelId: string, proofHeight: Height): Promise<DataProof> {

    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = toAscii(
      `nextSequenceRecv/ports/${portId}/channels/${channelId}`,
    );
    const proven = await this.queryRawProof(
      "ibc",
      key,
      Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
    return { data: proven.value, proof, proofHeight };
  }

  public async getRawClientStateProof(clientId: string, proofHeight: Height): Promise<FullProof> {

    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = `clients/${clientId}/clientState`;
    const proven = await this.queryRawProof(
      "ibc",
      toAscii(key),
      Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);

    return { data: Any.decode(proven.value), proof, proofHeight };
  }
  public async getRawConsensusStateProof(clientId: string, consensusHeight: Height, proofHeight: Height): Promise<FullProof> {

    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const height = heightQueryString(consensusHeight);
    const key = `clients/${clientId}/consensusStates/${height}`;
    const proven = await this.queryRawProof(
      "ibc",
      toAscii(key),
      Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
   
    return { data: Any.decode(proven.value), proof, proofHeight };
  }

  public async getRawConnectionProof(connectionId: string, proofHeight: Height): Promise<FullProof> {

    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = `connections/${connectionId}`;
    const proven = await this.queryRawProof(
      "ibc",
      toAscii(key),
      Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);

    return { data: Any.decode(proven.value), proof, proofHeight };
  }
  public async getNextSequenceRecv(portId: string, channelId: string): Promise<bigint> {
    
    const sequence = await this.query.ibc.channel.nextSequenceReceive(portId, channelId);
    if (!sequence.nextSequenceReceive) {
      throw new Error(`No next sequence receive found for port ${portId} and channel ${channelId}`);
    }
    return sequence.nextSequenceReceive;

  }
  public async getConnection(connectionId: string): Promise<Partial<QueryConnectionResponse>> {

    const connection = await this.query.ibc.connection.connection(connectionId)
    if (!connection.connection) {
      throw new Error(`No connection ${connectionId} found`);
    }
    return connection;
  }
  public async searchTendermintBlocks(query: string): Promise<BlockSearchResponse> {

    const search = await this.tm.blockSearchAll({ query });
    return search;

  }
  public async getTendermintBlockResults(height: number): Promise<BlockResultsResponse> {

    const result = await this.tm.blockResults(height);
    return result;

  }
  public async searchTendermintTxs(query: string): Promise<TxSearchResponse> {

    const search = await this.tm.txSearchAll({ query });
    return search;

  }
  public async querySentPackets(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[]> {
    
    const txsPackets = await this.getPacketsFromTxs(connectionId, minHeight, maxHeight );
    const eventsPackets = await this.getPacketsFromBlockEvents(connectionId, minHeight, maxHeight);
    return ([] as PacketWithMetadata[])
      .concat(...txsPackets)
      .concat(...eventsPackets);
  }
  public async queryWrittenAcks(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<AckWithMetadata[]> {
    
    let query = `write_acknowledgement.packet_connection='${connectionId}'`;
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintTxs(query);
    const out = search.txs.flatMap(({ height, result, hash }) => {
      const events = result.events.map(fromTendermintEvent);
      // const sender = logs.findAttribute(parsedLogs, 'message', 'sender').value;
      return parseAcksFromTxEvents(events).map(
        (ack): AckWithMetadata => ({
          height,
          txHash: toHex(hash).toUpperCase(),
          txEvents: events,
          ...ack,
        }),
      );
    });
    return out;
  }
  public async queryUnreceivedPackets(portId: string, channelId: string, sequences: readonly number[]) {
    const res = await this.query.ibc.channel.unreceivedPackets(
        portId,
        channelId,
        sequences,
      );
      return res.sequences.map((seq) => Number(seq));
  }
  public async queryCommitments(portId: string, channelId: string, sequence: bigint): Promise<Uint8Array> {
    
    const res = await this.query.ibc.channel.packetCommitment(
      portId,
      channelId,
      Number(sequence),
    );
    return res.commitment;
  }
  public async queryUnreceivedAcks(portId: string, channelId: string, sequences: readonly number[]) {
    const res = await this.query.ibc.channel.unreceivedAcks(
        portId,
        channelId,
        sequences,
      );
      return res.sequences.map((seq) => Number(seq));
  }
  public async buildCreateClientArgs(trustPeriodSec?: number | null): Promise<CreateClientArgs> {

    const header = await this.latestHeader();
    const consensusState = buildTendermintConsensusState(header);
    const unbondingPeriodSec = await this.getUnbondingPeriod();
    if (trustPeriodSec === undefined || trustPeriodSec === null) {
      trustPeriodSec = Math.floor((unbondingPeriodSec * 2) / 3);
    }
    const clientState = buildTendermintClientState(
      this.chainId,
      unbondingPeriodSec,
      trustPeriodSec,
      this.revisionHeight(header.height),
    );
    return { consensusState, clientState };
  }

  async getPacketsFromBlockEvents(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined) {
    let query = `send_packet.packet_connection='${connectionId}'`;
    if (minHeight) {
      query = `${query} AND block.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND block.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintBlocks(query);
    const resultsNested = await Promise.all(
      search.blocks.map(async ({ block }) => {
        const height = block.header.height;
        const result = await this.getTendermintBlockResults(height);
        return parsePacketsFromBlockResult(result).map((packet) => ({
          packet,
          height,
          sender: "",
        }));
      }),
    );

    return ([] as PacketWithMetadata[]).concat(...resultsNested);
  }
  async getPacketsFromTxs(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined) {

    let query = `send_packet.packet_connection='${connectionId}'`;
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintTxs(query);
    const resultsNested = search.txs.map(
      ({ height, result }): PacketWithMetadata[] =>
        parsePacketsFromTendermintEvents(result.events).map((packet) => ({
          packet,
          height,
        })),
    );
    return resultsNested.flat();
  }
}
