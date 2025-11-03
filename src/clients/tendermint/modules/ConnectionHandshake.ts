/**
 * ConnectionHandshake module for TendermintIbcClient
 *
 * Handles all IBC connection handshake operations including:
 * - Connection opening (4-way handshake: Init, Try, Ack, Confirm)
 * - Connection queries
 * - Counterparty client queries (for IBC v2)
 *
 * This module implements the IBC connection handshake protocol which establishes
 * a verified connection between two chains using their respective light clients.
 */

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
  isDeliverTxFailure,
} from "@cosmjs/stargate";

import type {
  ConnectionHandshakeProof,
  CreateConnectionResult,
  MsgResult,
} from "../../../types/index.js";
import {
  createDeliverTxFailureMessage,
  deepCloneAndMutate,
  toBase64AsAny,
} from "../../../utils/utils.js";
import type {
  TendermintIbcClient,
} from "../IbcClient.js";

// Default connection parameters
const defaultMerklePrefix = {
  keyPrefix: new TextEncoder().encode("ibc"),
};
const defaultConnectionVersion = {
  identifier: "1",
  features: ["ORDER_ORDERED", "ORDER_UNORDERED"],
};
const defaultDelayPeriod = 0n;

/**
 * ConnectionHandshake helper class for TendermintIbcClient.
 *
 * This class contains all connection handshake methods. It's designed to be
 * used internally by TendermintIbcClient through composition.
 */
export class ConnectionHandshake {
  constructor(private client: TendermintIbcClient) {}

  /**
   * Initiates a connection opening (Step 1 of 4-way handshake).
   *
   * Creates a new connection on this chain pointing to a client on the remote chain.
   * This is the first step in the connection handshake.
   *
   * @param clientId - The local client ID
   * @param remoteClientId - The remote client ID to connect to
   * @returns Result containing the new connection ID and transaction details
   * @throws Error if transaction fails or connection ID cannot be read from events
   *
   * @example
   * ```typescript
   * const result = await client.connOpenInit(
   *   "07-tendermint-0",  // local client
   *   "07-tendermint-1"   // remote client
   * );
   * console.log(`Connection created: ${result.connectionId}`);
   * ```
   */
  public async connOpenInit(
    clientId: string,
    remoteClientId: string,
  ): Promise<CreateConnectionResult> {
    this.client.logger.info(`Connection open init: ${clientId} => ${remoteClientId}`);
    const senderAddress = this.client.senderAddress;
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
    this.client.logger.debug("MsgConnectionOpenInit", msg);

    const result = await this.client.sign.signAndBroadcast(
      senderAddress, [msg], "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    const connectionId = result.events
      .find(x => x.type == "connection_open_init")
      ?.attributes.find(x => x.key == "connection_id")?.value;
    if (!connectionId) {
      throw new Error(
        `Failed to extract connection ID from ConnOpenInit transaction. ` +
        `Transaction hash: ${result.transactionHash}, Chain: ${this.client.chainId}. ` +
        `This may indicate an incompatible IBC module version.`
      );
    }

    this.client.logger.debug(`Connection open init successful: ${connectionId}`);
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
      connectionId,
    };
  }

  /**
   * Responds to a connection opening (Step 2 of 4-way handshake).
   *
   * Creates a connection on this chain in response to a ConnOpenInit on the remote chain.
   * Requires proof of the remote connection initialization.
   *
   * @param myClientId - The local client ID
   * @param proof - Connection handshake proof from the remote chain
   * @returns Result containing the new connection ID and transaction details
   * @throws Error if transaction fails or connection ID cannot be read from events
   */
  public async connOpenTry(
    myClientId: string,
    proof: ConnectionHandshakeProof,
  ): Promise<CreateConnectionResult> {
    this.client.logger.info(
      `Connection open try: ${myClientId} => ${proof.clientId} (${proof.connectionId})`,
    );
    const senderAddress = this.client.senderAddress;
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
    this.client.logger.debug(
      "MsgConnectionOpenTry", deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofClient = toBase64AsAny(
          mutableMsg.value.proofClient,
        );
        mutableMsg.value.proofConsensus = toBase64AsAny(
          mutableMsg.value.proofConsensus,
        );
        mutableMsg.value.proofInit = toBase64AsAny(mutableMsg.value.proofInit);
      }),
    );

    const result = await this.client.sign.signAndBroadcast(
      senderAddress, [msg], "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    const myConnectionId = result.events
      .find(x => x.type == "connection_open_try")
      ?.attributes.find(x => x.key == "connection_id")?.value;
    if (!myConnectionId) {
      throw new Error(
        `Failed to extract connection ID from ConnOpenTry transaction. ` +
        `Transaction hash: ${result.transactionHash}, Counterparty connection: ${connectionId}. ` +
        `Verify the proof is valid and the counterparty connection exists.`
      );
    }

    this.client.logger.debug(
      `Connection open try successful: ${myConnectionId} => ${connectionId}`,
    );
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
      connectionId: myConnectionId,
    };
  }

  /**
   * Acknowledges a connection opening (Step 3 of 4-way handshake).
   *
   * Acknowledges the ConnOpenTry from the remote chain, proving that both sides
   * agree on the connection parameters.
   *
   * @param myConnectionId - The local connection ID
   * @param proof - Connection handshake proof from the remote chain (ConnOpenTry proof)
   * @returns Transaction result
   * @throws Error if transaction fails
   */
  public async connOpenAck(
    myConnectionId: string,
    proof: ConnectionHandshakeProof,
  ): Promise<MsgResult> {
    this.client.logger.info(
      `Connection open ack: ${myConnectionId} => ${proof.connectionId}`,
    );
    const senderAddress = this.client.senderAddress;
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
    this.client.logger.debug(
      "MsgConnectionOpenAck", deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofConsensus = toBase64AsAny(
          mutableMsg.value.proofConsensus,
        );
        mutableMsg.value.proofTry = toBase64AsAny(mutableMsg.value.proofTry);
        mutableMsg.value.proofClient = toBase64AsAny(
          mutableMsg.value.proofClient,
        );
      }),
    );

    const result = await this.client.sign.signAndBroadcast(
      senderAddress, [msg], "auto",
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
   * Confirms a connection opening (Step 4 of 4-way handshake).
   *
   * Final step that confirms the ConnOpenAck from the remote chain,
   * completing the connection handshake.
   *
   * @param myConnectionId - The local connection ID
   * @param proof - Connection handshake proof from the remote chain (ConnOpenAck proof)
   * @returns Transaction result
   * @throws Error if transaction fails
   */
  public async connOpenConfirm(
    myConnectionId: string,
    proof: ConnectionHandshakeProof,
  ): Promise<MsgResult> {
    this.client.logger.info(`Connection open confirm: ${myConnectionId}`);
    const senderAddress = this.client.senderAddress;
    const {
      proofHeight, proofConnection: proofAck,
    } = proof;
    const msg = {
      typeUrl: "/ibc.core.connection.v1.MsgConnectionOpenConfirm",
      value: MsgConnectionOpenConfirm.fromPartial({
        connectionId: myConnectionId,
        signer: senderAddress,
        proofHeight,
        proofAck,
      }),
    };
    this.client.logger.debug(
      "MsgConnectionOpenConfirm", deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofAck = toBase64AsAny(mutableMsg.value.proofAck);
      }),
    );

    const result = await this.client.sign.signAndBroadcast(
      senderAddress, [msg], "auto",
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
   * Queries a connection by its ID.
   *
   * @param connectionId - The connection ID to query
   * @returns Connection information
   * @throws Error if connection not found
   */
  public async getConnection(connectionId: string): Promise<Partial<QueryConnectionResponse>> {
    const connection = await this.client.query.ibc.connection.connection(connectionId);
    this.client.logger.debug(`Connection ${connectionId} found`, connection);
    if (!connection.connection) {
      throw new Error(`No connection ${connectionId} found`);
    }
    return connection;
  }

  /**
   * Gets the counterparty client ID for an IBC v2 client.
   *
   * In IBC v2, clients register their counterparty relationships.
   * This method queries that registered counterparty.
   *
   * @param clientId - The client ID to query
   * @returns The counterparty client ID
   * @throws Error if no counterparty registered
   */
  public async getCounterparty(clientId: string): Promise<string> {
    const counterparty = await this.client.query.ibc.clientV2.counterparty(clientId);
    this.client.logger.debug(`Client ${clientId} found`, counterparty);
    if (!counterparty.counterpartyInfo) {
      throw new Error(`No counterparty for ${clientId} found`);
    }
    return counterparty.counterpartyInfo.clientId;
  }
}
