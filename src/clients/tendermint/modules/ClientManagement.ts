/**
 * ClientManagement module for TendermintIbcClient
 *
 * Handles all IBC light client management operations including:
 * - Client creation and updates
 * - Header building and validation
 * - Validator set queries
 * - Client state queries (latest and at specific heights)
 * - Consensus state queries
 * - Unbonding period queries
 *
 * This module is responsible for managing the lifecycle of Tendermint light clients
 * and building the cryptographic proofs needed for client updates.
 */

import {
  Any,
} from "@atomone/cosmos-ibc-types/build/google/protobuf/any.js";
import {
  Height,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/client.js";
import {
  MsgCreateClient,
  MsgUpdateClient,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/tx.js";
import {
  ClientState,
  ConsensusState as TendermintConsensusState,
  Header as TendermintHeader,
  ClientState as TendermintClientState,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  Commit,
  Header,
  SignedHeader,
} from "@atomone/cosmos-ibc-types/build/tendermint/types/types.js";
import {
  blockIDFlagFromJSON,
  ValidatorSet,
} from "@atomone/cosmos-ibc-types/build/tendermint/types/validator.js";
import {
  isDeliverTxFailure,
} from "@cosmjs/stargate";
import {
  arrayContentEquals,
} from "@cosmjs/utils";

import type {
  BaseIbcClient,
} from "../../BaseIbcClient.js";
import {
  isTendermint,
} from "../../BaseIbcClient.js";
import type {
  CometCommitResponse,
  CreateClientArgs,
  CreateClientResult,
  MsgResult,
} from "../../../types/index.js";
import {
  buildTendermintClientState,
  buildTendermintConsensusState,
  createDeliverTxFailureMessage,
  deepCloneAndMutate,
  mapRpcPubKeyToProto,
  timestampFromDateNanos,
  toBase64AsAny,
  toIntHeight,
} from "../../../utils/utils.js";
import type {
  TendermintIbcClient,
} from "../IbcClient.js";

/**
 * ClientManagement helper class for TendermintIbcClient.
 *
 * This class contains all light client management methods. It's designed to be
 * used internally by TendermintIbcClient through composition.
 */
export class ClientManagement {
  constructor(private client: TendermintIbcClient) {}

  /**
   * Gets a Tendermint commit (block header + commit signatures) at a specific height.
   *
   * @param height - The block height to query, undefined for latest commit
   * @returns Commit response containing header and commit signatures
   */
  public getTendermintCommit(height?: number): Promise<CometCommitResponse> {
    this.client.logger.verbose(
      height === undefined
        ? "Get latest commit"
        : `Get commit for height ${height}`,
    );
    return this.client.tm.commit(height);
  }

  /**
   * Returns the unbonding period in seconds from the staking module.
   *
   * This is used to set the trusting period for light clients (typically 2/3 of unbonding period).
   *
   * @returns Unbonding period in seconds
   * @throws Error if no unbonding period is found
   */
  public async getUnbondingPeriod(): Promise<number> {
    const {
      params,
    } = await this.client.query.staking.params();
    const seconds = Number(params?.unbondingTime?.seconds ?? 0);
    if (!seconds) {
      throw new Error("No unbonding period found");
    }
    this.client.logger.verbose("Queried unbonding period", {
      seconds,
    });
    return seconds;
  }

  /**
   * Gets a signed header (header + commit) at a specific height.
   *
   * Converts from CometBFT RPC format to IBC protobuf format.
   *
   * @param height - The block height to query, undefined for latest
   * @returns Signed header in IBC protobuf format
   */
  public async getSignedHeader(height?: number): Promise<SignedHeader> {
    const {
      header: rpcHeader, commit: rpcCommit,
    }
      = await this.getTendermintCommit(height);
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

    const signatures = rpcCommit.signatures.map(sig => ({
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

    return {
      header,
      commit,
    };
  }

  /**
   * Gets the last known height of a light client on this chain.
   *
   * @param clientId - The client ID to query
   * @returns The latest height the client has been updated to
   */
  public async lastKnownHeight(clientId: string): Promise<number> {
    const rawClientState = await this.getLatestClientState(clientId);
    const clientState = ClientState.decode(rawClientState.value);
    return Number(clientState.latestHeight?.revisionHeight ?? 0);
  }

  /**
   * Gets the validator set at a specific height.
   *
   * @param height - The block height to query validators for
   * @returns Validator set with proposer information
   */
  public async getValidatorSet(height: number): Promise<ValidatorSet> {
    this.client.logger.verbose(`Get validator set for height ${height}`);
    // we need to query the header to find out who the proposer was, and pull them out
    const {
      proposerAddress,
    } = await this.client.header(height);
    const validators = await this.client.tm.validatorsAll(height);
    const mappedValidators = validators.validators.map(val => ({
      address: val.address,
      pubKey: mapRpcPubKeyToProto(val.pubkey),
      votingPower: val.votingPower,
      proposerPriority: val.proposerPriority
        ? BigInt(val.proposerPriority)
        : undefined,
    }));
    const totalPower = validators.validators.reduce(
      (accumulator, v) => accumulator + v.votingPower, BigInt(0),
    );
    const proposer = mappedValidators.find(val =>
      arrayContentEquals(val.address, proposerAddress),
    );
    return ValidatorSet.fromPartial({
      validators: mappedValidators,
      totalVotingPower: totalPower,
      proposer,
    });
  }

  /**
   * Builds a header for updating a light client on a remote chain.
   *
   * This creates the cryptographic proof bundle needed to update a light client
   * to the latest state of this chain. Includes:
   * - Current signed header
   * - Current validator set
   * - Trusted validator set (from lastHeight + 1)
   *
   * @param lastHeight - The last known height on the remote side
   * @returns Tendermint header for client update
   * @throws Error if signed header is missing header field
   *
   * @see https://github.com/cosmos/cosmos-sdk/blob/v0.41.0/x/ibc/light-clients/07-tendermint/types/update.go#L87-L167
   * @see https://github.com/tendermint/tendermint/blob/v0.34.3/light/verifier.go#L19-L79
   */
  public async buildHeader(lastHeight: number): Promise<TendermintHeader> {
    const signedHeader = await this.getSignedHeader();
    // "assert that trustedVals is NextValidators of last trusted header"
    // https://github.com/cosmos/cosmos-sdk/blob/v0.41.0/x/ibc/light-clients/07-tendermint/types/update.go#L74
    const validatorHeight = lastHeight + 1;
    if (!signedHeader.header) {
      throw new Error("Signed header missing header field");
    }
    const curHeight = Number(signedHeader.header.height);
    return TendermintHeader.fromPartial({
      signedHeader,
      validatorSet: await this.getValidatorSet(curHeight),
      trustedHeight: this.client.revisionHeight(lastHeight),
      trustedValidators: await this.getValidatorSet(validatorHeight),
    });
  }

  /**
   * Gets the consensus state at a specific height for a light client.
   *
   * @param clientId - The client ID to query
   * @param consensusHeight - The consensus height to query, undefined for latest
   * @returns Consensus state at the specified height
   * @throws Error if consensus state not found
   */
  public async getConsensusStateAtHeight(clientId: string, consensusHeight?: Height): Promise<Any> {
    const revisionHeight = consensusHeight ? Number(consensusHeight.revisionHeight) : undefined;
    const consensusState = await this.client.query.ibc.client.consensusState(clientId, revisionHeight);
    if (!consensusState.consensusState) {
      const heightStr = consensusHeight ? `${consensusHeight.revisionNumber}-${consensusHeight.revisionHeight}` : "latest";
      throw new Error(
        `Consensus state not found for client ${clientId} at height ${heightStr}. ` +
        `Client may not exist or height may be pruned. Chain: ${this.client.chainId}`
      );
    }
    return consensusState.consensusState;
  }

  /**
   * Gets the latest client state for a light client.
   *
   * @param clientId - The client ID to query
   * @returns Latest client state
   * @throws Error if client state not found
   */
  public async getLatestClientState(clientId: string): Promise<Any> {
    const clientState = await this.client.query.ibc.client.state(clientId);
    if (!clientState || !clientState.clientState) {
      throw new Error(
        `Client state not found for client ${clientId} on chain ${this.client.chainId}. ` +
        `Ensure the client exists and has been created successfully.`
      );
    }
    return clientState.clientState;
  }

  /**
   * Updates a light client on this chain with the latest state from the source chain.
   *
   * Automatically builds the update header from the source chain and submits it.
   *
   * @param clientId - The client ID to update
   * @param src - The source chain client to fetch the latest state from
   * @returns The height that was updated to
   */
  public async updateClient(
    clientId: string,
    src: BaseIbcClient,
  ): Promise<Height> {
    const {
      latestHeight,
    } = await this.client.query.ibc.client.stateTm(clientId);
    let height: number = 0;
    if (isTendermint(src)) {
      const header = await src.buildHeader(toIntHeight(latestHeight));
      await this.updateTendermintClient(clientId, header);
      height = Number(header.signedHeader?.header?.height ?? 0);
    }
    return src.revisionHeight(height);
  }

  /**
   * Creates a new Tendermint light client on this chain.
   *
   * @param clientState - The initial client state
   * @param consensusState - The initial consensus state
   * @returns Result containing the new client ID and transaction details
   * @throws Error if transaction fails or client ID cannot be read from events
   */
  public async createTendermintClient(
    clientState: TendermintClientState,
    consensusState: TendermintConsensusState,
  ): Promise<CreateClientResult> {
    this.client.logger.verbose("Create Tendermint client");
    const senderAddress = this.client.senderAddress;
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
    this.client.logger.debug("MsgCreateClient", createMsg);

    const result = await this.client.sign.signAndBroadcast(
      senderAddress, [createMsg], "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    const clientId = result.events
      .find(x => x.type == "create_client")
      ?.attributes.find(x => x.key == "client_id")?.value;
    if (!clientId) {
      throw new Error(
        `Failed to extract client ID from transaction events. Transaction hash: ${result.transactionHash}. ` +
        `This may indicate a chain configuration issue or incompatible IBC version.`
      );
    }

    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
      clientId,
    };
  }

  /**
   * Updates a Tendermint light client with a new header.
   *
   * @param clientId - The client ID to update
   * @param header - The new header to update the client with
   * @returns Transaction result
   * @throws Error if transaction fails
   */
  public async updateTendermintClient(
    clientId: string,
    header: TendermintHeader,
  ): Promise<MsgResult> {
    this.client.logger.verbose(`Update Tendermint client ${clientId}`);
    const senderAddress = this.client.senderAddress;
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

    this.client.logger.debug(
      "MsgUpdateClient", deepCloneAndMutate(updateMsg, (mutableMsg) => {
        if (mutableMsg.value.clientMessage?.value) {
          mutableMsg.value.clientMessage.value = toBase64AsAny(
            mutableMsg.value.clientMessage.value,
          );
        }
      }),
    );

    const result = await this.client.sign.signAndBroadcast(
      senderAddress, [updateMsg], "auto",
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

  /**
   * Builds the arguments needed to create a new light client.
   *
   * Automatically queries the latest header, unbonding period, and calculates
   * the appropriate trust period (2/3 of unbonding period by default).
   *
   * @param trustPeriodSec - Optional trust period in seconds, defaults to 2/3 of unbonding period
   * @returns Client state and consensus state ready for client creation
   */
  public async buildCreateClientArgs(trustPeriodSec?: number | null): Promise<CreateClientArgs> {
    const header = await this.client.latestHeader();
    const consensusState = buildTendermintConsensusState(header);
    const unbondingPeriodSec = await this.getUnbondingPeriod();
    if (trustPeriodSec === undefined || trustPeriodSec === null) {
      trustPeriodSec = Math.floor((unbondingPeriodSec * 2) / 3);
    }
    const clientState = buildTendermintClientState(
      this.client.chainId, unbondingPeriodSec, trustPeriodSec, this.client.revisionHeight(header.height),
    );
    return {
      consensusState,
      clientState,
    };
  }
}
