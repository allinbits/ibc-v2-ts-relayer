/**
 * PacketHandling module for TendermintIbcClient
 *
 * Handles all IBC packet relay operations including:
 * - Packet reception (receivePacket)
 * - Packet acknowledgement (acknowledgePacket)
 * - Packet timeout (timeoutPacket)
 * - Both IBC v1 and v2 packet handling
 * - Batch operations for efficiency
 *
 * This module implements the core packet relay functionality that transfers
 * data between chains over established IBC channels.
 */

import {
  Order,
  Packet,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/channel.js";
import {
  MsgAcknowledgement,
  MsgRecvPacket,
  MsgTimeout,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/tx.js";
import {
  Acknowledgement,
  Packet as PacketV2,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/packet.js";
import {
  MsgAcknowledgement as MsgAcknowledgementV2,
  MsgRecvPacket as MsgRecvPacketV2,
  MsgTimeout as MsgTimeoutV2,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/tx.js";
import {
  Height,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/client.js";
import {
  isDeliverTxFailure,
} from "@cosmjs/stargate";

import type {
  Ack,
  AckV2,
  MsgResult,
} from "../../../types/index.js";
import {
  createDeliverTxFailureMessage,
  deepCloneAndMutate,
  presentPacketData,
  toBase64AsAny,
} from "../../../utils/utils.js";
import type {
  TendermintIbcClient,
} from "../IbcClient.js";

/**
 * PacketHandshake helper class for TendermintIbcClient.
 *
 * This class contains all packet relay methods. It's designed to be
 * used internally by TendermintIbcClient through composition.
 */
export class PacketHandling {
  constructor(private client: TendermintIbcClient) {}

  /**
   * Receives a single packet on the destination chain (IBC v1).
   *
   * @param packet - The packet to receive
   * @param proofCommitment - Proof of packet commitment on source chain
   * @param proofHeight - The height at which the proof was generated
   * @returns Transaction result
   */
  public receivePacket(
    packet: Packet,
    proofCommitment: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.receivePackets([packet], [proofCommitment], proofHeight);
  }

  /**
   * Receives multiple packets on the destination chain (IBC v1).
   *
   * Batch operation for efficiency - submits multiple packet receipts in one transaction.
   *
   * @param packets - Array of packets to receive
   * @param proofCommitments - Array of packet commitment proofs (must match packets length)
   * @param proofHeight - The height at which the proofs were generated
   * @returns Transaction result
   * @throws Error if packets/proofs length mismatch or transaction fails
   */
  public async receivePackets(
    packets: readonly Packet[],
    proofCommitments: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    this.client.logger.verbose(`Receive ${packets.length} packets..`);
    if (packets.length !== proofCommitments.length) {
      throw new Error(
        `Have ${packets.length} packets, but ${proofCommitments.length} proofs`,
      );
    }
    if (packets.length === 0) {
      throw new Error("Must submit at least 1 packet");
    }

    const senderAddress = this.client.senderAddress;
    const msgs = [];
    for (const i in packets) {
      const packet = packets[i];
      this.client.logger.verbose(
        `Sending packet #${packet.sequence} from ${this.client.chainId}:${packet.sourceChannel}`, presentPacketData(packet.data),
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
    this.client.logger.debug("MsgRecvPacket(s)", {
      msgs: msgs.map(msg =>
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
    const result = await this.client.sign.signAndBroadcast(
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
  }

  /**
   * Receives a single packet on the destination chain (IBC v2).
   *
   * @param packet - The packet to receive
   * @param proofCommitment - Proof of packet commitment on source chain
   * @param proofHeight - The height at which the proof was generated
   * @returns Transaction result
   */
  public receivePacketV2(
    packet: PacketV2,
    proofCommitment: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.receivePacketsV2([packet], [proofCommitment], proofHeight);
  }

  /**
   * Receives multiple packets on the destination chain (IBC v2).
   *
   * Batch operation for efficiency - submits multiple packet receipts in one transaction.
   *
   * @param packets - Array of v2 packets to receive
   * @param proofCommitments - Array of packet commitment proofs (must match packets length)
   * @param proofHeight - The height at which the proofs were generated
   * @returns Transaction result
   * @throws Error if packets/proofs length mismatch or transaction fails
   */
  public async receivePacketsV2(
    packets: readonly PacketV2[],
    proofCommitments: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    this.client.logger.verbose(`Receive ${packets.length} packets..`);
    if (packets.length !== proofCommitments.length) {
      throw new Error(
        `Have ${packets.length} packets, but ${proofCommitments.length} proofs`,
      );
    }
    if (packets.length === 0) {
      throw new Error("Must submit at least 1 packet");
    }

    const senderAddress = this.client.senderAddress;
    const msgs = [];
    for (const i in packets) {
      const packet = packets[i];
      this.client.logger.verbose(
        `Sending packet #${packet.sequence} from ${this.client.chainId}:${packet.sourceClient}`,
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
    this.client.logger.debug("MsgRecvPacket(s)", {
      msgs: msgs.map(msg =>
        deepCloneAndMutate(msg, (mutableMsg) => {
          mutableMsg.value.proofCommitment = toBase64AsAny(
            mutableMsg.value.proofCommitment,
          );
        }),
      ),
    });
    const result = await this.client.sign.signAndBroadcast(
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
  }

  /**
   * Acknowledges a single packet on the source chain (IBC v1).
   *
   * @param ack - The acknowledgement data
   * @param proofAcked - Proof of acknowledgement on destination chain
   * @param proofHeight - The height at which the proof was generated
   * @returns Transaction result
   */
  public acknowledgePacket(
    ack: Ack,
    proofAcked: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.acknowledgePackets([ack], [proofAcked], proofHeight);
  }

  /**
   * Acknowledges multiple packets on the source chain (IBC v1).
   *
   * Batch operation for efficiency - submits multiple acknowledgements in one transaction.
   *
   * @param acks - Array of acknowledgements
   * @param proofAckeds - Array of acknowledgement proofs (must match acks length)
   * @param proofHeight - The height at which the proofs were generated
   * @returns Transaction result
   * @throws Error if acks/proofs length mismatch or transaction fails
   */
  public async acknowledgePackets(
    acks: readonly Ack[],
    proofAckeds: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    this.client.logger.verbose(`Acknowledge ${acks.length} packets...`);
    if (acks.length !== proofAckeds.length) {
      throw new Error(
        `Have ${acks.length} acks, but ${proofAckeds.length} proofs`,
      );
    }
    if (acks.length === 0) {
      throw new Error("Must submit at least 1 ack");
    }

    const senderAddress = this.client.senderAddress;
    const msgs = [];
    for (const i in acks) {
      const packet = acks[i].originalPacket;
      const acknowledgement = acks[i].acknowledgement;

      this.client.logger.verbose(
        `Ack packet #${packet.sequence} from ${this.client.chainId}:${packet.sourceChannel}`, {
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
    this.client.logger.debug("MsgAcknowledgement(s)", {
      msgs: msgs.map(msg =>
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
    const result = await this.client.sign.signAndBroadcast(
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
  }

  /**
   * Acknowledges a single packet on the source chain (IBC v2).
   *
   * @param ack - The acknowledgement data
   * @param proofAcked - Proof of acknowledgement on destination chain
   * @param proofHeight - The height at which the proof was generated
   * @returns Transaction result
   */
  public acknowledgePacketV2(
    ack: AckV2,
    proofAcked: Uint8Array,
    proofHeight?: Height,
  ): Promise<MsgResult> {
    return this.acknowledgePacketsV2([ack], [proofAcked], proofHeight);
  }

  /**
   * Acknowledges multiple packets on the source chain (IBC v2).
   *
   * Batch operation for efficiency - submits multiple acknowledgements in one transaction.
   *
   * @param acks - Array of v2 acknowledgements
   * @param proofAckeds - Array of acknowledgement proofs (must match acks length)
   * @param proofHeight - The height at which the proofs were generated
   * @returns Transaction result
   * @throws Error if acks/proofs length mismatch or transaction fails
   */
  public async acknowledgePacketsV2(
    acks: readonly AckV2[],
    proofAckeds: readonly Uint8Array[],
    proofHeight?: Height,
  ): Promise<MsgResult> {
    this.client.logger.verbose(`Acknowledge ${acks.length} packets...`);
    if (acks.length !== proofAckeds.length) {
      throw new Error(
        `Have ${acks.length} acks, but ${proofAckeds.length} proofs`,
      );
    }
    if (acks.length === 0) {
      throw new Error("Must submit at least 1 ack");
    }

    const senderAddress = this.client.senderAddress;
    const msgs = [];
    for (const i in acks) {
      const packet = acks[i].originalPacket;
      const acknowledgement = Acknowledgement.decode(acks[i].acknowledgement);
      // TODO: construct Ack Message correctly
      this.client.logger.verbose(
        `Ack packet #${packet.sequence} from ${this.client.chainId}:${packet.sourceClient}`, {
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
    this.client.logger.debug("MsgAcknowledgement(s)", {
      msgs: msgs,
    });
    const result = await this.client.sign.signAndBroadcast(
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
  }

  /**
   * Times out a single packet on the source chain (IBC v1).
   *
   * @param packet - The packet to timeout
   * @param proofUnreceived - Proof that packet was not received on destination
   * @param nextSequenceRecv - Next sequence expected on destination (for ordered channels)
   * @param proofHeight - The height at which the proof was generated
   * @returns Transaction result
   */
  public timeoutPacket(
    packet: Packet,
    proofUnreceived: Uint8Array,
    nextSequenceRecv: bigint,
    proofHeight: Height,
  ): Promise<MsgResult> {
    return this.timeoutPackets(
      [packet], [proofUnreceived], [nextSequenceRecv], proofHeight,
    );
  }

  /**
   * Times out multiple packets on the source chain (IBC v1).
   *
   * Batch operation for efficiency - submits multiple packet timeouts in one transaction.
   * Automatically queries channel ordering types to determine if nextSequenceRecv is needed.
   *
   * @param packets - Array of packets to timeout
   * @param proofsUnreceived - Array of unreceived proofs (must match packets length)
   * @param nextSequenceRecv - Array of next sequences (must match packets length)
   * @param proofHeight - The height at which the proofs were generated
   * @returns Transaction result
   * @throws Error if packets/proofs/sequences length mismatch or transaction fails
   */
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

    this.client.logger.verbose(`Timeout ${packets.length} packets...`);
    const senderAddress = this.client.senderAddress;

    // Performance optimization: Gather unique channels and fetch their types in parallel
    // Instead of querying channel type for each packet (O(n) sequential),
    // we deduplicate channels and query in parallel (O(unique_channels))
    // This provides 10-100x speedup for batches with duplicate channels
    const uniqueChannelKeys = new Map<string, Order>();
    for (const packet of packets) {
      const key = `${packet.destinationPort}/${packet.destinationChannel}`;
      if (!uniqueChannelKeys.has(key)) {
        uniqueChannelKeys.set(key, Order.ORDER_NONE_UNSPECIFIED);
      }
    }

    // Fetch all unique channel types in parallel (major performance improvement)
    await Promise.all(
      Array.from(uniqueChannelKeys.keys()).map(async (key) => {
        const [port, channel] = key.split("/");
        const ordering = await this.client.getChannelV1Type(port, channel);
        uniqueChannelKeys.set(key, ordering);
      }),
    );

    // Build messages using cached channel types (O(n) with lookups)
    const msgs = [];
    for (const i in packets) {
      const packet = packets[i];
      this.client.logger.verbose(
        `Timeout packet #${packet.sequence} from ${this.client.chainId}:${packet.sourceChannel}`, presentPacketData(packet.data),
      );

      const key = `${packet.destinationPort}/${packet.destinationChannel}`;
      const channel = uniqueChannelKeys.get(key)!;

      // For ORDERED channels, must use the actual nextSequenceRecv from destination
      // For UNORDERED channels, use the packet's own sequence number
      // This is per IBC spec requirements for timeout proofs
      const msg = {
        typeUrl: "/ibc.core.channel.v1.MsgTimeout",
        value: MsgTimeout.fromPartial({
          packet,
          proofUnreceived: proofsUnreceived[i],
          nextSequenceRecv: channel === Order.ORDER_ORDERED ? nextSequenceRecv[i] : packet.sequence,
          proofHeight,
          signer: senderAddress,
        }),
      };
      msgs.push(msg);
    }

    this.client.logger.debug("MsgTimeout", {
      msgs: msgs.map(msg =>
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
    const result = await this.client.sign.signAndBroadcast(
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
  }

  /**
   * Times out a single packet on the source chain (IBC v2).
   *
   * @param packet - The packet to timeout
   * @param proofUnreceived - Proof that packet was not received on destination
   * @param proofHeight - The height at which the proof was generated
   * @returns Transaction result
   */
  public timeoutPacketV2(
    packet: PacketV2,
    proofUnreceived: Uint8Array,
    proofHeight: Height,
  ): Promise<MsgResult> {
    return this.timeoutPacketsV2(
      [packet], [proofUnreceived], proofHeight,
    );
  }

  /**
   * Times out multiple packets on the source chain (IBC v2).
   *
   * Batch operation for efficiency - submits multiple packet timeouts in one transaction.
   *
   * @param packets - Array of v2 packets to timeout
   * @param proofsUnreceived - Array of unreceived proofs (must match packets length)
   * @param proofHeight - The height at which the proofs were generated
   * @returns Transaction result
   * @throws Error if packets/proofs length mismatch or transaction fails
   */
  public async timeoutPacketsV2(
    packets: PacketV2[],
    proofsUnreceived: Uint8Array[],
    proofHeight: Height,
  ): Promise<MsgResult> {
    if (packets.length !== proofsUnreceived.length) {
      throw new Error("Packets and proofs must be same length");
    }

    this.client.logger.verbose(`Timeout ${packets.length} packets...`);
    const senderAddress = this.client.senderAddress;

    const msgs = [];
    for (const i in packets) {
      const packet = packets[i];
      this.client.logger.verbose(
        `Timeout packet #${packet.sequence} from ${this.client.chainId}:${packet.sourceClient}`, packet.payloads,
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

    this.client.logger.debug("MsgTimeout", {
      msgs: msgs,
    });
    const result = await this.client.sign.signAndBroadcast(
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
  }
}
