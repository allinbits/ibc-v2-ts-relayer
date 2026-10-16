/**
 * Encodings for gno.land/r/aib/ibc/ethrelay: the positional wire format of
 * gno.land/p/aib/encoding/wire/v0, and the SSZ trees the gno-side Ethereum client
 * checks non-signers against. Mirrors gno-eth-ibc relayer/ethgno (Go).
 */
import {
  hexToBytes, sha256,
} from "viem";

import {
  headerBlockHash, LightClientHeader, LightClientUpdate, SyncCommittee,
} from "./beacon.js";

/** Writes wire values: Uint as 8 bytes big-endian, Uvarint LEB128, blobs length-prefixed. */
export class WireWriter {
  private readonly chunks: Uint8Array[] = [];

  public uint(v: bigint | number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v));
    this.chunks.push(b);
    return this;
  }

  public uvarint(v: bigint | number): this {
    let x = BigInt(v);
    const out: number[] = [];
    while (x >= 0x80n) {
      out.push(Number(x & 0x7fn) | 0x80);
      x >>= 7n;
    }
    out.push(Number(x));
    this.chunks.push(Uint8Array.from(out));
    return this;
  }

  public byte(b: number): this {
    this.chunks.push(Uint8Array.of(b));
    return this;
  }

  public bool(v: boolean): this {
    return this.byte(v ? 1 : 0);
  }

  public blob(b: Uint8Array): this {
    this.uvarint(b.length);
    this.chunks.push(b);
    return this;
  }

  public str(s: string): this {
    return this.blob(new TextEncoder().encode(s));
  }

  public blobs(bs: readonly Uint8Array[]): this {
    this.uvarint(bs.length);
    bs.forEach(b => this.blob(b));
    return this;
  }

  public bytes(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

export const hex = (s: string): Uint8Array => hexToBytes(s.startsWith("0x") ? s as `0x${string}` : `0x${s}`);

const hexes = (ss: readonly string[]): Uint8Array[] => ss.map(hex);

function hash2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const buf = new Uint8Array(a.length + b.length);
  buf.set(a);
  buf.set(b, a.length);
  return sha256(buf, "bytes");
}

/** The SSZ tree of a sync committee's pubkeys vector, leaves first. */
export function pubkeysTree(pubkeys: readonly Uint8Array[]): Uint8Array[][] {
  let layer = pubkeys.map((pk) => {
    const chunk = new Uint8Array(32);
    chunk.set(pk.subarray(32));
    return hash2(pk.subarray(0, 32), chunk);
  });
  const layers = [layer];
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(hash2(layer[i], layer[i + 1]));
    }
    layers.push(next);
    layer = next;
  }
  return layers;
}

/** A committee's summary: the root of its pubkeys and its aggregate key. */
export function summarize(c: SyncCommittee): {
  pubkeysHash: Uint8Array
  aggregatePubkey: Uint8Array
} {
  const layers = pubkeysTree(hexes(c.pubkeys));
  return {
    pubkeysHash: layers[layers.length - 1][0],
    aggregatePubkey: hex(c.aggregate_pubkey),
  };
}

/** The members of committee whose participation bit is unset, with their branches. */
export function nonSigners(committee: SyncCommittee, bitsHex: string): {
  pubkey: Uint8Array
  branch: Uint8Array[]
}[] {
  const bits = hex(bitsHex);
  const keys = hexes(committee.pubkeys);
  const layers = pubkeysTree(keys);
  const out: {
    pubkey: Uint8Array
    branch: Uint8Array[]
  }[] = [];
  keys.forEach((pubkey, i) => {
    if ((bits[i >> 3] & (1 << (i & 7))) !== 0) {
      return;
    }
    const branch: Uint8Array[] = [];
    let idx = i;
    for (const layer of layers.slice(0, -1)) {
      branch.push(layer[idx ^ 1]);
      idx >>= 1;
    }
    out.push({
      pubkey,
      branch,
    });
  });
  return out;
}

/** Minimal big-endian bytes of a decimal string. */
function decimalBytes(s: string): Uint8Array {
  let v = BigInt(s);
  const out: number[] = [];
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return Uint8Array.from(out);
}

function writeLcHeader(w: WireWriter, h: LightClientHeader): void {
  const b = h.beacon;
  w.uint(BigInt(b.slot)).uint(BigInt(b.proposer_index))
    .blob(hex(b.parent_root)).blob(hex(b.state_root)).blob(hex(b.body_root));
  const e = h.execution;
  if (e) {
    w.byte(0)
      .blob(hex(e.parent_hash)).blob(hex(e.fee_recipient)).blob(hex(e.state_root))
      .blob(hex(e.receipts_root)).blob(hex(e.logs_bloom)).blob(hex(e.prev_randao))
      .uint(BigInt(e.block_number)).uint(BigInt(e.gas_limit)).uint(BigInt(e.gas_used)).uint(BigInt(e.timestamp))
      .blob(hex(e.extra_data)).blob(decimalBytes(e.base_fee_per_gas)).blob(hex(e.block_hash))
      .blob(hex(e.transactions_root)).blob(hex(e.withdrawals_root))
      .uint(BigInt(e.blob_gas_used)).uint(BigInt(e.excess_blob_gas));
  }
  else {
    w.byte(1).blob(hex(headerBlockHash(h)));
  }
  w.blobs(hexes(h.execution_branch));
}

/**
 * Encodes an ethereum.Header for ethrelay.UpdateClient: u on top of the
 * consensus state at trustedSlot, signed by active (the trusted state's
 * current committee, or its next one if isNext). finalizedExecHeader is the
 * RLP execution header of u's finalized header, required from Gloas on.
 */
export function encodeHeader(
  u: LightClientUpdate,
  active: SyncCommittee,
  isNext: boolean,
  trustedSlot: bigint,
  finalizedExecHeader: Uint8Array | undefined,
): Uint8Array {
  const w = new WireWriter();
  w.uint(trustedSlot).bool(isNext);
  writeLcHeader(w, u.attested_header);
  w.bool(u.next_sync_committee !== undefined);
  if (u.next_sync_committee) {
    const s = summarize(u.next_sync_committee);
    w.blob(s.pubkeysHash).blob(s.aggregatePubkey).blobs(hexes(u.next_sync_committee_branch ?? []));
  }
  writeLcHeader(w, u.finalized_header);
  w.blobs(hexes(u.finality_branch));
  w.blob(hex(u.sync_aggregate.sync_committee_bits)).blob(hex(u.sync_aggregate.sync_committee_signature));
  w.uint(BigInt(u.signature_slot));
  w.blob(finalizedExecHeader ?? new Uint8Array());
  const ns = nonSigners(active, u.sync_aggregate.sync_committee_bits);
  w.uvarint(ns.length);
  ns.forEach(n => w.blob(n.pubkey).blobs(n.branch));
  return w.bytes();
}

/** An eth_getProof answer for one account and one storage slot. */
export interface StorageProof {
  accountProof: Uint8Array[]
  storageProof: Uint8Array[]
  value: Uint8Array
}

/** Encodes an ethereum.MembershipProof. */
export function encodeMembershipProof(p: StorageProof): Uint8Array {
  return new WireWriter().blobs(p.accountProof).blobs(p.storageProof).bytes();
}

/** A packet as ethrelay decodes it. */
export interface WirePacket {
  sequence: bigint
  sourceClient: string
  destinationClient: string
  timeoutTimestamp: bigint
  payloads: {
    sourcePort: string
    destinationPort: string
    version: string
    encoding: string
    value: Uint8Array
  }[]
}

/**
 * Encodes the message of ethrelay.RecvPacket, Acknowledgement (when acks is
 * set) or Timeout; proof is a wire-encoded MembershipProof.
 */
export function encodePacketMsg(p: WirePacket, proofSlot: bigint, acks: readonly Uint8Array[] | undefined, proof: Uint8Array): Uint8Array {
  const w = new WireWriter();
  w.uint(p.sequence).str(p.sourceClient).str(p.destinationClient).uint(p.timeoutTimestamp);
  w.uvarint(p.payloads.length);
  p.payloads.forEach(pl => w.str(pl.sourcePort).str(pl.destinationPort).str(pl.version).str(pl.encoding).blob(pl.value));
  w.uint(0).uint(proofSlot);
  if (acks) {
    w.blobs(acks);
  }
  w.blob(proof);
  return w.bytes();
}
