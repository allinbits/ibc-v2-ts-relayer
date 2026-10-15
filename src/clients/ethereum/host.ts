/**
 * Ethereum as a host of gno.land light clients: GnoLightClient contracts
 * behind the solidity-ibc-eureka ICS26 router.
 */
import {
  Any,
} from "@atomone/atomone-types/google/protobuf/any.js";
import {
  Packet as PacketV2,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";
import {
  ibc,
} from "@gnolang/gno-types";

import {
  AckV2, AnyClientState, AnyConsensusState, ClientStatus, ClientType, ConsensusStateSummary, CreateClientResult, MsgResult,
} from "../../types/index.js";
import type {
  BaseIbcClient,
} from "../BaseIbcClient.js";
import type {
  EthereumIbcClient,
} from "./IbcClient.js";

const todo = (name: string): never => {
  throw new Error(`EthereumIbcClient.${name}: not implemented yet`);
};

export async function getUnbondingPeriod(_c: EthereumIbcClient, _clientId: string): Promise<number> {
  return todo("getUnbondingPeriod");
}

export async function createGnoClient(
  _c: EthereumIbcClient,
  _clientState: ibc.lightclients.gno.v1.gno.ClientState,
  _consensusState: ibc.lightclients.gno.v1.gno.ConsensusState,
): Promise<CreateClientResult> {
  return todo("createGnoClient");
}

export async function updateClient(_c: EthereumIbcClient, _clientId: string, _src: BaseIbcClient): Promise<Height> {
  return todo("updateClient");
}

export async function updateGnoClient(
  _c: EthereumIbcClient,
  _clientId: string,
  _header: ibc.lightclients.gno.v1.gno.Header,
): Promise<MsgResult> {
  return todo("updateGnoClient");
}

export async function registerCounterParty(
  _c: EthereumIbcClient,
  _clientId: string,
  _counterpartyClientId: string,
  _merklePrefix: Uint8Array,
  _merklePathPrefix?: Uint8Array,
): Promise<MsgResult> {
  return todo("registerCounterParty");
}

export async function getClientStatus(_c: EthereumIbcClient, _clientId: string): Promise<ClientStatus> {
  return todo("getClientStatus");
}

export async function getConsensusStatesAfter(
  _c: EthereumIbcClient,
  _clientId: string,
  _type: ClientType,
  _afterRevisionHeight: bigint,
  _limit: number,
): Promise<ConsensusStateSummary[]> {
  return todo("getConsensusStatesAfter");
}

export async function findConflictingHeader(_c: EthereumIbcClient, _clientId: string, _height: Height): Promise<Any | undefined> {
  return todo("findConflictingHeader");
}

export async function submitMisbehaviour(_c: EthereumIbcClient, _clientId: string, _misbehaviour: Any): Promise<MsgResult> {
  return todo("submitMisbehaviour");
}

export async function submitConflictingHeader(
  _c: EthereumIbcClient,
  _clientId: string,
  _src: BaseIbcClient,
  _trustedHeight: number,
  _targetHeight: number,
): Promise<number> {
  return todo("submitConflictingHeader");
}

export async function receivePacketsV2(
  _c: EthereumIbcClient,
  _packets: readonly PacketV2[],
  _proofCommitments: readonly Uint8Array[],
  _proofHeight?: Height,
): Promise<MsgResult> {
  return todo("receivePacketsV2");
}

export async function acknowledgePacketsV2(
  _c: EthereumIbcClient,
  _acks: readonly AckV2[],
  _proofAckeds: readonly Uint8Array[],
  _proofHeight?: Height,
): Promise<MsgResult> {
  return todo("acknowledgePacketsV2");
}

export async function timeoutPacketsV2(
  _c: EthereumIbcClient,
  _packets: PacketV2[],
  _proofsUnreceived: Uint8Array[],
  _proofHeight: Height,
): Promise<MsgResult> {
  return todo("timeoutPacketsV2");
}

export async function getLatestClientState(_c: EthereumIbcClient, _clientId: string, _type: ClientType): Promise<AnyClientState> {
  return todo("getLatestClientState");
}

export async function getConsensusStateAtHeight(
  _c: EthereumIbcClient,
  _clientId: string,
  _type: ClientType,
  _consensusHeight?: Height,
): Promise<AnyConsensusState> {
  return todo("getConsensusStateAtHeight");
}
