/* eslint-disable max-lines */
import {
  Any,
} from "@atomone/cosmos-ibc-types/google/protobuf/any.js";
import {
  fromTimestamp,
} from "@atomone/cosmos-ibc-types/helpers.js";
import {
  Order, Packet,
} from "@atomone/cosmos-ibc-types/ibc/core/channel/v1/channel.js";
import {
  Packet as PacketV2,
} from "@atomone/cosmos-ibc-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/cosmos-ibc-types/ibc/core/client/v1/client.js";
import {
  QueryConnectionResponse,
} from "@atomone/cosmos-ibc-types/ibc/core/connection/v1/query.js";
import {
  ClientState as TendermintClientState,
  ConsensusState as TendermintConsensusState,
  Header as TendermintHeader,
} from "@atomone/cosmos-ibc-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  fromBase64,
  fromHex, toAscii, toBech32, toHex,
} from "@cosmjs/encoding";
import {
  GasPrice,
} from "@cosmjs/stargate";
import {
  arrayContentEquals, sleep,
} from "@cosmjs/utils";
import {
  decodeTxMessages,
  fundsToCoins,
  GnoJSONRPCProvider,
  GnoWallet,
  MemFile,
  MemPackage,
  MsgEndpoint,
  MsgRun,
} from "@gnolang/gno-js-client";
import {
  ibc,
  tendermint,
} from "@gnolang/gno-types";
import {
  CreateWalletOptions,
  TransactionEndpoint,
  Tx,
  TxFee,
} from "@gnolang/tm2-js-client";
import {
  CommitResponse,
} from "@gnolang/tm2-rpc";
import {
  connectTm2, ReadonlyDateWithNanoseconds, Tm2Client,
} from "@gnolang/tm2-rpc";
import {
  MerkleProof,
} from "cosmjs-types/ibc/core/commitment/v1/commitment.js";
import {
  GraphQLClient,
} from "graphql-request";
import Long from "long";

import {
  Ack, AckV2, AckV2WithMetadata, AckWithMetadata, AnyClientState, AnyConsensusState, BlockResultsResponse, BlockSearchResponse, ChannelHandshakeProof, ChannelInfo, ClientType, ConnectionHandshakeProof, CreateChannelResult, CreateClientResult, CreateConnectionResult, DataProof, FullProof, MsgResult, PacketV2WithMetadata, PacketWithMetadata, ProvenQuery, TxSearchResponse,
} from "../../types/index.js";
import {
  buildGnoClientState, buildGnoConsensusState, buildTendermintClientState, checkAndParseOp, convertProofsToIcs23, getErrorMessage, heightQueryString, mergeUint8Arrays, parsePacketsFromBlockResult, parsePacketsFromBlockResultV2, parsePacketsFromTendermintEvents, parsePacketsFromTendermintEventsV2, parseRevisionNumber, subtractBlock, timestampFromDateNanos, toIntHeight,
} from "../../utils/utils.js";
import {
  BaseIbcClient, BaseIbcClientOptions, isGno, isTendermint,
} from "../BaseIbcClient.js";
import {
  acknowledgement,
  createClientTemplate, recvPacket, registerCounterParty, timeout, updateClientTemplate,
} from "./queries.js";
import {
  ProofHelper,
} from "./templates/ProofHelper.js";

export type GnoIbcClientOptions = CreateWalletOptions & BaseIbcClientOptions & {
  gasPrice: GasPrice
};

export interface GnoIbcClientTypes {
  header: ibc.lightclients.gno.v1.gno.GnoHeader
  consensusState: ibc.lightclients.gno.v1.gno.ConsensusState
  clientState: ibc.lightclients.gno.v1.gno.ClientState
  lightClientHeader: ibc.lightclients.gno.v1.gno.Header
}

/** Represents an attribute in a Gno event */
interface GnoEventAttr {
  key: string
  value: string
}

/** Represents a Gno event from GraphQL response */
interface GnoEvent {
  type: string
  attrs: GnoEventAttr[]
}

/** Represents a transaction response from GraphQL */
interface GnoTxResponse {
  block_height: string
  hash: string
  response: {
    events: GnoEvent[]
  }
}

/** Represents the GraphQL response for transaction queries */
interface GnoGraphQLResponse {
  getTransactions: GnoTxResponse[] | null
}

export class GnoIbcClient extends BaseIbcClient<GnoIbcClientTypes> {
  public readonly gasPrice: GasPrice;
  public readonly sign: GnoWallet;
  public readonly tm: Tm2Client;
  public readonly graphClient: GraphQLClient;
  public readonly addressPrefix: string;

  public static async connectWithSigner(
    endpoint: string,
    queryEndpoint: string,
    signer: GnoWallet,
    options: Partial<GnoIbcClientOptions>,
  ): Promise<GnoIbcClient> {
    options.senderAddress = await signer.getAddress();
    // override any registry setup, use the other options

    const provider = new GnoJSONRPCProvider(endpoint);
    const tmClient = await connectTm2(endpoint);
    const graphClient = new GraphQLClient(queryEndpoint);
    const chainId = (await tmClient.status()).nodeInfo.network;
    options.chainId = chainId;
    options.clientType = ClientType.Gno;
    options.revisionNumber = parseRevisionNumber(chainId);
    signer.connect(provider);
    return new GnoIbcClient(
      signer, tmClient, graphClient, options as GnoIbcClientOptions,
    );
  }

  private constructor(
    signingClient: GnoWallet,
    tmClient: Tm2Client,
    graphClient: GraphQLClient,
    options: GnoIbcClientOptions,
  ) {
    super(options);
    this.sign = signingClient;
    this.tm = tmClient;
    this.graphClient = graphClient;
    this.addressPrefix = options.addressPrefix;
    this.gasPrice = options.gasPrice;
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
    return this.revisionHeight(Number(header.height) + blocksInFuture);
  }

  public async getChainId(): Promise<string> {
    this.logger.verbose("Get chain ID");
    return (await this.tm.status()).nodeInfo.network;
  }

  public async header(height: number): Promise<ibc.lightclients.gno.v1.gno.GnoHeader> {
    this.logger.verbose(`Get header for height ${height}`);
    // TODO: expose header method on tmClient and use that
    const resp = await this.tm.blockchain(height, height);
    if (resp.blockMetas.length === 0) {
      throw new Error(`No block found at height ${height}`);
    }
    const blockMeta = resp.blockMetas[0];
    return {
      ...blockMeta.header,
      height: BigInt(blockMeta.header.height),
      time: timestampFromDateNanos(blockMeta.header.time),
      proposerAddress: blockMeta.header.proposerAddress,
    };
  }

  public async latestHeader(): Promise<ibc.lightclients.gno.v1.gno.GnoHeader> {
    // TODO: expose header method on tmClient and use that
    const status = await this.tm.status();
    const block = await this.tm.block(status.syncInfo.latestBlockHeight);
    return {
      ...block.block.header,
      height: BigInt(block.block.header.height),
      time: timestampFromDateNanos(block.block.header.time),
      proposerAddress: block.block.header.proposerAddress,
    };
  }

  public async currentTime(): Promise<ReadonlyDateWithNanoseconds> {
    // const status = await this.tm.status();
    // return status.syncInfo.latestBlockTime;
    return fromTimestamp((await this.latestHeader()).time);
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

  public async getGnoCommit(height?: number): Promise<CommitResponse> {
    this.logger.verbose(
      height === undefined
        ? "Get latest commit"
        : `Get commit for height ${height}`,
    );
    const res = await this.tm.commit(height);
    return res;
  }

  /** Returns the unbonding period in seconds */
  public async getUnbondingPeriod(): Promise<number> {
    /*
    const {
      params,
    } = await this.query.staking.params();
    const seconds = Number(params?.unbondingTime?.seconds ?? 0);
    if (!seconds) {
      throw new Error("No unbonding period found");
    }
    this.logger.verbose("Queried unbonding period", {
      seconds,
    });
    */
    // hardcode to 24h for now, see: https://github.com/gnolang/gno/issues/4829
    const seconds = 60 * 60 * 24;
    return seconds;
  }

  public async getSignedHeader(height?: number): Promise<ibc.lightclients.gno.v1.gno.SignedHeader> {
    const {
      header: rpcHeader, commit: rpcCommit,
    }
      = await this.getGnoCommit(height);
    const header = ibc.lightclients.gno.v1.gno.GnoHeader.fromPartial({
      ...rpcHeader,
      proposerAddress: rpcHeader.proposerAddress,
      //  dataHash: rpcHeader.dataHash.length > 0 ? rpcHeader.dataHash : sha256(new Uint8Array()),
      //  lastResultsHash: rpcHeader.lastResultsHash.length > 0 ? rpcHeader.lastResultsHash : sha256(new Uint8Array()),
      version: rpcHeader.version,
      height: BigInt(rpcHeader.height),
      time: timestampFromDateNanos(rpcHeader.time),
      lastBlockId: {
        hash: rpcHeader.lastBlockId?.hash,
        partsHeader: {
          hash: rpcHeader.lastBlockId?.parts.hash,
          total: rpcHeader.lastBlockId?.parts.total,
        },
      },
    });

    const signatures = rpcCommit.precommits.map(sig => ({
      ...sig,
      height: BigInt(sig.height),
      round: BigInt(sig.round),
      blockId: {
        hash: sig.blockId?.hash,
        partsHeader: sig.blockId?.parts,
      },
      validatorAddress: sig.validatorAddress,
      validatorIndex: BigInt(sig.validatorIndex),
      timestamp: sig.timestamp && timestampFromDateNanos(sig.timestamp),
    }));
    const commit = ibc.lightclients.gno.v1.gno.Commit.fromPartial({
      blockId: {
        hash: rpcCommit.blockId.hash,
        partsHeader: rpcCommit.blockId.parts,
      },
      precommits: signatures,
    });
    // For the vote sign bytes, it checks (from the commit):
    //   Height, Round, BlockId, TimeStamp, ChainID
    return {
      header,
      commit,
    };
  }

  public async getValidatorSet(height: number): Promise<ibc.lightclients.gno.v1.gno.ValidatorSet> {
    this.logger.verbose(`Get validator set for height ${height}`);
    // we need to query the header to find out who the proposer was, and pull them out
    const {
      proposerAddress,
    } = await this.header(height);
    const validators = await this.tm.validators({
      height,
    });

    const mappedValidators = validators.validators.map(val => ({
      address: toBech32(this.addressPrefix, val.address),
      pubKey: tendermint.crypto.keys.PublicKey.fromPartial({
        ed25519: val.pubkey.data,
      }),
      votingPower: val.votingPower,
      proposerPriority: val.proposerPriority
        ? BigInt(val.proposerPriority)
        : undefined,
    }));
    const proposer = mappedValidators.find(val =>
      val.address === proposerAddress,
    );
    return ibc.lightclients.gno.v1.gno.ValidatorSet.fromPartial({
      validators: mappedValidators.map((val) => {
        return ibc.lightclients.gno.v1.gno.Validator.fromPartial(val);
      }),
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
  public async buildHeader(lastHeight: number): Promise<ibc.lightclients.gno.v1.gno.Header> {
    const signedHeader = await this.getSignedHeader();
    // "assert that trustedVals is NextValidators of last trusted header"
    // https://github.com/cosmos/cosmos-sdk/blob/v0.41.0/x/ibc/light-clients/07-tendermint/types/update.go#L74
    const validatorHeight = lastHeight + 1;
    /* eslint @typescript-eslint/no-non-null-assertion: "off" */
    const curHeight = Number(signedHeader.header!.height);
    return ibc.lightclients.gno.v1.gno.Header.fromPartial({
      signedHeader,
      validatorSet: await this.getValidatorSet(curHeight),
      trustedHeight: this.revisionHeight(lastHeight),
      trustedValidators: await this.getValidatorSet(validatorHeight),
    });
  }

  public async getGnoConsensusStateAtHeight(_clientId: string, _consensusHeight?: Height): Promise<AnyConsensusState> {
    throw new Error("Gno LC on Gno not implemented.");
  }

  public async getTendermintConsensusStateAtHeight(clientId: string, consensusHeight?: Height): Promise<TendermintConsensusState> {
    const consensusState = consensusHeight
      ? await this.tm.abciQuery({
        path: "vm/qrender",
        data: Buffer.from(`gno.land/r/aib/ibc/core:clients/${clientId}/consensus_states/${consensusHeight.revisionNumber}/${consensusHeight.revisionHeight}`, "utf-8"),
      })
      : await this.tm.abciQuery({
        path: "vm/qrender",
        data: Buffer.from(`gno.land/r/aib/ibc/core:clients/${clientId}`, "utf-8"),
      });
    if (consensusState.responseBase.error) {
      throw new Error(`Consensus state not found for client ID ${clientId} at height ${consensusHeight}:` + consensusState.responseBase.error);
    }
    try {
      let data = consensusHeight ? JSON.parse(Buffer.from(consensusState.responseBase.data).toString("utf-8")) : JSON.parse(Buffer.from(consensusState.responseBase.data).toString("utf-8")).last_consensus_state;
      if (Array.isArray(data)) {
        data = data[data.length - 1];
      }
      return {
        timestamp: {
          seconds: data.timestamp,
          nanos: 0,
        },
        root: {
          hash: fromBase64(data.root),
        },
        nextValidatorsHash: fromBase64(data.next_validators_hash),
      };
    }
    catch (e) {
      throw new Error(`Failed to parse consensus state for client ID ${clientId} at height ${consensusHeight}: ${getErrorMessage(e)}`);
    }
  }

  public async getConsensusStateAtHeight(clientId: string, type: ClientType, consensusHeight?: Height): Promise<AnyConsensusState> {
    if (type === ClientType.Tendermint) {
      return this.getTendermintConsensusStateAtHeight(clientId, consensusHeight);
    }
    if (type === ClientType.Gno) {
      return this.getGnoConsensusStateAtHeight(clientId, consensusHeight);
    }
    throw new Error(`Unsupported chain type ${type} for getting consensus state.`);
  }

  public async getLatestClientState(clientId: string, type: ClientType): Promise<AnyClientState> {
    if (type === ClientType.Tendermint) {
      return this.getLatestTendermintClientState(clientId);
    }
    if (type === ClientType.Gno) {
      return this.getLatestGnoClientState(clientId);
    }
    throw new Error(`Unsupported chain type ${type} for getting latest client state.`);
  }

  public async getLatestTendermintClientState(clientId: string): Promise<TendermintClientState> {
    const clientState = await this.tm.abciQuery({
      path: "vm/qrender",
      data: Buffer.from(`gno.land/r/aib/ibc/core:clients/${clientId}`, "utf-8"),
    });
    if (clientState.responseBase.error) {
      throw new Error(`Client state not found for client ID ${clientId}: ${clientState.responseBase.error}`);
    }
    try {
      const data = JSON.parse(Buffer.from(clientState.responseBase.data).toString("utf-8"));
      const clientStateTm = buildTendermintClientState(data.client_state.chain_id, data.client_state.unbonding_period, data.client_state.trusting_period,
        {
          revisionNumber: BigInt(data.client_state.latest_height.revision_number),
          revisionHeight: BigInt(data.client_state.latest_height.revision_height),
        });
      clientStateTm.frozenHeight = {
        revisionNumber: BigInt(data.client_state.frozen_height.revision_number),
        revisionHeight: BigInt(data.client_state.frozen_height.revision_height),
      };
      clientStateTm.trustLevel = {
        numerator: BigInt(data.client_state.trust_level.numerator),
        denominator: BigInt(data.client_state.trust_level.denominator),
      };
      clientStateTm.maxClockDrift = {
        seconds: BigInt(data.client_state.max_clock_drift),
        nanos: 0,
      };

      return clientStateTm;
    }
    catch (e) {
      throw new Error(`Failed to parse client state: ${getErrorMessage(e)}`);
    }
  }

  public async getLatestGnoClientState(_clientId: string): Promise<ibc.lightclients.gno.v1.gno.ClientState> {
    throw new Error("Gno LC on Gno not implemented.");
  }

  // trustedHeight must be proven by the client on the destination chain
  // and include a proof for the connOpenInit (eg. must be 1 or more blocks after the
  // block connOpenInit Tx was in).
  //
  // pass a header height that was previously updated to on the remote chain using updateClient.
  // note: the queries will be for the block before this header, so the proofs match up (appHash is on H+1)
  public async getConnectionHandshakeProof(
    _clientId: string,
    _connectionId: string,
    _headerHeight: Height | number,
  ): Promise<ConnectionHandshakeProof> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async getChannelHandshakeProof(
    _portId: string,
    _channelId: string,
    _headerHeight: Height | number,
  ): Promise<ChannelHandshakeProof> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async getPacketProof(
    _packet: Packet,
    _headerHeight: Height | number,
  ): Promise<DataProof> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async getAckProof(
    _originalPacket: Packet,
    _headerHeight: Height | number,
  ): Promise<DataProof> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async getTimeoutProof(
    _originalPacket: Packet,
    _headerHeight: Height | number,
  ): Promise<DataProof> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async getPacketProofV2(
    packet: PacketV2,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    const proofHeight = this.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawPacketCommitmentProofV2(
      packet.sourceClient, packet.sequence, queryHeight,
    );

    return proof;
  }

  public async getAckProofV2(
    originalPacket: PacketV2,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    const proofHeight = this.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawPacketAcknowledgementProofV2(
      originalPacket.destinationClient, originalPacket.sequence, queryHeight,
    );
    return proof;
  }

  public async getTimeoutProofV2(
    originalPacket: PacketV2,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    const proofHeight = this.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawReceiptProofV2(
      originalPacket.destinationClient, originalPacket.sequence, queryHeight,
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
    const {
      latestHeight,
    } = await this.getLatestClientState(clientId, src.clientType);
    let height: number = 0;
    if (isTendermint(src)) {
      const header = await src.buildHeader(toIntHeight(latestHeight));
      await this.updateTendermintClient(clientId, header);
      height = Number(header.signedHeader?.header?.height ?? 0);
    }
    if (isGno(src)) {
      const header = await src.buildHeader(toIntHeight(latestHeight));
      await this.updateGnoClient(clientId, header);
      height = Number(header.signedHeader?.header?.height ?? 0);
    }
    return src.revisionHeight(height);
  }

  public async createTendermintClient(
    clientState: TendermintClientState,
    consensusState: TendermintConsensusState,
  ): Promise<CreateClientResult> {
    const rundotgno = createClientTemplate({
      chainID: clientState.chainId,
      revisionNumber: clientState.latestHeight?.revisionNumber.toString() ?? "0",
      revisionHeight: clientState.latestHeight?.revisionHeight.toString() ?? "0",
      unbondingPeriod: `time.Second * ${clientState.unbondingPeriod?.seconds.toString() ?? "0"}`,
      trustingPeriod: `time.Second * ${clientState.trustingPeriod?.seconds.toString() ?? "0"}`,
      maxClockDrift: `time.Second * ${clientState.maxClockDrift?.seconds.toString() ?? "0"}`,
      appHash: toHex(consensusState.root?.hash ?? new Uint8Array()),
      nextValHash: toHex(consensusState.nextValidatorsHash ?? new Uint8Array()),
      timestampSec: consensusState.timestamp?.seconds.toString() ?? "0",
      timestampNanos: consensusState.timestamp?.nanos.toString() ?? "0",
    });
    this.logger.verbose("Create Tendermint client");
    const memFile = MemFile.fromPartial({
      name: "run.gno",
      body: rundotgno,
    });
    const memPackage = MemPackage.fromPartial({
      files: [memFile],
      name: "main",
      path: "",
    });

    const result = await this.sign.executePackage(memPackage, TransactionEndpoint.BROADCAST_TX_COMMIT, new Map(), (new Map()).set("ugnot", 3000000),
      {
        gas_wanted: new Long(50000000),
        gas_fee: "750000ugnot",
      });

    if (result.deliver_tx.ResponseBase.Error) {
      throw new Error(`Failed to create Tendermint client: ${result.deliver_tx.ResponseBase.Error}`);
    }
    const clientId = atob(result.deliver_tx.ResponseBase.Data);

    return {
      events: [],
      transactionHash: Buffer.from(fromBase64(result.hash)).toString("hex").toUpperCase(),
      height: Number(result.height),
      clientId,
    };
  }

  public async createGnoClient(
    _clientState: ibc.lightclients.gno.v1.gno.ClientState,
    _consensusState: ibc.lightclients.gno.v1.gno.ConsensusState,
  ): Promise<CreateClientResult> {
    throw new Error("Gno LC on Gno not implemented.");
  }

  public async updateTendermintClient(
    clientId: string,
    header: TendermintHeader,
  ): Promise<MsgResult> {
    this.logger.verbose(`Update Tendermint client ${clientId}`);
    const rundotgno = updateClientTemplate({
      clientId,
      openBr: "{",
      closeBr: "}",
      chainID: header.signedHeader.header.chainId,
      appHash: toHex(header.signedHeader.header.appHash ?? new Uint8Array()),
      revisionNumber: header.signedHeader.header.height.toString(),
      revisionHeight: header.signedHeader.header.height.toString(),
      timeSec: header.signedHeader.header.time.seconds.toString(),
      timeNanos: header.signedHeader.header.time.nanos.toString(),
      blockHash: toHex(header.signedHeader.header.lastBlockId?.hash ?? new Uint8Array()),
      partSetTotal: header.signedHeader.header.lastBlockId?.partSetHeader?.total.toString() ?? "0",
      partSetHash: toHex(header.signedHeader.header.lastBlockId?.partSetHeader?.hash ?? new Uint8Array()),
      consensusHash: toHex(header.signedHeader.header.consensusHash ?? new Uint8Array()),
      lastCommitHash: toHex(header.signedHeader.header.lastCommitHash ?? new Uint8Array()),
      lastResultsHash: toHex(header.signedHeader.header.lastResultsHash ?? new Uint8Array()),
      evidenceHash: toHex(header.signedHeader.header.evidenceHash ?? new Uint8Array()),
      dataHash: toHex(header.signedHeader.header.dataHash ?? new Uint8Array()),
      validatorsHash: toHex(header.signedHeader.header.validatorsHash ?? new Uint8Array()),
      nextValidatorsHash: toHex(header.signedHeader.header.nextValidatorsHash ?? new Uint8Array()),
      proposerAddress: toHex(header.signedHeader.header.proposerAddress),
      totalVotingPower: header.validatorSet.validators.reduce((sum, val) => sum + val.votingPower, 0n).toString(),
      validators: header.validatorSet.validators.map(val => ({
        address: toHex(val.address),
        pubKey: toHex(val.pubKey.ed25519 ?? val.pubKey.secp256k1 ?? new Uint8Array()),
        votingPower: val.votingPower.toString(),
      })),
      proposerPubKey: toHex(header.validatorSet.validators.find(v => toHex(v.address) === toHex(header.signedHeader.header.proposerAddress))?.pubKey.ed25519 ?? new Uint8Array()),
      proposerVotingPower: header.validatorSet.validators.find(v => toHex(v.address) === toHex(header.signedHeader.header.proposerAddress))?.votingPower.toString() ?? "0",
      trustedRevisionNumber: header.trustedHeight.revisionNumber.toString(),
      trustedRevisionHeight: header.trustedHeight.revisionHeight.toString(),
      trustedValidators: header.trustedValidators.validators.map(val => ({
        address: toHex(val.address),
        pubKey: toHex(val.pubKey.ed25519 ?? val.pubKey.secp256k1 ?? new Uint8Array()),
        votingPower: val.votingPower.toString(),
      })),
      trustedProposerAddress: toHex(header.trustedValidators.proposer?.address ?? new Uint8Array()),
      trustedProposerPubKey: toHex(header.trustedValidators.proposer?.pubKey.ed25519 ?? header.trustedValidators.proposer?.pubKey.secp256k1 ?? new Uint8Array()),
      trustedVotingPower: header.trustedValidators.validators.reduce((sum, val) => sum + val.votingPower, 0n).toString(),
      trustedProposerVotingPower: header.trustedValidators.proposer?.votingPower.toString() ?? "0",
      commitHeight: header.signedHeader.commit.height.toString(),
      commitRound: header.signedHeader.commit.round.toString(),
      commitBlockIdHash: toHex(header.signedHeader.commit.blockId?.hash ?? new Uint8Array()),
      commitPartSetTotal: header.signedHeader.commit.blockId?.partSetHeader?.total.toString() ?? "0",
      commitPartSetHash: toHex(header.signedHeader.commit.blockId?.partSetHeader?.hash ?? new Uint8Array()),
      commitSignatures: header.signedHeader.commit.signatures.map(sig => ({
        validatorAddress: toHex(sig.validatorAddress),
        signature: toHex(sig.signature),
        timestampSeconds: sig.timestamp ? sig.timestamp.seconds.toString() : "0",
        timestampNanos: sig.timestamp ? sig.timestamp.nanos.toString() : "0",
        blockIdFlag: sig.blockIdFlag,
      })),
    });
    this.logger.verbose("Update Tendermint client");
    const memFile = MemFile.fromPartial({
      name: "run.gno",
      body: rundotgno,
    });
    const memPackage = MemPackage.fromPartial({
      files: [memFile],
      name: "main",
      path: "",
    });

    const result = await this.sign.executePackage(memPackage, TransactionEndpoint.BROADCAST_TX_COMMIT, new Map(), (new Map()).set("ugnot", 3000000),
      {
        gas_wanted: new Long(100000000),
        gas_fee: "100000ugnot",
      });

    if (result.deliver_tx.ResponseBase.Error) {
      throw new Error(`Failed to update Tendermint client: ${result.deliver_tx.ResponseBase.Error}`);
    }
    return {
      events: [],
      transactionHash: Buffer.from(fromBase64(result.hash)).toString("hex").toUpperCase(),
      height: Number(result.height),
    };
  }

  public async updateGnoClient(
    _clientId: string,
    _header: ibc.lightclients.gno.v1.gno.Header,
  ): Promise<MsgResult> {
    throw new Error("Gno LC on Gno not implemented.");
  }

  public async connOpenInit(
    _clientId: string,
    _remoteClientId: string,
  ): Promise<CreateConnectionResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async connOpenTry(
    _myClientId: string,
    _proof: ConnectionHandshakeProof,
  ): Promise<CreateConnectionResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async connOpenAck(
    _myConnectionId: string,
    _proof: ConnectionHandshakeProof,
  ): Promise<MsgResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async connOpenConfirm(
    _myConnectionId: string,
    _proof: ConnectionHandshakeProof,
  ): Promise<MsgResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async channelOpenInit(
    _portId: string,
    _remotePortId: string,
    _ordering: Order,
    _connectionId: string,
    _version: string,
  ): Promise<CreateChannelResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async channelOpenTry(
    _portId: string,
    _remote: ChannelInfo,
    _ordering: Order,
    _connectionId: string,
    _version: string,
    _counterpartyVersion: string,
    _proof: ChannelHandshakeProof,
  ): Promise<CreateChannelResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async channelOpenAck(
    _portId: string,
    _channelId: string,
    _counterpartyChannelId: string,
    _counterpartyVersion: string,
    _proof: ChannelHandshakeProof,
  ): Promise<MsgResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async channelOpenConfirm(
    _portId: string,
    _channelId: string,
    _proof: ChannelHandshakeProof,
  ): Promise<MsgResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async getChannelV1Type(_portId: string, _channelId: string): Promise<Order> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public receivePacket(
    _packet: Packet,
    _proofCommitment: Uint8Array,
    _proofHeight?: Height,
  ): Promise<MsgResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async receivePackets(
    _packets: readonly Packet[],
    _proofCommitments: readonly Uint8Array[],
    _proofHeight?: Height,
  ): Promise<MsgResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public receivePacketV2(
    packet: PacketV2,
    proofCommitment: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.receivePacketsV2([packet], [proofCommitment], proofHeight);
  }

  public async receivePacketsV2(
    packets: readonly PacketV2[],
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
    const messages = [];
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      this.logger.verbose(
        `Sending packet #${packet.sequence} from ${this.chainId}:${packet.sourceClient}`,
        (packet.payloads),
      );
      const ics23 = MerkleProof.decode(proofCommitments[i]);
      const rundotgno = recvPacket({
        sequence: packet.sequence.toString(),
        sourceClient: packet.sourceClient,
        destinationClient: packet.destinationClient,
        timestamp: packet.timeoutTimestamp.toString(),
        payloads: packet.payloads.map(p => ({
          sourcePort: p.sourcePort,
          destinationPort: p.destinationPort,
          encoding: p.encoding,
          version: p.version,
          value: toHex(p.value),
        })),
        commitmentProof: ProofHelper(ics23),
        proofRevision: proofHeight?.revisionNumber.toString() ?? "0",
        proofHeight: proofHeight?.revisionHeight.toString() ?? "0",
      });
      const memFile = MemFile.fromPartial({
        name: "run.gno",
        body: rundotgno,
      });

      const memPackage = MemPackage.fromPartial({
        files: [memFile],
        name: "main",
        path: "",
      });
      const amount: string = fundsToCoins(new Map());
      const maxDepositAmount: string = fundsToCoins((new Map()).set("ugnot", 3000000));

      // Fetch the wallet address
      const caller: string = await this.sign.getAddress();
      const runMsg: MsgRun = {
        caller,
        send: amount,
        package: memPackage,
        max_deposit: maxDepositAmount,
      };
      messages.push(
        {
          type_url: MsgEndpoint.MSG_RUN,
          value: MsgRun.encode(runMsg).finish(),
        },
      );
    }
    const txFee: TxFee = {
      gas_wanted: new Long(80000000 * packets.length),
      gas_fee: 80000000 * packets.length * 0.001 + "ugnot",
    };

    const tx: Tx = {
      messages: messages,
      fee: txFee,
      memo: "",
      signatures: [], // No signature yet
    };

    const signedTx: Tx = await this.sign.signTransaction(tx, decodeTxMessages);
    const result = await this.sign.sendTransaction(signedTx, TransactionEndpoint.BROADCAST_TX_COMMIT);
    if (result.deliver_tx.ResponseBase.Error) {
      throw new Error(`Failed to receive packets: ${result.deliver_tx.ResponseBase.Error}`);
    }
    return {
      events: [],
      transactionHash: Buffer.from(fromBase64(result.hash)).toString("hex").toUpperCase(),
      height: Number(result.height),
    };
  }

  public acknowledgePacket(
    _ack: Ack,
    _proofAcked: Uint8Array,
    _proofHeight?: Height,
  ): Promise<MsgResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async acknowledgePackets(
    _acks: readonly Ack[],
    _proofAckeds: readonly Uint8Array[],
    _proofHeight?: Height,
  ): Promise<MsgResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public acknowledgePacketV2(
    ack: AckV2,
    proofAcked: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.acknowledgePacketsV2([ack], [proofAcked], proofHeight);
  }

  public async acknowledgePacketsV2(
    acks: readonly AckV2[],
    proofAckeds: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    const messages = [];
    for (let i = 0; i < acks.length; i++) {
      const ics23 = MerkleProof.decode(proofAckeds[i]);
      const rundotgno = acknowledgement({
        sequence: acks[i].originalPacket.sequence.toString(),
        sourceClient: acks[i].originalPacket.sourceClient,
        destinationClient: acks[i].originalPacket.destinationClient,
        timestamp: acks[i].originalPacket.timeoutTimestamp.toString(),
        payloads: acks[i].originalPacket.payloads.map(p => ({
          sourcePort: p.sourcePort,
          destinationPort: p.destinationPort,
          encoding: p.encoding,
          version: p.version,
          value: toHex(p.value),
        })),
        appAcknowledgement: toHex(acks[i].acknowledgement).substring(4),
        commitmentProof: ProofHelper(ics23),
        proofRevision: proofHeight?.revisionNumber.toString() ?? "0",
        proofHeight: proofHeight?.revisionHeight.toString() ?? "0",
      });
      this.logger.verbose("Send Ackcnowledgement:" + acks[i].originalPacket.sequence.toString());
      const memFile = MemFile.fromPartial({
        name: "run.gno",
        body: rundotgno,
      });
      const memPackage = MemPackage.fromPartial({
        files: [memFile],
        name: "main",
        path: "",
      });
      const amount: string = fundsToCoins(new Map());
      const maxDepositAmount: string = fundsToCoins((new Map()).set("ugnot", 3000000));

      // Fetch the wallet address
      const caller: string = await this.sign.getAddress();
      const runMsg: MsgRun = {
        caller,
        send: amount,
        package: memPackage,
        max_deposit: maxDepositAmount,
      };
      messages.push(
        {
          type_url: MsgEndpoint.MSG_RUN,
          value: MsgRun.encode(runMsg).finish(),
        },
      );
    }
    const txFee: TxFee = {
      gas_wanted: new Long(70000000 * acks.length),
      gas_fee: 70000000 * acks.length * 0.001 + "ugnot",
    };

    const tx: Tx = {
      messages: messages,
      fee: txFee,
      memo: "",
      signatures: [], // No signature yet
    };

    const signedTx: Tx = await this.sign.signTransaction(tx, decodeTxMessages);
    const result = await this.sign.sendTransaction(signedTx, TransactionEndpoint.BROADCAST_TX_COMMIT);

    if (result.deliver_tx.ResponseBase.Error) {
      throw new Error(`Failed to acknowledge packets: ${result.deliver_tx.ResponseBase.Error}`);
    }

    return {
      events: [],
      transactionHash: Buffer.from(fromBase64(result.hash)).toString("hex").toUpperCase(),
      height: Number(result.height),
    };
  }

  public timeoutPacket(
    _packet: Packet,
    _proofUnreceived: Uint8Array,
    _nextSequenceRecv: bigint,
    _proofHeight: Height,
  ): Promise<MsgResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async timeoutPackets(
    _packets: Packet[],
    _proofsUnreceived: Uint8Array[],
    _nextSequenceRecv: bigint[],
    _proofHeight: Height,
  ): Promise<MsgResult> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public timeoutPacketV2(
    packet: PacketV2,
    proofUnreceived: Uint8Array,
    proofHeight: Height,
  ): Promise<MsgResult> {
    return this.timeoutPacketsV2(
      [packet], [proofUnreceived], proofHeight,
    );
  }

  public async timeoutPacketsV2(
    packets: PacketV2[],
    proofsUnreceived: Uint8Array[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    const messages = [];
    for (let i = 0; i < packets.length; i++) {
      const ics23 = MerkleProof.decode(proofsUnreceived[i]);
      const rundotgno = timeout({
        sequence: packets[i].sequence.toString(),
        sourceClient: packets[i].sourceClient,
        destinationClient: packets[i].destinationClient,
        timestamp: packets[i].timeoutTimestamp.toString(),
        payloads: packets[i].payloads.map(p => ({
          sourcePort: p.sourcePort,
          destinationPort: p.destinationPort,
          encoding: p.encoding,
          version: p.version,
          value: toHex(p.value),
        })),
        commitmentProof: ProofHelper(ics23),
        proofRevision: proofHeight?.revisionNumber.toString() ?? "0",
        proofHeight: proofHeight?.revisionHeight.toString() ?? "0",
      });
      this.logger.verbose("Send Timeout " + packets[i].sequence.toString());
      const memFile = MemFile.fromPartial({
        name: "run.gno",
        body: rundotgno,
      });
      const memPackage = MemPackage.fromPartial({
        files: [memFile],
        name: "main",
        path: "",
      });
      const amount: string = fundsToCoins(new Map());
      const maxDepositAmount: string = fundsToCoins((new Map()).set("ugnot", 3000000));

      // Fetch the wallet address
      const caller: string = await this.sign.getAddress();
      const runMsg: MsgRun = {
        caller,
        send: amount,
        package: memPackage,
        max_deposit: maxDepositAmount,
      };
      messages.push(
        {
          type_url: MsgEndpoint.MSG_RUN,
          value: MsgRun.encode(runMsg).finish(),
        },
      );
    }
    const txFee: TxFee = {
      gas_wanted: new Long(60000000 * packets.length),
      gas_fee: 60000000 * packets.length * 0.001 + "ugnot",
    };

    const tx: Tx = {
      messages: messages,
      fee: txFee,
      memo: "",
      signatures: [], // No signature yet
    };

    const signedTx: Tx = await this.sign.signTransaction(tx, decodeTxMessages);
    const result = await this.sign.sendTransaction(signedTx, TransactionEndpoint.BROADCAST_TX_COMMIT);

    if (result.deliver_tx.ResponseBase.Error) {
      throw new Error(`Failed to create Tendermint client: ${result.deliver_tx.ResponseBase.Error}`);
    }

    return {
      events: [],
      transactionHash: Buffer.from(fromBase64(result.hash)).toString("hex").toUpperCase(),
      height: Number(result.height),
    };
  }

  public async queryRawProof(store: string, queryKey: Uint8Array, proofHeight: number): Promise<ProvenQuery> {
    const {
      key, value, height, proof, responseBase,
    } = await this.tm.abciQuery({
      path: `.store/${store}/key`,
      data: queryKey,
      height: proofHeight,
      prove: true,
    });

    if (responseBase.error) {
      throw new Error(`Query failed with (${responseBase.error["@type"]}): ${responseBase.error.value}`);
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

    const rundotgno = registerCounterParty({
      clientId: clientId.trim(),
      counterpartyClientId: counterpartyClientId.trim(),
      iavlStoreKey: toHex(merklePrefix),
      storeKey: "",
    });
    const memFile = MemFile.fromPartial({
      name: "run.gno",
      body: rundotgno,
    });
    const memPackage = MemPackage.fromPartial({
      files: [memFile],
      name: "main",
      path: "",
    });

    const result = await this.sign.executePackage(memPackage, TransactionEndpoint.BROADCAST_TX_COMMIT, new Map(), (new Map()).set("ugnot", 3000000),
      {
        gas_wanted: new Long(50000000),
        gas_fee: "75000ugnot",
      });

    if (result.deliver_tx.ResponseBase.Error) {
      throw new Error(`Failed to register counterparty: ${result.deliver_tx.ResponseBase.Error}`);
    }
    return {
      events: [],
      transactionHash: Buffer.from(fromBase64(result.hash)).toString("hex").toUpperCase(),
      height: Number(result.height),
    };
  }

  /*
  public async getTendermintConsensusState(clientId: string, consensusHeight: Height, proofHeight: Height): Promise<{
    consensusState: ConsensusState
    proof: Uint8Array
  }> {
    const state = await this.getRawConsensusStateProof(clientId, consensusHeight, proofHeight);
    if (!state.data) {
      throw new Error(`No consensus state found for client ${clientId} at height ${consensusHeight}`);
    }
    return {
      consensusState: ConsensusState.decode(state.data.value),
      proof: state.proof,
    };
  }

  public async getTendermintClientState(clientId: string, proofHeight: Height): Promise<{
    clientState: ClientState
    proof: Uint8Array
  }> {
    const state = await this.getRawClientStateProof(clientId, proofHeight);
    if (!state.data) {
      throw new Error(`No proven client state found for client ${clientId} at height ${proofHeight}`);
    }
    return {
      clientState: ClientState.decode(state.data.value),
      proof: state.proof,
    };
  }
  */

  public async getRawChannelProof(_portId: string, _channelId: string, _proofHeight: Height): Promise<DataProof> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async getRawReceiptProof(_portId: string, _channelId: string, _sequence: bigint, _proofHeight: Height): Promise<DataProof> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async getRawReceiptProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigUint64BE(sequence);
    const seq = Uint8Array.from(buf);
    const sep = fromHex("02");
    const key = mergeUint8Arrays(toAscii(
      `/pv/vm:gno.land/r/aib/ibc/core:${clientId}`), sep, seq,
    );
    const proven = await this.queryRawProof(
      "main", key, Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
    return {
      data: proven.value,
      proof,
      proofHeight,
    };
  }

  public async getRawPacketCommitmentProof(_portId: string, _channelId: string, _sequence: bigint, _proofHeight: Height): Promise<DataProof> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async getRawPacketCommitmentProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigUint64BE(sequence);
    const seq = Uint8Array.from(buf);
    const sep = fromHex("01");
    const key = mergeUint8Arrays(toAscii(
      `/pv/vm:gno.land/r/aib/ibc/core:${clientId}`), sep, seq,
    );
    const proven = await this.queryRawProof(
      "main", key, Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
    this.logger.debug(proven);
    return {
      data: proven.value,
      proof,
      proofHeight,
    };
  }

  public async getRawPacketAcknowledgementProof(_portId: string, _channelId: string, _sequence: bigint, _proofHeight: Height): Promise<DataProof> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async getRawPacketAcknowledgementProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigUint64BE(sequence);
    const seq = Uint8Array.from(buf);
    const sep = fromHex("03");
    const key = mergeUint8Arrays(toAscii(
      `/pv/vm:gno.land/r/aib/ibc/core:${clientId}`), sep, seq,
    );
    const proven = await this.queryRawProof(
      "main", key, Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);

    return {
      data: proven.value,
      proof,
      proofHeight,
    };
  }

  public async getRawClientStateProof(clientId: string, proofHeight: Height): Promise<FullProof> {
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = `clients/${clientId}/clientState`;
    const proven = await this.queryRawProof(
      "ibc", toAscii(key), Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);

    return {
      data: Any.decode(proven.value),
      proof,
      proofHeight,
    };
  }

  public async getRawConsensusStateProof(clientId: string, consensusHeight: Height, proofHeight: Height): Promise<FullProof> {
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const height = heightQueryString(consensusHeight);
    const key = `clients/${clientId}/consensusStates/${height}`;
    const proven = await this.queryRawProof(
      "ibc", toAscii(key), Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);

    return {
      data: Any.decode(proven.value),
      proof,
      proofHeight,
    };
  }

  public async getRawConnectionProof(connectionId: string, proofHeight: Height): Promise<FullProof> {
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = `connections/${connectionId}`;
    const proven = await this.queryRawProof(
      "ibc", toAscii(key), Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);

    return {
      data: Any.decode(proven.value),
      proof,
      proofHeight,
    };
  }

  public async getNextSequenceRecv(_portId: string, _channelId: string): Promise<bigint> {
    throw new Error("Ibc v1 is not supported on Gno clients yet.");
  }

  public async getConnection(_connectionId: string): Promise<Partial<QueryConnectionResponse>> {
    throw new Error("Ibc v1 is not supported on Gno clients yet.");
  }

  public async getCounterparty(clientId: string): Promise<string> {
    const clientState = await this.tm.abciQuery({
      path: "vm/qrender",
      data: Buffer.from(`gno.land/r/aib/ibc/core:clients/${clientId}`, "utf-8"),
    });
    this.logger.debug("Client State ABCI Query Result:", clientState);
    if (clientState.responseBase.error) {
      throw new Error(`Client state not found for client ID ${clientId}: ${clientState.responseBase.error}`);
    }
    try {
      const data = JSON.parse(Buffer.from(clientState.responseBase.data).toString("utf-8"));
      const counterparty = data.counterparty_client_id;
      return counterparty;
    }
    catch (e) {
      throw new Error(`Failed to parse client state for client ID ${clientId}: ${getErrorMessage(e)}`);
    }
  }

  public async searchTendermintBlocks(_query: string): Promise<BlockSearchResponse> {
    /*
    const search = await this.tm.blockSearchAll({
      query,
    });
    return search;
    */
    throw new Error("Block search is not supported on Gno clients yet.");
  }

  public async getTendermintBlockResults(_height: number): Promise<BlockResultsResponse> {
    /*
    const result = await this.tm.blockResults(height);
    return result;
    */
    throw new Error("Block results are not supported on Gno clients yet.");
  }

  public async searchTendermintTxs(_query: string): Promise<TxSearchResponse> {
    /*
    const search = await this.tm.txSearchAll({
      query,
    });
    return search;
    */
    throw new Error("Tx search is not supported on Gno clients yet.");
  }

  public async querySentPackets(connectionId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketWithMetadata[]> {
    const txsPackets = await this.getPacketsFromTxs(connectionId, minHeight, maxHeight);
    const eventsPackets = await this.getPacketsFromBlockEvents(connectionId, minHeight, maxHeight);
    return ([] as PacketWithMetadata[])
      .concat(...txsPackets)
      .concat(...eventsPackets);
  }

  public async querySentPacketsV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<PacketV2WithMetadata[]> {
    if (minHeight && minHeight > 0) {
      minHeight = minHeight - 2;
    }
    else {
      minHeight = 0;
    }
    if (maxHeight) {
      maxHeight = maxHeight + 1;
    }
    const query = maxHeight
      ? `query getEvents {
  getTransactions(where: {block_height: {gt: ${minHeight}, lt: ${maxHeight}}, success: {eq: true}, response: {
    events: {
      GnoEvent: {
         type: {eq: "send_packet"}
      }
    }
  }}) {
    block_height
    hash
    response {
      events {
        ... on GnoEvent {
          type
          attrs {
            key
            value
          }
        }
      }
    }
  }
}`
      : `query getEvents {
  getTransactions(where: {block_height: {gt: ${minHeight}}, success: {eq: true}, response: {
    events: {
      GnoEvent: {
         type: {eq: "send_packet"}
      }
    }
  }}) {
    block_height
    hash
    response {
      events {
        ... on GnoEvent {
          type
          attrs {
            key
            value
          }
        }
      }
    }
  }
}`;
    const data = await this.graphClient.request<GnoGraphQLResponse>(query);
    const packets: PacketV2WithMetadata[] = [];
    if (!data || !data.getTransactions) {
      return packets;
    }
    for (const tx of data.getTransactions) {
      const height = Number(tx.block_height);
      const sendPacketEvents = tx.response.events.filter((e: GnoEvent) => e.type === "send_packet");
      for (const e of sendPacketEvents) {
        const encodedPacketAttr = e.attrs.find((attr: GnoEventAttr) => attr.key === "encoded_packet_hex");
        const sourceClientAttr = e.attrs.find((attr: GnoEventAttr) => attr.key === "packet_source_client");
        if (!encodedPacketAttr || !sourceClientAttr) {
          continue;
        }
        const packet: PacketV2WithMetadata = {
          height,
          packet: PacketV2.decode(fromHex(encodedPacketAttr.value)),
        };
        if (sourceClientAttr.value === clientId) {
          packets.push(packet);
        }
      }
    }
    return packets;
  }

  public async queryWrittenAcks(_connectionId: string, _minHeight: number | undefined, _maxHeight: number | undefined): Promise<AckWithMetadata[]> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async queryWrittenAcksV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined): Promise<AckV2WithMetadata[]> {
    if (minHeight && minHeight > 0) {
      minHeight = minHeight - 2;
    }
    else {
      minHeight = 0;
    }
    if (maxHeight) {
      maxHeight = maxHeight + 1;
    }
    const query = maxHeight
      ? `query getEvents {
  getTransactions(where: {block_height: {gt: ${minHeight}, lt: ${maxHeight}}, success: {eq: true}, response: {
    events: {
      GnoEvent: {
         type: {eq: "write_acknowledgement"}
      }
    }
  }}) {
    block_height
    hash
    response {
      events {
        ... on GnoEvent {
          type
          attrs {
            key
            value
          }
        }
      }
    }
  }
}`
      : `query getEvents {
  getTransactions(where: {block_height: {gt: ${minHeight}}, success: {eq: true}, response: {
    events: {
      GnoEvent: {
         type: {eq: "write_acknowledgement"}
      }
    }
  }}) {
    block_height
    hash
    response {
      events {
        ... on GnoEvent {
          type
          attrs {
            key
            value
          }
        }
      }
    }
  }
}`;
    const data = await this.graphClient.request<GnoGraphQLResponse>(query);
    const packets: AckV2WithMetadata[] = [];
    if (!data || !data.getTransactions) {
      return packets;
    }
    for (const tx of data.getTransactions) {
      const height = Number(tx.block_height);
      const writeAcknowledgementEvents = tx.response.events.filter((e: GnoEvent) => e.type === "write_acknowledgement");
      for (const e of writeAcknowledgementEvents) {
        const ackAttr = e.attrs.find((attr: GnoEventAttr) => attr.key === "encoded_acknowledgement_hex");
        const packetAttr = e.attrs.find((attr: GnoEventAttr) => attr.key === "encoded_packet_hex");
        const destClientAttr = e.attrs.find((attr: GnoEventAttr) => attr.key === "packet_dest_client");
        if (!ackAttr || !packetAttr || !destClientAttr) {
          continue;
        }
        const packet: AckV2WithMetadata = {
          height,
          txHash: toHex(fromBase64(tx.hash)).toUpperCase(),
          txEvents: [],
          acknowledgement: fromHex(ackAttr.value),
          originalPacket: PacketV2.decode(fromHex(packetAttr.value)),
        };
        if (destClientAttr.value === clientId) {
          packets.push(packet);
        }
      }
    }
    return packets;
  }

  public async queryUnreceivedPackets(_portId: string, _channelId: string, _sequences: readonly number[]): Promise<number[]> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async pagedAbciQuery(path: string, query: string): Promise<unknown[]> {
    const result = await this.tm.abciQuery({
      path,
      data: Buffer.from(query, "utf-8"),
    });
    if (result.responseBase.error) {
      throw new Error("Query: " + query + " failed. Error: " + result.responseBase.error);
    }
    let items = [];
    try {
      const data = JSON.parse(Buffer.from(result.responseBase.data).toString("utf-8"));
      if (Array.isArray(data)) {
        return data;
      }
      else {
        if (data.items && Array.isArray(data.items) && data.total === 1) {
          return data.items;
        }
        else {
          if (data.total > 1) {
            items = [...data.items];
            for (let i = 2; i <= data.total; i++) {
              const result = await this.tm.abciQuery({
                path,
                data: Buffer.from(query + "&page=" + i, "utf-8"),
              });
              if (result.responseBase.error) {
                throw new Error("Query: " + query + "&page=" + i + " failed. Error: " + result.responseBase.error);
              }
              const pageData = JSON.parse(Buffer.from(result.responseBase.data).toString("utf-8"));
              if (pageData.items && Array.isArray(pageData.items)) {
                items = [...items, ...pageData.items];
              }
              else {
                throw new Error("Invalid data format for page " + i + ": " + result.responseBase.data);
              }
            }
          }
        }
      }
    }
    catch (e) {
      throw new Error(`Failed to parse query result for query ${query}: ${getErrorMessage(e)}`);
    }
  }

  public async queryUnreceivedPacketsV2(clientId: string, sequences: readonly number[]): Promise<number[]> {
    try {
      const data = await this.pagedAbciQuery(
        "vm/qrender",
        `gno.land/r/aib/ibc/core:clients/${clientId}/packet_receipts`,
      );

      const unreceived: number[] = [];
      for (const seq of sequences) {
        const packet = data.find((item: {
          sequence: string
        }) => BigInt(item.sequence) === BigInt(seq));
        if (!packet) {
          unreceived.push(seq);
        }
      }
      return unreceived;
    }
    catch (e) {
      throw new Error(`Failed to parse unreceived packets for client ID ${clientId} and sequences ${sequences}: ${getErrorMessage(e)}`);
    }
  }

  public async queryCommitments(_portId: string, _channelId: string, _sequence: bigint): Promise<Uint8Array> {
    /*
    const res = await this.query.ibc.channel.packetCommitment(
      portId, channelId, Number(sequence),
    );
    return res.commitment;
    */
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async queryCommitmentsV2(clientId: string, sequence: bigint): Promise<Uint8Array> {
    try {
      const data = await this.pagedAbciQuery("vm/qrender", `gno.land/r/aib/ibc/core:clients/${clientId}/packet_commitments`);

      const commitment = data.find((item: {
        sequence: string
      }) => BigInt(item.sequence) === sequence);
      if (commitment) {
        return fromBase64((commitment as {
          data: string
        }).data);
      }
      else {
        throw new Error(`Commitment for client ID ${clientId} and sequence ${sequence} not found in data.`);
      }
    }
    catch (e) {
      throw new Error(`Failed to parse commitment for client ID ${clientId} and sequence ${sequence}: ${getErrorMessage(e)}`);
    }
  }

  public async queryUnreceivedAcks(_portId: string, _channelId: string, _sequences: readonly number[]): Promise<number[]> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async queryUnreceivedAcksV2(clientId: string, sequences: readonly number[]): Promise<number[]> {
    try {
      const data = await this.pagedAbciQuery(
        "vm/qrender", `gno.land/r/aib/ibc/core:clients/${clientId}/packet_commitments`,
      );

      const unreceived: number[] = [];
      for (const seq of sequences) {
        const ack = data.find((item: {
          sequence: string
        }) => BigInt(item.sequence) === BigInt(seq));
        if (ack) {
          unreceived.push(seq);
        }
      }
      return unreceived;
    }
    catch (e) {
      throw new Error(`Failed to parse unreceived ACKs for client ID ${clientId} and sequences ${sequences}: ${getErrorMessage(e)}`);
    }
  }

  public async buildCreateClientArgs(trustPeriodSec?: number | null): Promise<{
    clientState: ibc.lightclients.gno.v1.gno.ClientState
    consensusState: ibc.lightclients.gno.v1.gno.ConsensusState
  }> {
    const header = await this.latestHeader();
    const consensusState = buildGnoConsensusState(header);
    const unbondingPeriodSec = await this.getUnbondingPeriod();
    if (trustPeriodSec === undefined || trustPeriodSec === null) {
      trustPeriodSec = Math.floor((unbondingPeriodSec * 2) / 3);
    }
    const clientState = buildGnoClientState(
      this.chainId, unbondingPeriodSec, trustPeriodSec, this.revisionHeight(Number(header.height)),
    );
    return {
      consensusState,
      clientState,
    };
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
      search.blocks.map(async ({
        block,
      }) => {
        const height = block.header.height;
        const result = await this.getTendermintBlockResults(height);
        return parsePacketsFromBlockResult(result).map(packet => ({
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
      ({
        height, result,
      }): PacketWithMetadata[] =>
        parsePacketsFromTendermintEvents(result.events).map(packet => ({
          packet,
          height,
        })),
    );
    return resultsNested.flat();
  }

  async getPacketsFromBlockEventsV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined) {
    let query = `send_packet.packet_source_client='${clientId}'`;
    if (minHeight) {
      query = `${query} AND block.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND block.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintBlocks(query);
    const resultsNested = await Promise.all(
      search.blocks.map(async ({
        block,
      }) => {
        const height = block.header.height;
        const result = await this.getTendermintBlockResults(height);
        return parsePacketsFromBlockResultV2(result).map(packet => ({
          packet,
          height,
          sender: "",
        }));
      }),
    );

    return ([] as PacketV2WithMetadata[]).concat(...resultsNested);
  }

  async getPacketsFromTxsV2(clientId: string, minHeight: number | undefined, maxHeight: number | undefined) {
    let query = `send_packet.packet_source_client='${clientId}'`;
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintTxs(query);
    const resultsNested = search.txs.map(
      ({
        height, result,
      }): PacketV2WithMetadata[] =>
        parsePacketsFromTendermintEventsV2(result.events).map(packet => ({
          packet,
          height,
        })),
    );
    return resultsNested.flat();
  }
}
