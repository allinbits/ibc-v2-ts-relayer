/**
 * ProofQueries module for TendermintIbcClient
 *
 * Handles all IBC proof generation and queries including:
 * - Raw proof queries (ABCI queries with proofs)
 * - Client state and consensus state proofs
 * - Connection and channel proofs
 * - Packet commitment, acknowledgement, and receipt proofs
 * - Both IBC v1 and v2 proof generation
 *
 * This module is responsible for fetching cryptographic proofs from the chain
 * that are used to verify IBC state transitions on counterparty chains.
 */

import {
  Any,
} from "@atomone/cosmos-ibc-types/build/google/protobuf/any.js";
import {
  Packet,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/channel.js";
import {
  Packet as PacketV2,
} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/client.js";
import {
  ClientState, ConsensusState,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  fromHex, toAscii, toHex,
} from "@cosmjs/encoding";
import {
  arrayContentEquals,
} from "@cosmjs/utils";

import type {
  ChannelHandshakeProof,
  ConnectionHandshakeProof,
  DataProof,
  FullProof,
  ProvenQuery,
} from "../../../types/index.js";
import {
  checkAndParseOp,
  convertProofsToIcs23,
  heightQueryString,
  mergeUint8Arrays,
  subtractBlock,
} from "../../../utils/utils.js";
import type {
  TendermintIbcClient,
} from "../IbcClient.js";

/**
 * ProofQueries helper class for TendermintIbcClient.
 *
 * This class contains all proof-related query methods. It's designed to be
 * used internally by TendermintIbcClient through composition.
 */
export class ProofQueries {
  constructor(private client: TendermintIbcClient) {}

  /**
   * Performs a raw ABCI query with proof generation.
   *
   * @param store - The ABCI store to query (e.g., "ibc")
   * @param queryKey - The key to query
   * @param proofHeight - The height at which to generate the proof
   * @returns Proven query result with key, value, height, and Merkle proof
   * @throws Error if query fails or proof is invalid
   */
  public async queryRawProof(store: string, queryKey: Uint8Array, proofHeight: number): Promise<ProvenQuery> {
    const {
      key, value, height, proof, code, log,
    } = await this.client.tm.abciQuery({
      path: `/store/${store}/key`,
      data: queryKey,
      height: proofHeight,
      prove: true,
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

  /**
   * Gets Tendermint consensus state with proof.
   *
   * @param clientId - The client ID
   * @param consensusHeight - The consensus height to query
   * @param proofHeight - The height at which to generate the proof
   * @returns Consensus state and proof
   * @throws Error if no consensus state found
   */
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

  /**
   * Gets Tendermint client state with proof.
   *
   * @param clientId - The client ID
   * @param proofHeight - The height at which to generate the proof
   * @returns Client state and proof
   * @throws Error if no client state found
   */
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

  /**
   * Gets raw channel proof for IBC v1.
   *
   * @param portId - The port ID
   * @param channelId - The channel ID
   * @param proofHeight - The height at which to generate the proof
   * @returns Data proof containing the channel end
   */
  public async getRawChannelProof(portId: string, channelId: string, proofHeight: Height): Promise<DataProof> {
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = toAscii(
      `channelEnds/ports/${portId}/channels/${channelId}`,
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

  /**
   * Gets raw packet receipt proof for IBC v1.
   *
   * @param portId - The port ID
   * @param channelId - The channel ID
   * @param sequence - The packet sequence number
   * @param proofHeight - The height at which to generate the proof
   * @returns Data proof for packet receipt
   */
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

  /**
   * Gets raw packet receipt proof for IBC v2.
   *
   * @param clientId - The client ID
   * @param sequence - The packet sequence number
   * @param proofHeight - The height at which to generate the proof
   * @returns Data proof for packet receipt
   */
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

  /**
   * Gets raw packet commitment proof for IBC v1.
   *
   * @param portId - The port ID
   * @param channelId - The channel ID
   * @param sequence - The packet sequence number
   * @param proofHeight - The height at which to generate the proof
   * @returns Data proof for packet commitment
   */
  public async getRawPacketCommitmentProof(portId: string, channelId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
    /* This replaces the QueryClient method which no longer supports QueryRawProof */
    const key = toAscii(
      `commitments/ports/${portId}/channels/${channelId}/sequences/${sequence}`,
    );
    const proven = await this.queryRawProof(
      "ibc", key, Number(proofHeight.revisionHeight),
    );
    const proof = convertProofsToIcs23(proven.proof);
    this.client.logger.debug(proven);
    return {
      data: proven.value,
      proof,
      proofHeight,
    };
  }

  /**
   * Gets raw packet commitment proof for IBC v2.
   *
   * @param clientId - The client ID
   * @param sequence - The packet sequence number
   * @param proofHeight - The height at which to generate the proof
   * @returns Data proof for packet commitment
   */
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
    this.client.logger.debug(proven);
    return {
      data: proven.value,
      proof,
      proofHeight,
    };
  }

  /**
   * Gets raw packet acknowledgement proof for IBC v1.
   *
   * @param portId - The port ID
   * @param channelId - The channel ID
   * @param sequence - The packet sequence number
   * @param proofHeight - The height at which to generate the proof
   * @returns Data proof for packet acknowledgement
   */
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

  /**
   * Gets raw packet acknowledgement proof for IBC v2.
   *
   * @param clientId - The client ID
   * @param sequence - The packet sequence number
   * @param proofHeight - The height at which to generate the proof
   * @returns Data proof for packet acknowledgement
   */
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

  /**
   * Gets raw client state proof.
   *
   * @param clientId - The client ID
   * @param proofHeight - The height at which to generate the proof
   * @returns Full proof containing the client state
   */
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

  /**
   * Gets raw consensus state proof.
   *
   * @param clientId - The client ID
   * @param consensusHeight - The consensus height to query
   * @param proofHeight - The height at which to generate the proof
   * @returns Full proof containing the consensus state
   */
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

  /**
   * Gets raw connection proof.
   *
   * @param connectionId - The connection ID
   * @param proofHeight - The height at which to generate the proof
   * @returns Full proof containing the connection end
   */
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

  /**
   * Gets complete connection handshake proof bundle.
   *
   * Fetches all proofs needed for connection handshake messages:
   * - Client state proof
   * - Connection end proof
   * - Consensus state proof
   *
   * @param clientId - The client ID
   * @param connectionId - The connection ID
   * @param headerHeight - The header height (will be converted to revision height)
   * @returns Complete connection handshake proof bundle
   */
  public async getConnectionHandshakeProof(
    clientId: string,
    connectionId: string,
    headerHeight: Height | number,
  ): Promise<ConnectionHandshakeProof> {
    const proofHeight = this.client.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const {
      data: clientState,
      proof: proofClient,
      // proofHeight,
    } = await this.getRawClientStateProof(clientId, queryHeight);

    // This is the most recent state we have on this chain of the other
    const {
      latestHeight: consensusHeight,
    }
      = await this.client.query.ibc.client.stateTm(clientId);
    if (!consensusHeight) {
      throw new Error(`No consensus height found for client ${clientId}`);
    }

    // get the init proof
    const {
      proof: proofConnection,
    }
      = await this.getRawConnectionProof(
        connectionId, queryHeight,
      );

    // get the consensus proof
    const {
      proof: proofConsensus,
    }
      = await this.getRawConsensusStateProof(
        clientId, consensusHeight, queryHeight,
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

  /**
   * Gets channel handshake proof.
   *
   * @param portId - The port ID
   * @param channelId - The channel ID
   * @param headerHeight - The header height (will be converted to revision height)
   * @returns Channel handshake proof
   */
  public async getChannelHandshakeProof(
    portId: string,
    channelId: string,
    headerHeight: Height | number,
  ): Promise<ChannelHandshakeProof> {
    const proofHeight = this.client.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const {
      proof,
    } = await this.getRawChannelProof(
      portId, channelId, queryHeight,
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

  /**
   * Gets packet commitment proof for IBC v1.
   *
   * @param packet - The packet to prove
   * @param headerHeight - The header height (will be converted to revision height)
   * @returns Data proof for packet commitment
   */
  public async getPacketProof(
    packet: Packet,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    const proofHeight = this.client.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawPacketCommitmentProof(
      packet.sourcePort, packet.sourceChannel, packet.sequence, queryHeight,
    );

    return proof;
  }

  /**
   * Gets acknowledgement proof for IBC v1.
   *
   * @param originalPacket - The original packet that was acknowledged
   * @param headerHeight - The header height (will be converted to revision height)
   * @returns Data proof for acknowledgement
   */
  public async getAckProof(
    originalPacket: Packet,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    const proofHeight = this.client.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawPacketAcknowledgementProof(
      originalPacket.destinationPort, originalPacket.destinationChannel, originalPacket.sequence, queryHeight,
    );
    return proof;
  }

  /**
   * Gets timeout proof for IBC v1.
   *
   * @param originalPacket - The original packet that timed out
   * @param headerHeight - The header height (will be converted to revision height)
   * @returns Data proof for timeout (receipt proof)
   */
  public async getTimeoutProof(
    originalPacket: Packet,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    const proofHeight = this.client.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawReceiptProof(
      originalPacket.destinationPort, originalPacket.destinationChannel, originalPacket.sequence, queryHeight,
    );
    return proof;
  }

  /**
   * Gets packet commitment proof for IBC v2.
   *
   * @param packet - The packet to prove
   * @param headerHeight - The header height (will be converted to revision height)
   * @returns Data proof for packet commitment
   */
  public async getPacketProofV2(
    packet: PacketV2,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    const proofHeight = this.client.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawPacketCommitmentProofV2(
      packet.sourceClient, packet.sequence, queryHeight,
    );

    return proof;
  }

  /**
   * Gets acknowledgement proof for IBC v2.
   *
   * @param originalPacket - The original packet that was acknowledged
   * @param headerHeight - The header height (will be converted to revision height)
   * @returns Data proof for acknowledgement
   */
  public async getAckProofV2(
    originalPacket: PacketV2,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    const proofHeight = this.client.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawPacketAcknowledgementProofV2(
      originalPacket.destinationClient, originalPacket.sequence, queryHeight,
    );
    return proof;
  }

  /**
   * Gets timeout proof for IBC v2.
   *
   * @param originalPacket - The original packet that timed out
   * @param headerHeight - The header height (will be converted to revision height)
   * @returns Data proof for timeout (receipt proof)
   */
  public async getTimeoutProofV2(
    originalPacket: PacketV2,
    headerHeight: Height | number,
  ): Promise<DataProof> {
    const proofHeight = this.client.ensureRevisionHeight(headerHeight);
    const queryHeight = subtractBlock(proofHeight, 1n);

    const proof = await this.getRawReceiptProofV2(
      originalPacket.destinationClient, originalPacket.sequence, queryHeight,
    );
    return proof;
  }
}
