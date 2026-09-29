import {
  Any,
} from "@atomone/atomone-types/google/protobuf/any.js";
import {
  Timestamp,
} from "@atomone/atomone-types/google/protobuf/timestamp.js";
import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";
import {
  MsgUpdateClient,
} from "@atomone/atomone-types/ibc/core/client/v1/tx.js";
import {
  Header as TendermintHeader,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  decodeTxRaw,
} from "@cosmjs/proto-signing";
import {
  arrayContentEquals,
} from "@cosmjs/utils";
import {
  ibc,
} from "@gnolang/gno-types";

import {
  AnyConsensusState, ClientStatus, ConsensusStateSummary, HeaderSummary, MisbehaviourKind,
} from "../types/index.js";

const NANOS_PER_SECOND = 1_000_000_000n;

export const TENDERMINT_HEADER_TYPE_URL = "/ibc.lightclients.tendermint.v1.Header";
export const GNO_HEADER_TYPE_URL = "/ibc.lightclients.gno.v1.Header";
export const TENDERMINT_MISBEHAVIOUR_TYPE_URL = "/ibc.lightclients.tendermint.v1.Misbehaviour";
export const GNO_MISBEHAVIOUR_TYPE_URL = "/ibc.lightclients.gno.v1.Misbehaviour";

export function timestampToNanos(timestamp: Timestamp | undefined): bigint {
  if (!timestamp) {
    return 0n;
  }
  return BigInt(timestamp.seconds) * NANOS_PER_SECOND + BigInt(timestamp.nanos);
}

export function parseClientStatus(status: string): ClientStatus {
  return (Object.values(ClientStatus) as string[]).includes(status) ? status as ClientStatus : ClientStatus.Unknown;
}

export function summarizeConsensusState(
  height: Height,
  consensusState: AnyConsensusState,
  timestampPrecision: ConsensusStateSummary["timestampPrecision"] = "nanoseconds",
): ConsensusStateSummary {
  return {
    revisionNumber: height.revisionNumber,
    revisionHeight: height.revisionHeight,
    timestampNanos: timestampToNanos(consensusState.timestamp),
    timestampPrecision,
    root: consensusState.root?.hash ?? new Uint8Array(),
    nextValidatorsHash: consensusState.nextValidatorsHash,
  };
}

/**
 * Compares a light client's stored consensus state with the source chain's own
 * header at the same height. A light client derives its consensus state from
 * the header's app hash, next validators hash and time, so any difference
 * means the client was updated with a header the source chain never committed.
 *
 * @returns The kind of conflict, or undefined if they agree
 */
export function detectConsensusStateConflict(consensusState: ConsensusStateSummary, header: HeaderSummary): MisbehaviourKind | undefined {
  if (!arrayContentEquals(consensusState.root, header.appHash) || !arrayContentEquals(consensusState.nextValidatorsHash, header.nextValidatorsHash)) {
    return MisbehaviourKind.Fork;
  }
  const headerTimestamp = consensusState.timestampPrecision === "seconds"
    ? header.timestampNanos / NANOS_PER_SECOND * NANOS_PER_SECOND
    : header.timestampNanos;
  if (consensusState.timestampNanos !== headerTimestamp) {
    return MisbehaviourKind.Time;
  }
  return undefined;
}

function lightClientHeaderHeight(clientMessage: Any): bigint | undefined {
  switch (clientMessage.typeUrl) {
    case TENDERMINT_HEADER_TYPE_URL:
      return TendermintHeader.decode(clientMessage.value).signedHeader?.header?.height;
    case GNO_HEADER_TYPE_URL:
      return ibc.lightclients.gno.v1.gno.Header.decode(clientMessage.value).signedHeader?.header?.height;
    default:
      return undefined;
  }
}

/**
 * Finds the header a transaction submitted to `clientId` for `height`.
 *
 * @param tx - The raw transaction bytes
 * @returns The header as an Any, or undefined if the tx has no such update
 */
export function findUpdateClientHeader(tx: Uint8Array, clientId: string, height: bigint): Any | undefined {
  const {
    body,
  } = decodeTxRaw(tx);
  for (const message of body.messages) {
    if (message.typeUrl !== "/ibc.core.client.v1.MsgUpdateClient") {
      continue;
    }
    const update = MsgUpdateClient.decode(message.value);
    if (update.clientId !== clientId || !update.clientMessage) {
      continue;
    }
    if (lightClientHeaderHeight(update.clientMessage) === height) {
      return update.clientMessage;
    }
  }
  return undefined;
}
