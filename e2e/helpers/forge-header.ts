import {
  execFileSync,
} from "node:child_process";

import {
  BinaryWriter,
} from "@atomone/atomone-types/binary";
import {
  Timestamp,
} from "@atomone/atomone-types/google/protobuf/timestamp";
import {
  Header as TendermintHeader,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  BlockID,
  type Commit,
  type CommitSig,
  type Header as BlockHeader,
  SignedMsgType,
} from "@atomone/atomone-types/tendermint/types/types";
import {
  BlockIDFlag,
} from "@atomone/atomone-types/tendermint/types/validator";
import {
  Consensus,
} from "@atomone/atomone-types/tendermint/version/types";
import {
  Ed25519,
  Ed25519Keypair,
} from "@cosmjs/crypto";
import {
  fromBase64,
} from "@cosmjs/encoding";

import {
  merkleRoot,
} from "./common.ts";

// The mars chain runs as a service container (named `mars` in CI and compose);
// override for differently named setups. Its CometBFT validator key is baked
// into the image at scaffold time — deterministic throwaways, not secrets.
const MARS_CONTAINER = process.env.MARS_CONTAINER ?? "mars";
const A1GNO_CONTAINER = process.env.A1GNO_CONTAINER ?? "a1gno";
const GNO_CONTAINER = process.env.GNO_CONTAINER ?? "gno";

/**
 * Reads a CometBFT ed25519 validator key out of a chain container. The suite
 * runs on the host, not inside a chain container, so the key is read with
 * `docker exec`.
 *
 * priv_validator_key.json holds `priv_key.value` as base64 of 64 bytes:
 * the ed25519 seed (first 32) followed by the public key (last 32).
 */
export async function validatorKeypair(container: string, keyPath: string): Promise<Ed25519Keypair> {
  const raw = execFileSync("docker", ["exec", container, "cat", keyPath]);
  const key = JSON.parse(raw.toString()) as {
    priv_key: {
      value: string
    }
  };
  const secret = fromBase64(key.priv_key.value);
  return Ed25519.makeKeypair(secret.slice(0, 32));
}

export const marsValidatorKeypair = (): Promise<Ed25519Keypair> =>
  validatorKeypair(MARS_CONTAINER, "/home/tendermint/.mars/config/priv_validator_key.json");

export const atomoneValidatorKeypair = (): Promise<Ed25519Keypair> =>
  validatorKeypair(A1GNO_CONTAINER, "/root/.atomone/config/priv_validator_key.json");

// The gno image pins gnodev's validator to this key (gnolang/gno#6259); its
// priv_validator_key.json is amino JSON but, like CometBFT's, carries the
// 64-byte ed25519 key at priv_key.value.
export const gnoValidatorKeypair = (): Promise<Ed25519Keypair> =>
  validatorKeypair(GNO_CONTAINER, "/app/gnosecrets/priv_validator_key.json");

/** google.protobuf.BytesValue encoding; empty values encode to zero bytes. */
function bytesValue(value: Uint8Array): Uint8Array {
  const writer = BinaryWriter.create();
  if (value.length) writer.uint32(10).bytes(value);
  return writer.finish();
}

/** Tendermint >= 0.34 header hash, NOT SHA256(Header.encode(header)). */
export function tendermintHeaderHash(header: BlockHeader): Uint8Array {
  if (!header.validatorsHash.length) throw new Error("Missing validatorsHash");
  if (!header.version || !header.time || !header.lastBlockId) {
    throw new Error("Missing header version, time, or lastBlockId");
  }
  const chainId = BinaryWriter.create();
  if (header.chainId) chainId.uint32(10).string(header.chainId);
  const height = BinaryWriter.create();
  if (header.height !== 0n) height.uint32(8).int64(header.height);
  return merkleRoot([Consensus.encode(header.version).finish(), chainId.finish(), height.finish(), Timestamp.encode(header.time).finish(), BlockID.encode(header.lastBlockId).finish(), ...[header.lastCommitHash, header.dataHash, header.validatorsHash, header.nextValidatorsHash, header.consensusHash, header.appHash, header.lastResultsHash, header.evidenceHash, header.proposerAddress].map(bytesValue)]);
}

/** Reconstruct the canonical precommit bytes for a non-nil commit signature. */
export function precommitSignBytes(
  chainId: string,
  commit: Commit,
  commitSig: CommitSig,
): Uint8Array {
  if (commitSig.blockIdFlag !== BlockIDFlag.BLOCK_ID_FLAG_COMMIT) {
    throw new Error("Expected a non-nil precommit");
  }
  if (!commit.blockId || !commitSig.timestamp) {
    throw new Error("Missing commit block id or precommit timestamp");
  }
  const writer = BinaryWriter.create();
  writer.uint32(8).int32(SignedMsgType.SIGNED_MSG_TYPE_PRECOMMIT);
  if (commit.height !== 0n) writer.uint32(17).sfixed64(commit.height);
  // Proto3 omits round=0. Height and round use sfixed64, not varints.
  if (commit.round !== 0) writer.uint32(25).sfixed64(BigInt(commit.round));
  // CanonicalBlockID/CanonicalPartSetHeader have the same wire encoding as
  // BlockID/PartSetHeader for these fields. The block ID here is non-nil.
  BlockID.encode(commit.blockId, writer.uint32(34).fork()).ldelim();
  Timestamp.encode(commitSig.timestamp, writer.uint32(42).fork()).ldelim();
  if (chainId) writer.uint32(50).string(chainId);
  // bytes() without a preceding tag adds only the required varint length.
  return BinaryWriter.create().bytes(writer.finish()).finish();
}
/**
 * Return a distinct, correctly signed header at the input's exact height.
 * Requires a one-validator set and its 32-byte Ed25519 seed, or Tendermint's
 * 64-byte private key (seed || public key). Leaves the input untouched.
 * Flip one appHash bit to guarantee a different app hash.
 */
export default async function forgeConflictingHeader(input: TendermintHeader, signingKeypair?: Ed25519Keypair): Promise<TendermintHeader> {
  const keypair = signingKeypair ?? await marsValidatorKeypair();
  const output = structuredClone(input);
  const header = output.signedHeader?.header;
  const commit = output.signedHeader?.commit;
  const commitSig = commit!.signatures[0];

  const blockId = commit!.blockId;
  const changedAppHash = new Uint8Array(header!.appHash);
  changedAppHash[0] ^= 1;
  header!.appHash = changedAppHash;
  blockId!.hash = tendermintHeaderHash(header!);
  commitSig.signature = await Ed25519.createSignature(precommitSignBytes(header!.chainId, commit!, commitSig), keypair);
  return output;
}
