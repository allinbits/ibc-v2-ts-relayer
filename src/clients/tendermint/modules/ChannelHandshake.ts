/**
 * ChannelHandshake module for TendermintIbcClient
 *
 * Handles all IBC channel handshake operations including:
 * - Channel opening (4-way handshake: Init, Try, Ack, Confirm)
 * - Channel queries (ordering type, etc.)
 *
 * This module implements the IBC channel handshake protocol which establishes
 * a packet communication channel over an existing connection.
 */

import {
  Order,
  State,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/channel.js";
import {
  MsgChannelOpenAck,
  MsgChannelOpenConfirm,
  MsgChannelOpenInit,
  MsgChannelOpenTry,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/tx.js";
import {
  isDeliverTxFailure,
} from "@cosmjs/stargate";

import type {
  ChannelHandshakeProof,
  ChannelInfo,
  CreateChannelResult,
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

/**
 * ChannelHandshake helper class for TendermintIbcClient.
 *
 * This class contains all channel handshake methods. It's designed to be
 * used internally by TendermintIbcClient through composition.
 */
export class ChannelHandshake {
  constructor(private client: TendermintIbcClient) {}

  /**
   * Initiates a channel opening (Step 1 of 4-way handshake).
   *
   * Creates a new channel on a port over an existing connection.
   *
   * @param portId - The local port ID (e.g., "transfer")
   * @param remotePortId - The remote port ID
   * @param ordering - Channel ordering (ORDERED or UNORDERED)
   * @param connectionId - The connection ID to use
   * @param version - The channel version (e.g., "ics20-1")
   * @returns Result containing the new channel ID and transaction details
   * @throws Error if transaction fails or channel ID cannot be read from events
   *
   * @example
   * ```typescript
   * const result = await client.channelOpenInit(
   *   "transfer",
   *   "transfer",
   *   Order.ORDER_UNORDERED,
   *   "connection-0",
   *   "ics20-1"
   * );
   * console.log(`Channel created: ${result.channelId}`);
   * ```
   */
  public async channelOpenInit(
    portId: string,
    remotePortId: string,
    ordering: Order,
    connectionId: string,
    version: string,
  ): Promise<CreateChannelResult> {
    this.client.logger.verbose(
      `Channel open init: ${portId} => ${remotePortId} (${connectionId})`,
    );
    const senderAddress = this.client.senderAddress;
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
    this.client.logger.debug("MsgChannelOpenInit", msg);

    const result = await this.client.sign.signAndBroadcast(
      senderAddress, [msg], "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    const channelId = result.events
      .find(x => x.type == "channel_open_init")
      ?.attributes.find(x => x.key == "channel_id")?.value;
    if (!channelId) {
      throw new Error(
        `Failed to extract channel ID from ChannelOpenInit transaction. ` +
        `Transaction hash: ${result.transactionHash}, Port: ${portId}, Connection: ${connectionId}. ` +
        `Verify the connection exists and is in OPEN state.`
      );
    }

    this.client.logger.debug(`Channel open init successful: ${channelId}`);
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
      channelId,
    };
  }

  /**
   * Responds to a channel opening (Step 2 of 4-way handshake).
   *
   * Creates a channel on this chain in response to a ChannelOpenInit on the remote chain.
   * Requires proof of the remote channel initialization.
   *
   * @param portId - The local port ID
   * @param remote - The remote channel information (port + channel ID)
   * @param ordering - Channel ordering (ORDERED or UNORDERED)
   * @param connectionId - The connection ID to use
   * @param version - The local channel version
   * @param counterpartyVersion - The remote channel version
   * @param proof - Channel handshake proof from the remote chain
   * @returns Result containing the new channel ID and transaction details
   * @throws Error if transaction fails or channel ID cannot be read from events
   */
  public async channelOpenTry(
    portId: string,
    remote: ChannelInfo,
    ordering: Order,
    connectionId: string,
    version: string,
    counterpartyVersion: string,
    proof: ChannelHandshakeProof,
  ): Promise<CreateChannelResult> {
    this.client.logger.verbose(
      `Channel open try: ${portId} => ${remote.portId} (${remote.channelId})`,
    );
    const senderAddress = this.client.senderAddress;
    const {
      proofHeight, proof: proofInit,
    } = proof;
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
    this.client.logger.debug(
      "MsgChannelOpenTry", deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofInit = toBase64AsAny(mutableMsg.value.proofInit);
      }),
    );

    const result = await this.client.sign.signAndBroadcast(
      senderAddress, [msg], "auto",
    );
    if (isDeliverTxFailure(result)) {
      throw new Error(createDeliverTxFailureMessage(result));
    }

    const channelId = result.events
      .find(x => x.type == "channel_open_try")
      ?.attributes.find(x => x.key == "channel_id")?.value;
    if (!channelId) {
      throw new Error(
        `Failed to extract channel ID from ChannelOpenTry transaction. ` +
        `Transaction hash: ${result.transactionHash}, Port: ${portId}, Counterparty: ${remote.portId}/${remote.channelId}. ` +
        `Verify the connection is open and the proof is valid.`
      );
    }

    this.client.logger.debug(
      `Channel open try successful: ${channelId} => ${remote.channelId})`,
    );
    return {
      events: result.events,
      transactionHash: result.transactionHash,
      height: result.height,
      channelId,
    };
  }

  /**
   * Acknowledges a channel opening (Step 3 of 4-way handshake).
   *
   * Acknowledges the ChannelOpenTry from the remote chain, proving that both sides
   * agree on the channel parameters.
   *
   * @param portId - The local port ID
   * @param channelId - The local channel ID
   * @param counterpartyChannelId - The remote channel ID
   * @param counterpartyVersion - The remote channel version
   * @param proof - Channel handshake proof from the remote chain (ChannelOpenTry proof)
   * @returns Transaction result
   * @throws Error if transaction fails
   */
  public async channelOpenAck(
    portId: string,
    channelId: string,
    counterpartyChannelId: string,
    counterpartyVersion: string,
    proof: ChannelHandshakeProof,
  ): Promise<MsgResult> {
    this.client.logger.verbose(
      `Channel open ack for port ${portId}: ${channelId} => ${counterpartyChannelId}`,
    );
    const senderAddress = this.client.senderAddress;
    const {
      proofHeight, proof: proofTry,
    } = proof;
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
    this.client.logger.debug(
      "MsgChannelOpenAck", deepCloneAndMutate(msg, (mutableMsg) => {
        mutableMsg.value.proofTry = toBase64AsAny(mutableMsg.value.proofTry);
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
   * Confirms a channel opening (Step 4 of 4-way handshake).
   *
   * Final step that confirms the ChannelOpenAck from the remote chain,
   * completing the channel handshake.
   *
   * @param portId - The local port ID
   * @param channelId - The local channel ID
   * @param proof - Channel handshake proof from the remote chain (ChannelOpenAck proof)
   * @returns Transaction result
   * @throws Error if transaction fails
   */
  public async channelOpenConfirm(
    portId: string,
    channelId: string,
    proof: ChannelHandshakeProof,
  ): Promise<MsgResult> {
    this.client.logger.verbose(
      `Chanel open confirm for port ${portId}: ${channelId} => ${proof.id.channelId}`,
    );
    const senderAddress = this.client.senderAddress;
    const {
      proofHeight, proof: proofAck,
    } = proof;
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
    this.client.logger.debug(
      "MsgChannelOpenConfirm "
      + deepCloneAndMutate(msg, (mutableMsg) => {
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
   * Gets the ordering type (ORDERED/UNORDERED) for an IBC v1 channel.
   *
   * @param portId - The port ID
   * @param channelId - The channel ID
   * @returns The channel ordering type
   * @throws Error if channel not found
   */
  public async getChannelV1Type(portId: string, channelId: string): Promise<Order> {
    const channel = await this.client.query.ibc.channel.channel(portId, channelId);
    if (!channel || !channel.channel) {
      throw new Error(`Channel not found for port ${portId} and channel ${channelId}`);
    }
    return channel.channel.ordering;
  }
}
