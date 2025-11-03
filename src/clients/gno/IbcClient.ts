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
  GnoJSONRPCProvider,
  GnoWallet,
  MemFile,
  MemPackage,
} from "@gnolang/gno-js-client";
import {
  ibc,
} from "@gnolang/gno-types";
import {
  CreateWalletOptions,
  TransactionEndpoint,
} from "@gnolang/tm2-js-client";
import {
  CommitResponse,
} from "@gnolang/tm2-rpc";
import {
  connectTm2, ReadonlyDateWithNanoseconds, Tm2Client,
} from "@gnolang/tm2-rpc";
import Long from "long";

import {
  Ack, AckV2, AckV2WithMetadata, AckWithMetadata, AnyClientState, AnyConsensusState, BlockResultsResponse, BlockSearchResponse, ChannelHandshakeProof, ChannelInfo, ClientType, ConnectionHandshakeProof, CreateChannelResult, CreateClientResult, CreateConnectionResult, DataProof, FullProof, MsgResult, PacketV2WithMetadata, PacketWithMetadata, ProvenQuery, TxSearchResponse,
} from "../../types/index.js";
import {
  buildGnoClientState, buildGnoConsensusState, buildTendermintClientState, checkAndParseOp, convertProofsToIcs23, heightQueryString, mergeUint8Arrays, parsePacketsFromBlockResult, parsePacketsFromBlockResultV2, parsePacketsFromTendermintEvents, parsePacketsFromTendermintEventsV2, parseRevisionNumber, subtractBlock, timestampFromDateNanos, toIntHeight,
} from "../../utils/utils.js";
import {
  BaseIbcClient, BaseIbcClientOptions, isGno, isTendermint,
} from "../BaseIbcClient.js";
import {
  createClientTemplate, registerCounterParty, updateClientTemplate,
} from "./queries.js";

export type GnoIbcClientOptions = CreateWalletOptions & BaseIbcClientOptions & {
  gasPrice: GasPrice
};

export interface GnoIbcClientTypes {
  header: ibc.lightclients.gno.v1.gno.GnoHeader
  consensusState: ibc.lightclients.gno.v1.gno.ConsensusState
  clientState: ibc.lightclients.gno.v1.gno.ClientState
  lightClientHeader: ibc.lightclients.gno.v1.gno.Header
}
export class GnoIbcClient extends BaseIbcClient<GnoIbcClientTypes> {
  public readonly gasPrice: GasPrice;
  public readonly sign: GnoWallet;
  public readonly tm: Tm2Client;
  public readonly addressPrefix: string;

  public static async connectWithSigner(
    endpoint: string,
    signer: GnoWallet,
    options: Partial<GnoIbcClientOptions>,
  ): Promise<GnoIbcClient> {
    options.senderAddress = await signer.getAddress();
    // override any registry setup, use the other options

    const provider = new GnoJSONRPCProvider(endpoint);
    const tmClient = await connectTm2(endpoint);
    const chainId = (await tmClient.status()).nodeInfo.network;
    options.chainId = chainId;
    options.clientType = ClientType.Gno;
    options.revisionNumber = parseRevisionNumber(chainId);
    signer.connect(provider);
    return new GnoIbcClient(
      signer, tmClient, options as GnoIbcClientOptions,
    );
  }

  private constructor(
    signingClient: GnoWallet,
    tmClient: Tm2Client,
    options: GnoIbcClientOptions,
  ) {
    super(options);
    this.sign = signingClient;
    this.tm = tmClient;
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
    // TODO: expose header method on tmClient and use thate
    const resp = await this.tm.blockchain(height, height);
    return {
      ...resp.blockMetas[0].header,
      height: BigInt(resp.blockMetas[0].header.height),
      time: timestampFromDateNanos(resp.blockMetas[0].header.time),
      proposerAddress: toBech32(this.addressPrefix, resp.blockMetas[0].header.proposerAddress),
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
      proposerAddress: toBech32(this.addressPrefix, block.block.header.proposerAddress),
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

  public getGnoCommit(height?: number): Promise<CommitResponse> {
    this.logger.verbose(
      height === undefined
        ? "Get latest commit"
        : `Get commit for height ${height}`,
    );
    return this.tm.commit(height);
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
      proposerAddress: toHex(rpcHeader.proposerAddress),
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
      validatorAddress: toBech32(this.addressPrefix, sig.validatorAddress),
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
      pubKey: val.pubkey.algorithm == "ed25519"
        ? {
          typeUrl: "/tendermint.crypto.PubKeyEd25519",
          value: val.pubkey.data,
        }
        : {
          typeUrl: "/tendermint.crypto.PubKeySecp256k1",
          value: val.pubkey.data,
        },
      votingPower: val.votingPower,
      proposerPriority: val.proposerPriority
        ? BigInt(val.proposerPriority)
        : undefined,
    }));
    const proposer = mappedValidators.find(val =>
      val.address == proposerAddress,
    );
    return ibc.lightclients.gno.v1.gno.ValidatorSet.fromPartial({
      validators: mappedValidators,
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
    const consensusState = await this.tm.abciQuery({
      path: "vm/qrender",
      data: Buffer.from(`gno.land/r/aib/ibc/core:clients/${clientId}/consensus_states/${consensusHeight.revisionNumber}/${consensusHeight.revisionHeight}`, "utf-8"),
    });
    if (consensusState.responseBase.error) {
      throw new Error(`Consensus state not found for client ID ${clientId} at height ${consensusHeight}:` + consensusState.responseBase.error);
    }
    try {
      const data = JSON.parse(Buffer.from(consensusState.responseBase.data).toString("utf-8"));
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
      throw new Error(`Failed to parse consensus state for client ID ${clientId} at height ${consensusHeight}: ${e.message}`);
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
      throw new Error("Failed to parse client state" + e);
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
      nextValidatorsHash: toHex(consensusState.nextValidatorsHash ?? new Uint8Array()),
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

    const result = await this.sign.executePackage(memPackage, TransactionEndpoint.BROADCAST_TX_COMMIT, new Map(), (new Map()).set("ugnot", 2000000),
      {
        gas_wanted: new Long(30000000),
        gas_fee: "75000ugnot",
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
      chainID: header.signedHeader.header.chainId,
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
      trustedRevisionNumber: header.trustedHeight.revisionNumber.toString(),
      trustedRevisionHeight: header.trustedHeight.revisionHeight.toString(),
      trustedValidators: header.trustedValidators.validators.map(val => ({
        address: toHex(val.address),
        pubKey: toHex(val.pubKey.ed25519 ?? val.pubKey.secp256k1 ?? new Uint8Array()),
        votingPower: val.votingPower.toString(),
      })),
      trustedProposerAddress: toHex(header.trustedValidators.proposer?.address ?? new Uint8Array()),
      trustedProposerPubKey: toHex(header.trustedValidators.proposer?.pubKey.ed25519 ?? header.trustedValidators.proposer?.pubKey.secp256k1 ?? new Uint8Array()),
      trustedProposerVotingPower: header.trustedValidators.proposer?.votingPower.toString() ?? "0",
      commitHeight: header.signedHeader.commit.height.toString(),
      commitRound: header.signedHeader.commit.round.toString(),
      commitBlockIdHash: toHex(header.signedHeader.commit.blockId?.hash ?? new Uint8Array()),
      commitPartSetTotal: header.signedHeader.commit.blockId?.partSetHeader?.total.toString() ?? "0",
      commitPartSetHash: toHex(header.signedHeader.commit.blockId?.partSetHeader?.hash ?? new Uint8Array()),
      commitSignatures: header.signedHeader.commit.signatures.map(sig => ({
        validatorAddress: toHex(sig.validatorAddress),
        signature: toHex(sig.signature),
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

    const result = await this.sign.executePackage(memPackage, TransactionEndpoint.BROADCAST_TX_COMMIT, new Map(), (new Map()).set("ugnot", 2000000),
      {
        gas_wanted: new Long(30000000),
        gas_fee: "75000ugnot",
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
    _packets: readonly PacketV2[],
    _proofCommitments: readonly Uint8Array[],
    _proofHeight?: Height,
  ): Promise<MsgResult> {
    /*
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
        `Sending packet #${packet.sequence} from ${this.chainId}:${packet.sourceClient}`,
        (packet.payloads),
      );

      const msg = {
        typeUrl: "/ibc.core.channel.v2.MsgRecvPacket",
        value: MsgRecvPacketV2.fromPartial({
          packet,
          proofCommitment: proofCommitments[i],
          proofHeight,
          signer: senderAddress,
        }),
      };
      msgs.push(msg);
    }
    this.logger.debug("MsgRecvPacket(s)", {
      msgs: msgs.map(msg =>
        deepCloneAndMutate(msg, (mutableMsg) => {
          mutableMsg.value.proofCommitment = toBase64AsAny(
            mutableMsg.value.proofCommitment,
          );
        }),
      ),
    });
    const result = await this.sign.signAndBroadcast(
      senderAddress, msgs, "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
    */
    throw new Error("IBC v1 is not supported on Gno clients yet.");
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
    _acks: readonly AckV2[],
    _proofAckeds: readonly Uint8Array[],
    _proofHeight?: Height,
  ): Promise<MsgResult> {
    /*
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
      const acknowledgement = Acknowledgement.decode(acks[i].acknowledgement);
      // TODO: construct Ack Message correctly
      this.logger.verbose(
        `Ack packet #${packet.sequence} from ${this.chainId}:${packet.sourceClient}`, {
          packet: packet.payloads,
          ack: acknowledgement,
        },
      );
      const msg = {
        typeUrl: "/ibc.core.channel.v2.MsgAcknowledgement",
        value: MsgAcknowledgementV2.fromPartial({
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
      msgs: msgs,
    });
    const result = await this.sign.signAndBroadcast(
      senderAddress, msgs, "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
    */
    throw new Error("IBC v1 is not supported on Gno clients yet.");
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

  public async getChannelV1Type(_portId: string, _channelId: string): Promise<Order> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async timeoutPacketsV2(
    _packets: PacketV2[],
    _proofsUnreceived: Uint8Array[],
    _proofHeight: Height,
  ): Promise<MsgResult> {
    /*
    if (packets.length !== proofsUnreceived.length) {
      throw new Error("Packets and proofs must be same length");
    }

    this.logger.verbose(`Timeout ${packets.length} packets...`);
    const senderAddress = this.senderAddress;

    const msgs = [];
    for (const i in packets) {
      const packet = packets[i];
      this.logger.verbose(
        `Timeout packet #${packet.sequence} from ${this.chainId}:${packet.sourceClient}`, packet.payloads,
      );

      const msg = {
        typeUrl: "/ibc.core.channel.v2.MsgTimeout",
        value: MsgTimeoutV2.fromPartial({
          packet,
          proofUnreceived: proofsUnreceived[i],
          proofHeight,
          signer: senderAddress,
        }),
      };
      msgs.push(msg);
    }

    this.logger.debug("MsgTimeout", {
      msgs: msgs,
    });
    const result = await this.sign.signAndBroadcast(
      senderAddress, msgs, "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
    };
    */
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async queryRawProof(store: string, queryKey: Uint8Array, proofHeight: number): Promise<ProvenQuery> {
    const {
      key, value, height, proof, responseBase,
    } = await this.tm.abciQuery({
      path: `/store/${store}/key`,
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

    const result = await this.sign.executePackage(memPackage, TransactionEndpoint.BROADCAST_TX_COMMIT, new Map(), (new Map()).set("ugnot", 2000000),
      {
        gas_wanted: new Long(30000000),
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

  public async getRawReceiptProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = toAscii(
      `receipts/ports/${portId}/channels/${channelId}/sequences/${sequence}`,
    );
    const proven = await this.queryRawProof(
      "ibc", key, Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
    return {
      data: proven.value,
      proof,
      proofHeight,
    };
  }

  public async getRawReceiptProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigUint64BE(sequence);
    const seq = Uint8Array.from(buf);
    const sep = fromHex("02");
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = mergeUint8Arrays(toAscii(
      `${clientId}`), sep, seq,
    );
    const proven = await this.queryRawProof(
      "ibc", key, Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
    return {
      data: proven.value,
      proof,
      proofHeight,
    };
  }

  public async getRawPacketCommitmentProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = toAscii(
      `commitments/ports/${portId}/channels/${channelId}/sequences/${sequence}`,
    );
    const proven = await this.queryRawProof(
      "ibc", key, Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
    this.logger.debug(proven);
    return {
      data: proven.value,
      proof,
      proofHeight,
    };
  }

  public async getRawPacketCommitmentProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigUint64BE(sequence);
    const seq = Uint8Array.from(buf);
    const sep = fromHex("01");
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = mergeUint8Arrays(toAscii(
      `${clientId}`), sep, seq,
    );
    const proven = await this.queryRawProof(
      "ibc", key, Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
    this.logger.debug(proven);
    return {
      data: proven.value,
      proof,
      proofHeight,
    };
  }

  public async getRawPacketAcknowledgementProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = toAscii(
      `acks/ports/${portId}/channels/${channelId}/sequences/${sequence}`,
    );
    const proven = await this.queryRawProof(
      "ibc", key, Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);

    return {
      data: proven.value,
      proof,
      proofHeight,
    };
  }

  public async getRawPacketAcknowledgementProofV2(clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    /* This replaces the QueryClient method which no longer supports QueryRawProof */

    const buf = Buffer.allocUnsafe(8);
    buf.writeBigUint64BE(sequence);
    const seq = Uint8Array.from(buf);
    const sep = fromHex("03");
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = mergeUint8Arrays(toAscii(
      `${clientId}`), sep, seq,
    );
    const proven = await this.queryRawProof(
      "ibc", key, Number(proofHeight.revisionHeight),
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
    if (clientState.responseBase.error) {
      throw new Error(`Client state not found for client ID ${clientId}: ${clientState.responseBase.error}`);
    }
    try {
      const data = JSON.parse(Buffer.from(clientState.responseBase.data).toString("utf-8"));
      const counterparty = data.counterparty_client_id;
      return counterparty;
    }
    catch (e) {
      throw new Error(`Failed to parse client state for client ID ${clientId}: ${e}`);
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
    const txsPackets = await this.getPacketsFromTxsV2(clientId, minHeight, maxHeight);
    const eventsPackets = await this.getPacketsFromBlockEventsV2(clientId, minHeight, maxHeight);
    return ([] as PacketV2WithMetadata[])
      .concat(...txsPackets)
      .concat(...eventsPackets);
  }

  public async queryWrittenAcks(_connectionId: string, _minHeight: number | undefined, _maxHeight: number | undefined): Promise<AckWithMetadata[]> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async queryWrittenAcksV2(_clientId: string, _minHeight: number | undefined, _maxHeight: number | undefined): Promise<AckV2WithMetadata[]> {
    /*
    let query = `write_acknowledgement.packet_dest_client='${clientId}'`;
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.searchTendermintTxs(query);
    const out = search.txs.flatMap(({
      height, result, hash,
    }) => {
      const events = result.events.map(fromTendermintEvent);
      // const sender = logs.findAttribute(parsedLogs, 'message', 'sender').value;
      return parseAcksFromTxEventsV2(events).map(
        (ack): AckV2WithMetadata => ({
          height,
          txHash: toHex(hash).toUpperCase(),
          txEvents: events,
          ...ack,
        }),
      );
    });
    return out;
    */
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async queryUnreceivedPackets(_portId: string, _channelId: string, _sequences: readonly number[]): Promise<number[]> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async queryUnreceivedPacketsV2(_clientId: string, _sequences: readonly number[]): Promise<number[]> {
    /*
    const res = await this.query.ibc.channelV2.unreceivedPackets(
      clientId, sequences,
    );
    return res.sequences.map(seq => Number(seq));
    */
    throw new Error("IBC v1 is not supported on Gno clients yet.");
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

  public async queryCommitmentsV2(_clientId: string, _sequence: bigint): Promise<Uint8Array> {
    /*
    const res = await this.query.ibc.channelV2.packetCommitment(
      clientId, Number(sequence),
    );
    return res.commitment;
    */
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async queryUnreceivedAcks(_portId: string, _channelId: string, _sequences: readonly number[]): Promise<number[]> {
    throw new Error("IBC v1 is not supported on Gno clients yet.");
  }

  public async queryUnreceivedAcksV2(_clientId: string, _sequences: readonly number[]): Promise<number[]> {
    /*
    const res = await this.query.ibc.channelV2.unreceivedAcks(
      clientId, sequences,
    );
    return res.sequences.map(seq => Number(seq));
    */
    throw new Error("IBC v1 is not supported on Gno clients yet.");
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
