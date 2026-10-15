/**
 * Ethereum as a source for the Ethereum light client on gno.land: chain
 * time and heights (beacon slots), sync-committee updates, storage proofs at
 * finalized blocks, and the router's packet events.
 */
import {
  Packet as PacketV2,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";
import {
  ReadonlyDateWithNanoseconds,
} from "@cosmjs/tendermint-rpc";

import {
  AckV2WithMetadata, DataProof, HeaderSummary, PacketV2WithMetadata,
} from "../../types/index.js";
import type {
  EthereumIbcClient,
} from "./IbcClient.js";
import {
  EthereumClientState, EthereumConsensusState, EthereumHeader, EthereumLightClientHeader,
} from "./types.js";

const todo = (name: string): never => {
  throw new Error(`EthereumIbcClient.${name}: not implemented yet`);
};

export async function getChainId(c: EthereumIbcClient): Promise<string> {
  return (await c.publicClient.getChainId()).toString();
}

export async function currentTime(_c: EthereumIbcClient): Promise<ReadonlyDateWithNanoseconds> {
  return todo("currentTime");
}

export async function currentHeight(_c: EthereumIbcClient): Promise<number> {
  return todo("currentHeight");
}

export async function currentRevision(_c: EthereumIbcClient): Promise<Height> {
  return todo("currentRevision");
}

export async function timeoutHeight(_c: EthereumIbcClient, _blocksInFuture: number): Promise<Height> {
  return todo("timeoutHeight");
}

export async function header(_c: EthereumIbcClient, _height: number): Promise<EthereumHeader> {
  return todo("header");
}

export async function latestHeader(_c: EthereumIbcClient): Promise<EthereumHeader> {
  return todo("latestHeader");
}

export async function waitOneBlock(_c: EthereumIbcClient): Promise<void> {
  return todo("waitOneBlock");
}

export async function waitForIndexer(_c: EthereumIbcClient): Promise<void> {
  // Events are read straight from the node.
}

export async function getRawReceiptProofV2(_c: EthereumIbcClient, _clientId: string, _sequence: bigint, _proofHeight: Height): Promise<DataProof> {
  return todo("getRawReceiptProofV2");
}

export async function getRawPacketCommitmentProofV2(_c: EthereumIbcClient, _clientId: string, _sequence: bigint, _proofHeight: Height): Promise<DataProof> {
  return todo("getRawPacketCommitmentProofV2");
}

export async function getRawPacketAcknowledgementProofV2(_c: EthereumIbcClient, _clientId: string, _sequence: bigint, _proofHeight: Height): Promise<DataProof> {
  return todo("getRawPacketAcknowledgementProofV2");
}

export async function getPacketProofV2(_c: EthereumIbcClient, _packet: PacketV2, _headerHeight: Height | number): Promise<DataProof> {
  return todo("getPacketProofV2");
}

export async function getAckProofV2(_c: EthereumIbcClient, _packet: PacketV2, _headerHeight: Height | number): Promise<DataProof> {
  return todo("getAckProofV2");
}

export async function getTimeoutProofV2(_c: EthereumIbcClient, _packet: PacketV2, _headerHeight: Height | number): Promise<DataProof> {
  return todo("getTimeoutProofV2");
}

export async function buildHeader(_c: EthereumIbcClient, _lastHeight: number, _targetHeight?: number): Promise<EthereumLightClientHeader> {
  return todo("buildHeader");
}

export async function buildCreateClientArgs(_c: EthereumIbcClient): Promise<{
  clientState: EthereumClientState
  consensusState: EthereumConsensusState
}> {
  return todo("buildCreateClientArgs");
}

export async function getHeaderSummary(_c: EthereumIbcClient, _height: number): Promise<HeaderSummary> {
  return todo("getHeaderSummary");
}

export async function querySentPacketsV2(
  _c: EthereumIbcClient,
  _clientID: string,
  _minHeight: number | undefined,
  _maxHeight: number | undefined,
): Promise<PacketV2WithMetadata[]> {
  return todo("querySentPacketsV2");
}

export async function queryWrittenAcksV2(
  _c: EthereumIbcClient,
  _clientID: string,
  _minHeight: number | undefined,
  _maxHeight: number | undefined,
): Promise<AckV2WithMetadata[]> {
  return todo("queryWrittenAcksV2");
}

export async function queryUnreceivedPacketsV2(_c: EthereumIbcClient, _clientId: string, _sequences: readonly number[]): Promise<number[]> {
  return todo("queryUnreceivedPacketsV2");
}

export async function queryUnreceivedAcksV2(_c: EthereumIbcClient, _clientId: string, _sequences: readonly number[]): Promise<number[]> {
  return todo("queryUnreceivedAcksV2");
}

export async function queryCommitmentsV2(_c: EthereumIbcClient, _clientId: string, _sequence: bigint): Promise<Uint8Array> {
  return todo("queryCommitmentsV2");
}

export async function getCounterparty(_c: EthereumIbcClient, _clientId: string): Promise<string> {
  return todo("getCounterparty");
}
