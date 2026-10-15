/**
 * Encoders for GnoLightClient (github.com/gnolang/gno-eth-ibc), the gno.land
 * light client on Ethereum: a port of that repository's Go package
 * relayer/gnoibc. It turns the ibc.lightclients.gno.v1 header the gno client
 * builds from RPC, and the ICS23 proofs of its store, into the ABI messages
 * the contract reads. gnoibc.test.ts checks every byte against the Go
 * encoder's output (testdata/gnoibc-vectors.json).
 */
import {
  CommitmentProof, ExistenceProof, HashOp, LengthOp,
} from "@atomone/atomone-types/cosmos/ics23/v1/proofs.js";
import {
  MerkleProof,
} from "@atomone/atomone-types/ibc/core/commitment/v1/commitment.js";
import {
  Secp256k1, sha256,
} from "@cosmjs/crypto";
import {
  ibc,
} from "@gnolang/gno-types";
import {
  encodeAbiParameters, Hex, keccak256, recoverAddress, toHex,
} from "viem";

type GnoHeader = ibc.lightclients.gno.v1.gno.GnoHeader;
type GnoCommit = ibc.lightclients.gno.v1.gno.Commit;
type GnoValidatorSet = ibc.lightclients.gno.v1.gno.ValidatorSet;
type GnoBlockID = ibc.lightclients.gno.v1.gno.BlockID;

// ------------------------------------------------------------------ bytes

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  const x = a ?? new Uint8Array();
  const y = b ?? new Uint8Array();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hex(b: Uint8Array | undefined): Hex {
  return toHex(b ?? new Uint8Array());
}

function bytes32(b: Uint8Array | undefined, what: string): Hex {
  if (!b || b.length !== 32) {
    throw new Error(`${what} must be 32 bytes, got ${b?.length ?? 0}`);
  }
  return toHex(b);
}

// ------------------------------------------------------------------ amino

/** Unsigned LEB128 varint. */
export function uvarint(v: bigint): Uint8Array {
  if (v < 0n) {
    throw new Error("uvarint of a negative number");
  }
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

/** amino's encoding of int64 and int: zigzag varint. */
export function zigzag(v: bigint): Uint8Array {
  return uvarint(v >= 0n ? v << 1n : ((-v) << 1n) - 1n);
}

function field(tag: number, payload: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), payload);
}

function lenField(tag: number, payload: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), uvarint(BigInt(payload.length)), payload);
}

/** google.protobuf.Timestamp-shaped body; zero fields omitted. */
function timestampBody(seconds: bigint, nanos: number): Uint8Array {
  return concatBytes(
    seconds !== 0n ? field(0x08, uvarint(seconds)) : new Uint8Array(),
    nanos !== 0 ? field(0x10, uvarint(BigInt(nanos))) : new Uint8Array(),
  );
}

function stringLeaf(s: string | undefined): Uint8Array {
  return s ? lenField(0x0a, utf8(s)) : new Uint8Array();
}

function bytesLeaf(b: Uint8Array | undefined): Uint8Array {
  return b && b.length ? lenField(0x0a, b) : new Uint8Array();
}

function int64Leaf(v: bigint | undefined): Uint8Array {
  return v ? field(0x08, zigzag(v)) : new Uint8Array();
}

/** amino of tm2 BlockID {Hash []byte; PartsHeader {Total int; Hash []byte}}, empty fields omitted. */
function blockIdLeaf(b: GnoBlockID | undefined): Uint8Array {
  if (!b) {
    return new Uint8Array();
  }
  const total = b.partsHeader?.total ?? 0n;
  const psh = concatBytes(
    total !== 0n ? field(0x08, zigzag(total)) : new Uint8Array(),
    b.partsHeader?.hash?.length ? lenField(0x12, b.partsHeader.hash) : new Uint8Array(),
  );
  return concatBytes(
    b.hash?.length ? lenField(0x0a, b.hash) : new Uint8Array(),
    psh.length ? lenField(0x12, psh) : new Uint8Array(),
  );
}

/**
 * The 16 leaves of tm2 Header.Hash (tm2/pkg/bft/types/block.go): each field's
 * amino encoding, empty when the field is empty (encoding_helper.go
 * bytesOrNil).
 */
export function headerLeaves(h: GnoHeader): Uint8Array[] {
  return [stringLeaf(h.version), stringLeaf(h.chainId), int64Leaf(h.height), h.time ? timestampBody(h.time.seconds, h.time.nanos) : new Uint8Array(), int64Leaf(h.numTxs), int64Leaf(h.totalTxs), stringLeaf(h.appVersion), blockIdLeaf(h.lastBlockId), bytesLeaf(h.lastCommitHash), bytesLeaf(h.dataHash), bytesLeaf(h.validatorsHash), bytesLeaf(h.nextValidatorsHash), bytesLeaf(h.consensusHash), bytesLeaf(h.appHash), bytesLeaf(h.lastResultsHash), stringLeaf(h.proposerAddress)];
}

// ------------------------------------------------------------------ simple merkle

export function leafHash(leaf: Uint8Array): Uint8Array {
  return sha256(concatBytes(Uint8Array.of(0), leaf));
}

export function innerHash(l: Uint8Array, r: Uint8Array): Uint8Array {
  return sha256(concatBytes(Uint8Array.of(1), l, r));
}

/** tm2 merkle.SimpleHashFromByteSlices over already hashed leaves. */
export function rootFromLeafHashes(h: Uint8Array[]): Uint8Array {
  if (h.length === 0) {
    throw new Error("empty merkle tree");
  }
  if (h.length === 1) {
    return h[0];
  }
  let k = 1;
  while (k * 2 < h.length) {
    k *= 2;
  }
  return innerHash(rootFromLeafHashes(h.slice(0, k)), rootFromLeafHashes(h.slice(k)));
}

// ------------------------------------------------------------------ validators

export interface Validator {
  /** 33-byte compressed secp256k1 key. */
  compressed: Uint8Array
  /** 64-byte uncompressed key without the 0x04 tag, as GnoLightClient takes it. */
  uncompressed: Uint8Array
  ethAddress: `0x${string}`
  votingPower: bigint
}

/**
 * The validators of a gno ValidatorSet. The key is a 33-byte compressed
 * secp256k1 key; the TS gno client currently carries it in the ed25519 field
 * of tendermint.crypto.PublicKey, so both fields are accepted.
 */
export function toValidators(set: GnoValidatorSet | undefined): Validator[] {
  return (set?.validators ?? []).map((v, i) => {
    const key = v.pubKey?.secp256k1?.length ? v.pubKey.secp256k1 : v.pubKey?.ed25519;
    if (!key || key.length !== 33) {
      throw new Error(`validator ${i} (${v.address}): only 33-byte secp256k1 keys are supported`);
    }
    if (v.votingPower <= 0n) {
      throw new Error(`validator ${i} (${v.address}): non-positive voting power`);
    }
    const full = Secp256k1.uncompressPubkey(key).slice(1);
    return {
      compressed: key,
      uncompressed: full,
      ethAddress: `0x${keccak256(full).slice(26)}`,
      votingPower: v.votingPower,
    };
  });
}

const PUBKEY_TYPE_URL = utf8("/tm.PubKeySecp256k1");

/** tm2 Validator.Bytes (validator.go). */
export function validatorLeaf(v: Validator): Uint8Array {
  const any = concatBytes(lenField(0x0a, PUBKEY_TYPE_URL), lenField(0x12, lenField(0x0a, v.compressed)));
  return concatBytes(lenField(0x0a, any), field(0x10, zigzag(v.votingPower)));
}

/** tm2 ValidatorSet.Hash. */
export function validatorSetHash(vals: Validator[]): Uint8Array {
  return rootFromLeafHashes(vals.map(v => leafHash(validatorLeaf(v))));
}

function totalPower(vals: Validator[]): bigint {
  return vals.reduce((t, v) => t + v.votingPower, 0n);
}

// ------------------------------------------------------------------ votes

function le64(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

/** amino.MarshalSized(CanonicalVote) of a precommit (tm2/pkg/bft/types/canonical.go). */
export function voteSignBytes(
  chainId: string, height: bigint, round: bigint, blockId: GnoBlockID, seconds: bigint, nanos: number,
): Uint8Array {
  const total = blockId.partsHeader?.total ?? 0n;
  const psh = concatBytes(
    total !== 0n ? field(0x08, uvarint(total)) : new Uint8Array(),
    blockId.partsHeader?.hash?.length ? lenField(0x12, blockId.partsHeader.hash) : new Uint8Array(),
  );
  const bid = concatBytes(
    blockId.hash?.length ? lenField(0x0a, blockId.hash) : new Uint8Array(),
    psh.length ? lenField(0x12, psh) : new Uint8Array(),
  );
  const ts = timestampBody(seconds, nanos);
  const body = concatBytes(
    Uint8Array.of(0x08, 0x02),
    field(0x11, le64(height)),
    round !== 0n ? field(0x19, le64(round)) : new Uint8Array(),
    bid.length ? lenField(0x22, bid) : new Uint8Array(),
    ts.length ? lenField(0x2a, ts) : new Uint8Array(),
    chainId ? lenField(0x32, utf8(chainId)) : new Uint8Array(),
  );
  return concatBytes(uvarint(BigInt(body.length)), body);
}

// ------------------------------------------------------------------ header

export interface HeaderFields {
  height: bigint
  timeSeconds: bigint
  timeNanos: number
  validatorsHash: Hex
  nextValidatorsHash: Hex
  appHash: Hex
  versionLeafHash: Hex
  txsAndLastBlockIDHash: Hex
  lastCommitAndDataHash: Hex
  consensusLeafHash: Hex
  resultsAndProposerHash: Hex
}

/**
 * The header fields GnoLightClient reads and the five sibling hashes it cannot
 * rebuild, checked to reproduce the block hash the commit signs.
 */
export function encodeHeaderFields(h: GnoHeader, blockHash: Uint8Array): HeaderFields {
  if (!h.time || h.height <= 0n || h.time.seconds <= 0n) {
    throw new Error("header height and time must be positive");
  }
  const lh = headerLeaves(h).map(leafHash);
  const f: HeaderFields = {
    height: h.height,
    timeSeconds: h.time.seconds,
    timeNanos: h.time.nanos,
    validatorsHash: bytes32(h.validatorsHash, "validators hash"),
    nextValidatorsHash: bytes32(h.nextValidatorsHash, "next validators hash"),
    appHash: bytes32(h.appHash, "app hash"),
    versionLeafHash: toHex(lh[0]),
    txsAndLastBlockIDHash: toHex(innerHash(innerHash(lh[4], lh[5]), innerHash(lh[6], lh[7]))),
    lastCommitAndDataHash: toHex(innerHash(lh[8], lh[9])),
    consensusLeafHash: toHex(lh[12]),
    resultsAndProposerHash: toHex(innerHash(lh[14], lh[15])),
  };
  const root = rootFromLeafHashes(lh);
  if (!bytesEqual(root, blockHash)) {
    throw new Error(`header hash ${toHex(root)} does not match the committed block hash ${toHex(blockHash)}`);
  }
  return f;
}

// ------------------------------------------------------------------ commit

export const NO_TRUSTED_INDEX = 0xffff;
export const SIG_SIZE = 81;

function sameBlockId(a: GnoBlockID | undefined, b: GnoBlockID | undefined): boolean {
  return bytesEqual(a?.hash, b?.hash)
    && (a?.partsHeader?.total ?? 0n) === (b?.partsHeader?.total ?? 0n)
    && bytesEqual(a?.partsHeader?.hash, b?.partsHeader?.hash);
}

function indexByKey(vals: Validator[], key: Uint8Array): number {
  return vals.findIndex(v => bytesEqual(v.compressed, key));
}

/**
 * The precommits to send, ascending: all for the committed BlockID, or the
 * fewest that clear the thresholds — by trusted power until more than
 * num/den of the trusted set's power (when trusted is given), then by power
 * until more than 2/3 of the set's power (tm2's integer thresholds). Port of
 * gnoibc.SelectSigners.
 */
export function selectSigners(
  commit: GnoCommit, vals: Validator[], trusted: Validator[] | undefined, num: bigint, den: bigint, all: boolean,
): number[] {
  const cands: number[] = [];
  commit.precommits.forEach((pc, idx) => {
    if (pc?.signature?.length && sameBlockId(pc.blockId, commit.blockId) && idx < vals.length) {
      cands.push(idx);
    }
  });
  if (all) {
    return cands;
  }
  const chosen = new Set<number>();
  let tallied = 0n;
  let trustTallied = 0n;
  const trustedPower = (idx: number): bigint => {
    if (!trusted) {
      return 0n;
    }
    const ti = indexByKey(trusted, vals[idx].compressed);
    return ti < 0 ? 0n : trusted[ti].votingPower;
  };
  const add = (idx: number) => {
    chosen.add(idx);
    tallied += vals[idx].votingPower;
    trustTallied += trustedPower(idx);
  };
  const byDesc = (key: (i: number) => bigint) => [...cands].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka > kb ? -1 : ka < kb ? 1 : 0;
  });
  if (trusted) {
    const need = totalPower(trusted) * num / den;
    for (const idx of byDesc(trustedPower)) {
      if (trustTallied > need) {
        break;
      }
      if (trustedPower(idx) > 0n) {
        add(idx);
      }
    }
    if (trustTallied <= need) {
      throw new Error(`trusted signers hold ${trustTallied}, need more than ${need}`);
    }
  }
  const need = totalPower(vals) * 2n / 3n;
  for (const idx of byDesc(i => vals[i].votingPower)) {
    if (tallied > need) {
      break;
    }
    if (!chosen.has(idx)) {
      add(idx);
    }
  }
  if (tallied <= need) {
    throw new Error(`signers hold ${tallied}, need more than ${need}`);
  }
  return [...chosen].sort((a, b) => a - b);
}

export interface EncodedCommit {
  round: number
  partSetTotal: number
  partSetHash: Hex
  signatures: Hex
}

/** Packs the chosen precommits (81 bytes each); finds each recovery id by trial. Port of gnoibc.EncodeCommit. */
export async function encodeCommit(
  chainId: string, height: bigint, commit: GnoCommit, vals: Validator[], trusted: Validator[] | undefined, signers: number[],
): Promise<EncodedCommit> {
  if (vals.length >= NO_TRUSTED_INDEX) {
    throw new Error("validator set too large");
  }
  const first = commit.precommits.find(pc => pc?.signature?.length);
  const round = first?.round ?? 0n;
  const blockId = commit.blockId;
  const out: Uint8Array[] = [];
  for (const idx of signers) {
    const pc = commit.precommits[idx];
    if (!pc?.signature?.length || pc.signature.length !== 64 || !pc.timestamp) {
      throw new Error(`no 64-byte precommit at ${idx}`);
    }
    const digest = sha256(voteSignBytes(chainId, height, round, pc.blockId, pc.timestamp.seconds, pc.timestamp.nanos));
    const v = await recoveryId(digest, pc.signature, vals[idx].ethAddress);
    const rec = new Uint8Array(SIG_SIZE);
    const dv = new DataView(rec.buffer);
    dv.setUint16(0, idx);
    dv.setUint16(2, trusted
      ? (() => {
        const ti = indexByKey(trusted, vals[idx].compressed);
        return ti < 0 ? NO_TRUSTED_INDEX : ti;
      })()
      : NO_TRUSTED_INDEX);
    dv.setBigUint64(4, pc.timestamp.seconds);
    dv.setUint32(12, pc.timestamp.nanos);
    rec.set(pc.signature, 16);
    rec[80] = v;
    out.push(rec);
  }
  return {
    round: Number(round),
    partSetTotal: Number(blockId?.partsHeader?.total ?? 0n),
    partSetHash: bytes32(blockId?.partsHeader?.hash, "part set hash"),
    signatures: toHex(concatBytes(...out)),
  };
}

/** v in {27, 28} such that ecrecover(digest, v, r, s) is the validator. */
export async function recoveryId(digest: Uint8Array, sig: Uint8Array, want: `0x${string}`): Promise<number> {
  for (const v of [27, 28]) {
    try {
      const addr = await recoverAddress({
        hash: toHex(digest),
        signature: toHex(concatBytes(sig, Uint8Array.of(v))),
      });
      if (addr.toLowerCase() === want.toLowerCase()) {
        return v;
      }
    }
    catch {
      // not this recovery id
    }
  }
  throw new Error(`signature does not recover to validator ${want}`);
}

// ------------------------------------------------------------------ the update message

export interface HeaderOptions {
  /** Height of the client's consensus state the update verifies from. */
  trustedHeight: bigint
  /**
   * The next validator set of the trusted height. When the update is
   * non-adjacent and the header's set differs, the client checks the trust
   * level over it and the signers are chosen to meet it. Undefined: the
   * header's set is the trusted set.
   */
  trustedValidators?: GnoValidatorSet
  /** The header's set is cached on the client (isValidatorSetCached). */
  omitValidators?: boolean
  /** The trusted set is cached on the client. */
  omitTrusted?: boolean
  /** Send every precommit instead of the fewest that clear the thresholds. */
  allSignatures?: boolean
  trustNumerator?: bigint
  trustDenominator?: bigint
}

const VALIDATOR = {
  type: "tuple[]",
  components: [
    {
      name: "pubKey",
      type: "bytes",
    },
    {
      name: "votingPower",
      type: "uint64",
    },
  ],
} as const;

const HEADER_PARAMS = [
  {
    name: "header",
    type: "tuple",
    components: [
      {
        name: "signedHeader",
        type: "tuple",
        components: [
          {
            name: "height",
            type: "uint64",
          },
          {
            name: "timeSeconds",
            type: "uint64",
          },
          {
            name: "timeNanos",
            type: "uint32",
          },
          {
            name: "validatorsHash",
            type: "bytes32",
          },
          {
            name: "nextValidatorsHash",
            type: "bytes32",
          },
          {
            name: "appHash",
            type: "bytes32",
          },
          {
            name: "versionLeafHash",
            type: "bytes32",
          },
          {
            name: "txsAndLastBlockIDHash",
            type: "bytes32",
          },
          {
            name: "lastCommitAndDataHash",
            type: "bytes32",
          },
          {
            name: "consensusLeafHash",
            type: "bytes32",
          },
          {
            name: "resultsAndProposerHash",
            type: "bytes32",
          },
        ],
      },
      {
        name: "commit",
        type: "tuple",
        components: [
          {
            name: "round",
            type: "uint32",
          },
          {
            name: "partSetTotal",
            type: "uint32",
          },
          {
            name: "partSetHash",
            type: "bytes32",
          },
          {
            name: "signatures",
            type: "bytes",
          },
        ],
      },
      {
        name: "validatorSet",
        ...VALIDATOR,
      },
      {
        name: "trustedHeight",
        type: "uint64",
      },
      {
        name: "trustedValidators",
        ...VALIDATOR,
      },
    ],
  },
] as const;

export interface HeaderStruct {
  signedHeader: HeaderFields
  commit: EncodedCommit
  validatorSet: {
    pubKey: Hex
    votingPower: bigint
  }[]
  trustedHeight: bigint
  trustedValidators: {
    pubKey: Hex
    votingPower: bigint
  }[]
}

export interface EncodedHeader {
  /** abi.encode(Header): the updateClient message. */
  message: Hex
  /** The Header struct, as viem's encodeAbiParameters takes it. */
  struct: HeaderStruct
  height: bigint
  blockHash: Uint8Array
  signatures: number
  keysSent: number
}

/** Whether GnoLightClient will check the trust level for this update. */
export function needsTrustCheck(h: GnoHeader, vals: Validator[], o: HeaderOptions): Validator[] | undefined {
  if (!o.trustedValidators || h.height === o.trustedHeight + 1n) {
    return undefined;
  }
  const trusted = toValidators(o.trustedValidators);
  return bytesEqual(validatorSetHash(vals), validatorSetHash(trusted)) ? undefined : trusted;
}

/** The updateClient message for a gno header. Port of gnoibc.EncodeHeader + PackHeader. */
export async function encodeHeader(header: ibc.lightclients.gno.v1.gno.Header, o: HeaderOptions): Promise<EncodedHeader> {
  const sh = header.signedHeader;
  const h = sh?.header;
  const commit = sh?.commit;
  if (!h || !commit?.blockId) {
    throw new Error("header without signed header or commit");
  }
  const vals = toValidators(header.validatorSet);
  if (!bytesEqual(validatorSetHash(vals), h.validatorsHash)) {
    throw new Error("validator set does not hash to the header's validators hash (order or keys differ)");
  }
  const fields = encodeHeaderFields(h, commit.blockId.hash);
  const trusted = needsTrustCheck(h, vals, o);
  const num = o.trustNumerator ?? 1n;
  const den = o.trustDenominator ?? 3n;
  const signers = selectSigners(commit, vals, trusted, num, den, o.allSignatures ?? false);
  const c = await encodeCommit(h.chainId, h.height, commit, vals, trusted, signers);
  const keys = (vs: Validator[]) => vs.map(v => ({
    pubKey: toHex(v.uncompressed),
    votingPower: v.votingPower,
  }));
  const validatorSet = o.omitValidators ? [] : keys(vals);
  const trustedValidators = trusted && !o.omitTrusted ? keys(trusted) : [];
  const struct: HeaderStruct = {
    signedHeader: fields,
    commit: c,
    validatorSet,
    trustedHeight: o.trustedHeight,
    trustedValidators,
  };
  return {
    message: encodeAbiParameters(HEADER_PARAMS, [struct]),
    struct,
    height: h.height,
    blockHash: commit.blockId.hash,
    signatures: signers.length,
    keysSent: validatorSet.length + trustedValidators.length,
  };
}

/** abi.encode(Misbehaviour{header1, header2}) for GnoLightClient.misbehaviour. */
export function encodeMisbehaviour(header1: HeaderStruct, header2: HeaderStruct): Hex {
  return encodeAbiParameters(
    [
      {
        name: "misbehaviour",
        type: "tuple",
        components: [
          {
            ...HEADER_PARAMS[0],
            name: "header1",
          },
          {
            ...HEADER_PARAMS[0],
            name: "header2",
          },
        ],
      },
    ],
    [
      {
        header1,
        header2,
      },
    ],
  );
}

// ------------------------------------------------------------------ proofs

const EXIST = {
  type: "tuple",
  components: [
    {
      name: "key",
      type: "bytes",
    },
    {
      name: "value",
      type: "bytes",
    },
    {
      name: "leafPrefix",
      type: "bytes",
    },
    {
      name: "path",
      type: "tuple[]",
      components: [
        {
          name: "prefix",
          type: "bytes",
        },
        {
          name: "suffix",
          type: "bytes",
        },
      ],
    },
  ],
} as const;

const MEMBERSHIP_PARAMS = [
  {
    name: "proof",
    type: "tuple",
    components: [
      {
        name: "storeProof",
        ...EXIST,
      },
      {
        name: "rootProof",
        ...EXIST,
      },
    ],
  },
] as const;

const NON_MEMBERSHIP_PARAMS = [
  {
    name: "proof",
    type: "tuple",
    components: [
      {
        name: "storeProof",
        type: "tuple",
        components: [
          {
            name: "key",
            type: "bytes",
          },
          {
            name: "left",
            ...EXIST,
          },
          {
            name: "right",
            ...EXIST,
          },
        ],
      },
      {
        name: "rootProof",
        ...EXIST,
      },
    ],
  },
] as const;

interface AbiExistenceProof {
  key: Hex
  value: Hex
  leafPrefix: Hex
  path: {
    prefix: Hex
    suffix: Hex
  }[]
}

/**
 * Both gno specs (bptree and Tendermint) use the same leaf and inner hash
 * operations; the ABI proof carries only the prefixes, so a proof whose ops
 * differ is refused here, as gnoibc.convertExist does.
 */
function convertExist(p: ExistenceProof | undefined): AbiExistenceProof {
  if (!p) {
    return {
      key: "0x",
      value: "0x",
      leafPrefix: "0x",
      path: [],
    };
  }
  const l = p.leaf;
  if (!l) {
    throw new Error("existence proof has no leaf op");
  }
  if (l.hash !== HashOp.SHA256 || l.prehashKey !== HashOp.NO_HASH || l.prehashValue !== HashOp.SHA256 || l.length !== LengthOp.VAR_PROTO) {
    throw new Error("leaf op does not match the gno proof specs");
  }
  return {
    key: hex(p.key),
    value: hex(p.value),
    leafPrefix: hex(l.prefix),
    path: p.path.map((op, i) => {
      if (op.hash !== HashOp.SHA256) {
        throw new Error(`inner op ${i} hash does not match the gno proof specs`);
      }
      return {
        prefix: hex(op.prefix),
        suffix: hex(op.suffix),
      };
    }),
  };
}

function decodeProofs(merkleProof: Uint8Array): CommitmentProof[] {
  const {
    proofs,
  } = MerkleProof.decode(merkleProof);
  if (proofs.length !== 2) {
    throw new Error(`expected 2 commitment proofs (ics23:bptree, ics23:simple), got ${proofs.length}`);
  }
  return proofs;
}

/** MerkleProof bytes (as GnoIbcClient returns them) to abi.encode(MembershipProof). */
export function encodeMembershipProof(merkleProof: Uint8Array): Hex {
  const [store, root] = decodeProofs(merkleProof);
  if (!store.exist || !root.exist) {
    throw new Error("membership needs two existence proofs");
  }
  return encodeAbiParameters(MEMBERSHIP_PARAMS, [
    {
      storeProof: convertExist(store.exist),
      rootProof: convertExist(root.exist),
    },
  ]);
}

/** MerkleProof bytes to abi.encode(NonMembershipProof). */
export function encodeNonMembershipProof(merkleProof: Uint8Array): Hex {
  const [store, root] = decodeProofs(merkleProof);
  if (!store.nonexist || !root.exist) {
    throw new Error("non-membership needs a non-existence then an existence proof");
  }
  return encodeAbiParameters(NON_MEMBERSHIP_PARAMS, [
    {
      storeProof: {
        key: hex(store.nonexist.key),
        left: convertExist(store.nonexist.left),
        right: convertExist(store.nonexist.right),
      },
      rootProof: convertExist(root.exist),
    },
  ]);
}
