import { CommitmentProof, HashOp, LengthOp } from "@atomone/cosmos-ibc-types/build/cosmos/ics23/v1/proofs";
import { Any } from "@atomone/cosmos-ibc-types/build/google/protobuf/any";
import { Timestamp } from "@atomone/cosmos-ibc-types/build/google/protobuf/timestamp";
import { Packet } from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v1/channel";
import { Packet as PacketV2 } from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/packet";
import { Height } from "@atomone/cosmos-ibc-types/build/ibc/core/client/v1/client";
import { MerkleProof } from "@atomone/cosmos-ibc-types/build/ibc/core/commitment/v1/commitment";
import {
  ClientState as SolomachineV2ClientState,
  ConsensusState as SolomachineV2ConsensusState,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/solomachine/v2/solomachine";
import {
  ClientState as SolomachineV3ClientState,
  ConsensusState as SolomachineV3ConsensusState,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/solomachine/v3/solomachine";
import {
  ClientState as TendermintClientState,
  ConsensusState as TendermintConsensusState,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/tendermint/v1/tendermint";
import {
  ClientState as WasmClientState,
  ConsensusState as WasmConsensusState,
} from "@atomone/cosmos-ibc-types/build/ibc/lightclients/wasm/v1/wasm";
import { PublicKey as ProtoPubKey } from "@atomone/cosmos-ibc-types/build/tendermint/crypto/keys";
import { ProofOps } from "@atomone/cosmos-ibc-types/build/tendermint/crypto/proof";
import { fromHex, fromUtf8, toBase64, toHex } from "@cosmjs/encoding";
import {
  DeliverTxResponse,
  Event,
  fromTendermintEvent,
} from "@cosmjs/stargate";
import {
  ReadonlyDateWithNanoseconds,
  tendermint34,
  tendermint37,
  ValidatorPubkey as RpcPubKey,
} from "@cosmjs/tendermint-rpc";
import { arrayContentEquals } from "@cosmjs/utils";

import { BaseIbcClient } from "../clients/BaseIbcClient";
import { Ack, AckV2, ChannelHandshakeProof, ConnectionHandshakeProof, PacketV2WithMetadata, PacketWithMetadata } from "../types";


export function deepCloneAndMutate<T extends Record<string, unknown>>(
  object: T,
  mutateFn: (deepClonedObject: T) => void,
): Record<string, unknown> {
  const deepClonedObject = structuredClone(object);
  mutateFn(deepClonedObject);

  return deepClonedObject;
}

export function toBase64AsAny(...input: Parameters<typeof toBase64>) {
  return toBase64(...input) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
export function createDeliverTxFailureMessage(
  result: DeliverTxResponse,
): string {
  return `Error when broadcasting tx ${result.transactionHash} at height ${result.height}. Code: ${result.code}; Raw log: ${result.rawLog}`;
}

export function toIntHeight(height?: Height): number {
  // eslint-disable-next-line no-constant-binary-expression
  return Number(height?.revisionHeight) ?? 0;
}

export function ensureIntHeight(height: bigint | Height): number {
  if (typeof height === "bigint") {
    return Number(height);
  }
  return toIntHeight(height);
}

export function subtractBlock(height: Height, count = 1n): Height {
  return {
    revisionNumber: height.revisionNumber,
    revisionHeight: height.revisionHeight - count,
  };
}

const regexRevNum = new RegExp("-([1-9][0-9]*)$");

export function heightQueryString(height: Height): string {
  return `${height.revisionNumber}-${height.revisionHeight}`;
}

export function parseRevisionNumber(chainId: string): bigint {
  const match = chainId.match(regexRevNum);
  if (match && match.length >= 2) {
    return BigInt(match[1]);
  }
  return 0n;
}

// may will run the transform if value is defined, otherwise returns undefined
export function may<T, U>(
  transform: (val: T) => U,
  value: T | null | undefined,
): U | undefined {
  return value === undefined || value === null ? undefined : transform(value);
}

export function mapRpcPubKeyToProto(
  pubkey?: RpcPubKey,
): ProtoPubKey | undefined {
  if (pubkey === undefined) {
    return undefined;
  }
  if (pubkey.algorithm == "ed25519") {
    return {
      ed25519: pubkey.data,
      secp256k1: undefined,
    };
  } else if (pubkey.algorithm == "secp256k1") {
    return {
      ed25519: undefined,
      secp256k1: pubkey.data,
    };
  } else {
    throw new Error(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `Unknown validator pubkey type: ${(pubkey as any).algorithm}`,
    );
  }
}

export function timestampFromDateNanos(
  date: ReadonlyDateWithNanoseconds,
): Timestamp {
  const nanos = (date.getTime() % 1000) * 1000000 + (date.nanoseconds ?? 0);
  return Timestamp.fromPartial({
    seconds: BigInt(Math.floor(date.getTime() / 1000)),
    nanos,
  });
}

export function secondsFromDateNanos(
  date: ReadonlyDateWithNanoseconds,
): number {
  return Math.floor(date.getTime() / 1000);
}

export function buildTendermintConsensusState(
  header: tendermint34.Header | tendermint37.Header,
): TendermintConsensusState {
  return TendermintConsensusState.fromPartial({
    timestamp: timestampFromDateNanos(header.time),
    root: {
      hash: header.appHash,
    },
    nextValidatorsHash: header.nextValidatorsHash,
  });
}

// Note: we hardcode a number of assumptions, like trust level, clock drift, and assume revisionNumber is 1
export function buildTendermintClientState(
  chainId: string,
  unbondingPeriodSec: number,
  trustPeriodSec: number,
  height: Height,
): TendermintClientState {
  // Copied here until https://github.com/confio/ics23/issues/36 is resolved
  // https://github.com/confio/ics23/blob/master/js/src/proofs.ts#L11-L26
  const iavlSpec = {
    leafSpec: {
      prefix: Uint8Array.from([0]),
      hash: HashOp.SHA256,
      prehashValue: HashOp.SHA256,
      prehashKey: HashOp.NO_HASH,
      length: LengthOp.VAR_PROTO,
    },
    innerSpec: {
      childOrder: [0, 1],
      minPrefixLength: 4,
      maxPrefixLength: 12,
      childSize: 33,
      hash: HashOp.SHA256,
    },
  };
  const tendermintSpec = {
    leafSpec: {
      prefix: Uint8Array.from([0]),
      hash: HashOp.SHA256,
      prehashValue: HashOp.SHA256,
      prehashKey: HashOp.NO_HASH,
      length: LengthOp.VAR_PROTO,
    },
    innerSpec: {
      childOrder: [0, 1],
      minPrefixLength: 1,
      maxPrefixLength: 1,
      childSize: 32,
      hash: HashOp.SHA256,
    },
  };

  return TendermintClientState.fromPartial({
    chainId,
    trustLevel: {
      numerator: 1n,
      denominator: 3n,
    },
    unbondingPeriod: {
      seconds: BigInt(unbondingPeriodSec),
    },
    trustingPeriod: {
      seconds: BigInt(trustPeriodSec),
    },
    maxClockDrift: {
      seconds: 20n,
    },
    latestHeight: height,
    proofSpecs: [iavlSpec, tendermintSpec],
    upgradePath: ["upgrade", "upgradedIBCState"],
    allowUpdateAfterExpiry: false,
    allowUpdateAfterMisbehaviour: false,
  });
}

export function parsePacketsFromBlockResult(
  result: tendermint34.BlockResultsResponse | tendermint37.BlockResultsResponse,
): Packet[] {
  return parsePacketsFromTendermintEvents([
    ...result.beginBlockEvents,
    ...result.endBlockEvents,
  ]);
}

export function parsePacketsFromBlockResultV2(
  result: tendermint34.BlockResultsResponse | tendermint37.BlockResultsResponse,
): PacketV2[] {
  return parsePacketsFromTendermintEventsV2([
    ...result.beginBlockEvents,
    ...result.endBlockEvents,
  ]);
}
/** Those events are normalized to strings already in CosmJS */
export function parsePacketsFromEvents(events: readonly Event[]): Packet[] {
  return events.filter(({ type }) => type === "send_packet").map(parsePacket);
}

export function parsePacketsFromEventsV2(events: readonly Event[]): PacketV2[] {
  return events.filter(({ type }) => type === "send_packet").map(parsePacketV2);
}
/**
 * Takes a list of events, finds the send_packet events, stringifies attributes
 * and parsed the events into `Packet`s.
 */
export function parsePacketsFromTendermintEvents(
  events: readonly (tendermint34.Event | tendermint37.Event)[],
): Packet[] {
  return parsePacketsFromEvents(events.map(fromTendermintEvent));
}
export function parsePacketsFromTendermintEventsV2(
  events: readonly (tendermint34.Event | tendermint37.Event)[],
): PacketV2[] {
  return parsePacketsFromEventsV2(events.map(fromTendermintEvent));
}
export  const isV2Packet = (packet: Packet | PacketV2): packet is PacketV2 =>{ 
  if ((packet as PacketV2).destinationClient) {
    return true;
  }else{
    return false;
  }
}
export function parseHeightAttribute(attribute?: string): Height | undefined {
  // Note: With cosmjs-types>=0.9.0, I believe this no longer needs to return undefined under any circumstances
  // but will need more extensive testing before refactoring.

  const [timeoutRevisionNumber, timeoutRevisionHeight] =
    attribute?.split("-") ?? [];
  if (!timeoutRevisionHeight || !timeoutRevisionNumber) {
    return undefined;
  }

  const revisionNumber = BigInt(
    isNaN(Number(timeoutRevisionNumber)) ? 0 : timeoutRevisionNumber,
  );
  const revisionHeight = BigInt(
    isNaN(Number(timeoutRevisionHeight)) ? 0 : timeoutRevisionHeight,
  );
  // note: 0 revisionNumber is allowed. If there is bad data, '' or '0-0', we will get 0 for the height
  if (revisionHeight == 0n) {
    return undefined;
  }
  return { revisionHeight, revisionNumber };
}

export function parsePacket({ type, attributes }: Event): Packet {
  if (type !== "send_packet") {
    throw new Error(`Cannot parse event of type ${type}`);
  }
  const attributesObj: Record<string, string> = attributes.reduce(
    (acc, { key, value }) => ({
      ...acc,
      [key]: value,
    }),
    {},
  );

  return Packet.fromPartial({
    sequence: may(BigInt, attributesObj.packet_sequence),
    /** identifies the port on the sending chain. */
    sourcePort: attributesObj.packet_src_port,
    /** identifies the channel end on the sending chain. */
    sourceChannel: attributesObj.packet_src_channel,
    /** identifies the port on the receiving chain. */
    destinationPort: attributesObj.packet_dst_port,
    /** identifies the channel end on the receiving chain. */
    destinationChannel: attributesObj.packet_dst_channel,
    /** actual opaque bytes transferred directly to the application module */
    data: attributesObj.packet_data_hex
      ? fromHex(attributesObj.packet_data_hex)
      : undefined,
    /** block height after which the packet times out */
    timeoutHeight: parseHeightAttribute(attributesObj.packet_timeout_height),
    /** block timestamp (in nanoseconds) after which the packet times out */
    timeoutTimestamp: may(BigInt, attributesObj.packet_timeout_timestamp),
  });
}

export function parsePacketV2({ type, attributes }: Event): PacketV2{
  if (type !== "send_packet") {
    throw new Error(`Cannot parse event of type ${type}`);
  }
  const attributesObj: Record<string, string> = attributes.reduce(
    (acc, { key, value }) => ({
      ...acc,
      [key]: value,
    }),
    {},
  );
  const data = fromHex(attributesObj.encoded_packet_hex);
  return PacketV2.decode(data);
}
export function parseAcksFromTxEvents(events: readonly Event[]): Ack[] {
  return events
    .filter(({ type }) => type === "write_acknowledgement")
    .map(parseAck);
}

export function parseAcksFromTxEventsV2(events: readonly Event[]): AckV2[] {
  return events
    .filter(({ type }) => type === "write_acknowledgement")
    .map(parseAckV2);
}
export function parseAck({ type, attributes }: Event): Ack {
  if (type !== "write_acknowledgement") {
    throw new Error(`Cannot parse event of type ${type}`);
  }
  const attributesObj: Record<string, string | undefined> = attributes.reduce(
    (acc, { key, value }) => ({
      ...acc,
      [key]: value,
    }),
    {},
  );
  const originalPacket = Packet.fromPartial({
    sequence: may(BigInt, attributesObj.packet_sequence),
    /** identifies the port on the sending chain. */
    sourcePort: attributesObj.packet_src_port,
    /** identifies the channel end on the sending chain. */
    sourceChannel: attributesObj.packet_src_channel,
    /** identifies the port on the receiving chain. */
    destinationPort: attributesObj.packet_dst_port,
    /** identifies the channel end on the receiving chain. */
    destinationChannel: attributesObj.packet_dst_channel,
    /** actual opaque bytes transferred directly to the application module */
    data: attributesObj.packet_data_hex ? fromHex(attributesObj.packet_data_hex) : undefined, 
    /** block height after which the packet times out */
    timeoutHeight: parseHeightAttribute(attributesObj.packet_timeout_height),
    /** block timestamp (in nanoseconds) after which the packet times out */
    timeoutTimestamp: may(BigInt, attributesObj.packet_timeout_timestamp),
  });
  const acknowledgement = fromHex(attributesObj.packet_ack_hex ?? "");
  return {
    acknowledgement,
    originalPacket,
  };
}

export function parseAckV2({ type, attributes }: Event): AckV2 {
  if (type !== "write_acknowledgement") {
    throw new Error(`Cannot parse event of type ${type}`);
  }
  const attributesObj: Record<string, string | undefined> = attributes.reduce(
    (acc, { key, value }) => ({
      ...acc,
      [key]: value,
    }),
    {},
  );
  if (!attributesObj.encoded_packet_hex) {
    throw new Error("Missing encoded_packet_hex in write_acknowledgement event");
  }
  const originalPacket = PacketV2.decode(fromHex(attributesObj.encoded_packet_hex));
  const acknowledgement = fromHex(attributesObj.packet_ack_hex ?? "");
  return {
    acknowledgement,
    originalPacket,
  };
}
// return true if a > b, or a undefined
export function heightGreater(a: Height | undefined, b: Height): boolean {
  if (
    a === undefined ||
    (a.revisionHeight === BigInt(0) && a.revisionNumber === BigInt(0))
  ) {
    return true;
  }
  // comparing longs made some weird issues (maybe signed/unsigned)?
  // convert to numbers to compare safely
  const [numA, heightA, numB, heightB] = [
    Number(a.revisionNumber),
    Number(a.revisionHeight),
    Number(b.revisionNumber),
    Number(b.revisionHeight),
  ];
  const valid = numA > numB || (numA == numB && heightA > heightB);
  return valid;
}

// return true if a > b, or a 0
// note a is nanoseconds, while b is seconds
export function timeGreater(a: bigint | undefined, b: number): boolean {
  if (a === undefined || a == 0n) {
    return true;
  }
  const valid = Number(a) > b * 1_000_000_000;
  return valid;
}

// in IBC v2 both a and b are in seconds
export function timeGreaterV2(a: bigint | undefined, b: number): boolean {
  if (a === undefined || a == 0n) {
    return true;
  }
  const valid = Number(a) > b ;
  return valid;
}
export function mergeUint8Arrays(...arrays: Uint8Array[]): Uint8Array {
  const totalSize = arrays.reduce((acc, e) => acc + e.length, 0);
  const merged = new Uint8Array(totalSize);

  arrays.forEach((array, i, arrays) => {
    const offset = arrays.slice(0, i).reduce((acc, e) => acc + e.length, 0);
    merged.set(array, offset);
  });

  return merged;
}

// take height and time from receiving chain to see which packets have timed out
// return [toSubmit, toTimeout].
// you can advance height, time a block or two into the future if you wish a margin of error
export function splitPendingPackets<T extends (PacketWithMetadata | PacketV2WithMetadata)> (
  currentHeight: Height,
  currentTime: number, // in seconds
  packets: readonly T[],
): {
  readonly toSubmit: readonly T[];
  readonly toTimeout: readonly T[];
} {
  return packets.reduce(
    (acc, packet) => {
      if (isV2Packet(packet.packet)) {
        // no timeout height, so we can submit it
        console.log(packet.packet.timeoutTimestamp, currentTime);
      const validPacket =
        timeGreaterV2(packet.packet.timeoutTimestamp, currentTime);
      return validPacket
        ? {
            ...acc,
            toSubmit: [...acc.toSubmit, packet],
          }
        : {
            ...acc,
            toTimeout: [...acc.toTimeout, packet],
          };
      }else{

        const validPacket =
          heightGreater(packet.packet.timeoutHeight, currentHeight) &&
          timeGreater(packet.packet.timeoutTimestamp, currentTime);
        return validPacket
          ? {
              ...acc,
              toSubmit: [...acc.toSubmit, packet],
            }
          : {
              ...acc,
              toTimeout: [...acc.toTimeout, packet],
            };
      }
    },
    {
      toSubmit: [] as readonly T[],
      toTimeout: [] as readonly T[],
    },
  );
}

export function presentPacketData(data: Uint8Array): Record<string, unknown> {
  try {
    return JSON.parse(fromUtf8(data));
  } catch {
    return { hex: toHex(data) };
  }
}

export function presentPacketDataV2(data: Uint8Array): Record<string, unknown> {
  try {
    return JSON.parse(fromUtf8(data));
  } catch {
    return { hex: toHex(data) };
  }
}
export async function prepareConnectionHandshake(
  src: BaseIbcClient,
  dest: BaseIbcClient,
  clientIdSrc: string,
  clientIdDest: string,
  connIdSrc: string,
): Promise<ConnectionHandshakeProof> {
  // ensure the last transaction was committed to the header (one block after it was included)
  await src.waitOneBlock();
  // update client on dest
  const headerHeight = await dest.updateClient(clientIdDest, src);

  // get a proof (for the proven height)
  const proof = await src.getConnectionHandshakeProof(
    clientIdSrc,
    connIdSrc,
    headerHeight,
  );
  return proof;
}

export async function prepareChannelHandshake(
  src: BaseIbcClient,
  dest: BaseIbcClient,
  clientIdDest: string,
  portId: string,
  channelId: string,
): Promise<ChannelHandshakeProof> {
  // ensure the last transaction was committed to the header (one block after it was included)
  await src.waitOneBlock();
  // update client on dest
  const headerHeight = await dest.updateClient(clientIdDest, src);
  // get a proof (for the proven height)
  const proof = await src.getChannelHandshakeProof( portId, channelId , headerHeight);
  return proof;
}

export function checkAndParseOp(op: tendermint34.ProofOp, kind: string, key: Uint8Array): CommitmentProof {
  if (op.type !== kind) {
    throw new Error(`Op expected to be ${kind}, got "${op.type}`);
  }
  if (!arrayContentEquals(key, op.key)) {
    throw new Error(`Proven key different than queried key.\nQuery: ${toHex(key)}\nProven: ${toHex(op.key)}`);
  }
  return CommitmentProof.decode(op.data);
}

export function convertProofsToIcs23(ops: ProofOps): Uint8Array {
  const proofs = ops.ops.map((op) => CommitmentProof.decode(op.data));
  const resp = MerkleProof.fromPartial({
    proofs,
  });
  return MerkleProof.encode(resp).finish();
}
export function decodeClientState(
  clientState: Any,
) {
  switch (clientState?.typeUrl) {
    case "/ibc.lightclients.tendermint.v1.ClientState":
      return TendermintClientState.decode(clientState.value);
    case "/ibc.lightclients.solomachine.v2.ClientState":
      return SolomachineV2ClientState.decode(clientState.value);
    case "/ibc.lightclients.solomachine.v3.ClientState":
      return SolomachineV3ClientState.decode(clientState.value);
    case "/ibc.lightclients.wasm.v1.ClientState":
      return WasmClientState.decode(clientState.value);
    default:
      throw new Error(`Unexpected client state type: ${clientState?.typeUrl}`);
  }
}

export function decodeConsensusState(
  consensusState: Any | undefined,
) {
  switch (consensusState?.typeUrl) {
    case "/ibc.lightclients.tendermint.v1.ConsensusState":
      return TendermintConsensusState.decode(consensusState.value);
    case "/ibc.lightclients.solomachine.v2.ConsensusState":
      return SolomachineV2ConsensusState.decode(consensusState.value);
    case "/ibc.lightclients.solomachine.v3.ConsensusState":
      return SolomachineV3ConsensusState.decode(consensusState.value);
    case "/ibc.lightclients.wasm.v1.ConsensusState":
      return WasmConsensusState.decode(consensusState.value);
    default:
      throw new Error(`Unexpected consensus state type: ${consensusState?.typeUrl}`);
  }
}