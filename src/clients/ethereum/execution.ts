/**
 * Execution-layer access for the source side: block headers in RLP (the
 * gno-side client reads a Gloas update's state root from one) and storage
 * proofs of the router's commitments.
 */
import {
  bytesToHex, concat, Hex, hexToBytes, keccak256, pad, toHex, toRlp,
} from "viem";

import type {
  EthereumPublicClient,
} from "./IbcClient.js";
import {
  IBC_STORE_COMMITMENT_SLOT,
} from "./sourceAbi.js";
import {
  StorageProof,
} from "./wire.js";

/**
 * Execution header fields in RLP order, and whether each is a number. Each
 * fork appends fields; the first one a node does not report ends the header.
 */
const HEADER_FIELDS: [string, boolean][] = [["parentHash", false], ["sha3Uncles", false], ["miner", false], ["stateRoot", false], ["transactionsRoot", false], ["receiptsRoot", false], ["logsBloom", false], ["difficulty", true], ["number", true], ["gasLimit", true], ["gasUsed", true], ["timestamp", true], ["extraData", false], ["mixHash", false], ["nonce", false], ["baseFeePerGas", true], ["withdrawalsRoot", false], ["blobGasUsed", true], ["excessBlobGas", true], ["parentBeaconBlockRoot", false], ["requestsHash", false], ["blockAccessListHash", false], ["slotNumber", true]];

/** Minimal big-endian bytes of a hex quantity, as RLP encodes integers. */
function quantity(v: string): Hex {
  const n = BigInt(v);
  return n === 0n ? "0x" : toHex(n);
}

export interface ExecutionHeader {
  rlp: Uint8Array
  number: bigint
  timestamp: bigint
  stateRoot: Uint8Array
}

/** The execution block header with the given hash, its RLP checked against the hash. */
export async function executionHeader(client: EthereumPublicClient, blockHash: string): Promise<ExecutionHeader> {
  const block = await client.request({
    method: "eth_getBlockByHash",
    params: [blockHash as Hex, false],
  }) as unknown as Record<string, string> | null;
  if (!block) {
    throw new Error(`execution block ${blockHash} not found`);
  }
  const items: Hex[] = [];
  for (const [name, isNumber] of HEADER_FIELDS) {
    const v = block[name];
    if (typeof v !== "string") {
      break;
    }
    items.push(isNumber ? quantity(v) : v as Hex);
  }
  const rlp = toRlp(items, "bytes");
  if (keccak256(rlp).toLowerCase() !== blockHash.toLowerCase()) {
    throw new Error(`execution header ${blockHash} does not re-encode to its hash: unknown header fields?`);
  }
  return {
    rlp,
    number: BigInt(block.number),
    timestamp: BigInt(block.timestamp),
    stateRoot: hexToBytes(block.stateRoot as Hex),
  };
}

/** The router's storage slot of commitments[keccak256(path)]. */
export function commitmentSlot(path: Uint8Array): Hex {
  return keccak256(concat([keccak256(path), IBC_STORE_COMMITMENT_SLOT]));
}

/** Proves storage slot of address at block. */
export async function storageProof(client: EthereumPublicClient, address: Hex, slot: Hex, block: bigint): Promise<StorageProof> {
  const res = await client.getProof({
    address,
    storageKeys: [slot],
    blockNumber: block,
  });
  const sp = res.storageProof[0];
  return {
    accountProof: res.accountProof.map(p => hexToBytes(p)),
    storageProof: sp.proof.map(p => hexToBytes(p)),
    value: hexToBytes(pad(toHex(sp.value), {
      size: 32,
    })),
  };
}

/** The ICS24 path of a packet commitment (1), receipt (2) or acknowledgement (3). */
export function packetPath(clientId: string, kind: 1 | 2 | 3, sequence: bigint): Uint8Array {
  const id = new TextEncoder().encode(clientId);
  const out = new Uint8Array(id.length + 9);
  out.set(id);
  out[id.length] = kind;
  new DataView(out.buffer).setBigUint64(id.length + 1, sequence);
  return out;
}

export const toHexString = bytesToHex;
