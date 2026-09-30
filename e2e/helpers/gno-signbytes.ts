import {
  AminoType,
} from "@gnolang/amino-ts";
import {
  addressFromBech32,
  bft,
  gnoCodec,
} from "@gnolang/amino-ts/gno";
import {
  ibc,
} from "@gnolang/gno-types";

import {
  merkleRoot,
} from "./common.ts";

// tm2 SignedMsgType (tm2/pkg/bft/types/signed_msg_type.go).
export const GNO_PRECOMMIT_TYPE = 0x02;

// A gno.land codec with every tm2 type registered; reused across calls.
const codec = gnoCodec();

/**
 * Canonical sign bytes for a tm2/Gno precommit: the bytes the validator signs.
 *
 * This is the amino-encoded analogue of a Tendermint vote's sign bytes and a
 * faithful port of gno's `(*Vote).SignBytes`:
 *
 *     amino.MarshalSized(CanonicalizeVote(chainID, vote))
 *
 * (tm2/pkg/bft/types/vote.go, canonical.go). `marshalSized` is amino's
 * length-prefixed marshal; `CanonicalizeVote` reorders the fields, widens the
 * round to int64 and drops everything not in the canonical form. Pass the same
 * chain ID and precommit the chain used, and the output verifies against the
 * validator's signature — so re-signing these bytes yields a valid commit.
 *
 * @param chainId - The chain ID the vote was signed under
 * @param precommit - The precommit vote (a Commit's precommit entry)
 * @returns The canonical sign bytes
 */
export function gnoPrecommitSignBytes(chainId: string, precommit: ibc.lightclients.gno.v1.gno.CommitSig): Uint8Array {
  const partsHeader = precommit.blockId?.partsHeader;
  const total = partsHeader?.total ?? 0n;
  if (total < 0n || total > 0xffffffffn) {
    // CanonicalizePartSetHeader panics outside the uint32 range rather than
    // let a truncated total collide with a different header's sign bytes.
    throw new Error(`PartSetHeader.total (${total}) out of canonical uint32 range`);
  }
  const canonicalVote = {
    type: precommit.type,
    height: precommit.height,
    // CanonicalVote.round is int64; the Gno CommitSig already carries a bigint.
    round: precommit.round,
    blockID: {
      hash: precommit.blockId?.hash ?? new Uint8Array(),
      partsHeader: {
        total: Number(total),
        hash: partsHeader?.hash ?? new Uint8Array(),
      },
    },
    timestamp: {
      seconds: precommit.timestamp?.seconds ?? 0n,
      nanos: precommit.timestamp?.nanos ?? 0,
    },
    chainID: chainId,
  };
  return codec.marshalSized(bft.CanonicalVote, canonicalVote);
}

// Resolves a field's amino type from the registered bft.Header spec, so each
// field marshals exactly as amino.MustMarshal would in tm2's Header.Hash.
function headerFieldType(field: string): AminoType {
  const spec = (bft.Header.spec as Record<string, AminoType | {
    type: AminoType
  }>)[field];
  return "type" in spec ? spec.type : spec;
}

// tm2 bytesOrNil: an empty (zero) field contributes an empty Merkle leaf; a
// non-empty one contributes amino.MustMarshal(field).
function bytesOrNil(field: string, value: unknown, empty: boolean): Uint8Array {
  return empty ? new Uint8Array() : codec.marshal(headerFieldType(field) as never, value as never);
}

/**
 * The block hash of a tm2/Gno header: a faithful port of gno's
 * `(*Header).Hash` (tm2/pkg/bft/types/block.go). It is
 * `merkle.SimpleHashFromByteSlices` over the 16 header fields, each run through
 * `bytesOrNil` (amino.MustMarshal, or an empty leaf for a zero value), in tm2's
 * field order — which differs from the protobuf Tendermint header (it has
 * numTxs/totalTxs/appVersion and no evidenceHash). This equals the commit's
 * blockId.hash, so a forged header must set that to this value.
 *
 * @param header - The Gno block header
 * @returns The 32-byte block hash
 */
export function gnoHeaderHash(header: ibc.lightclients.gno.v1.gno.GnoHeader): Uint8Array {
  const lastBlockId = header.lastBlockId;
  const lastBlockIdEmpty = !lastBlockId
    || (lastBlockId.hash.length === 0
      && (!lastBlockId.partsHeader || (lastBlockId.partsHeader.total === 0n && lastBlockId.partsHeader.hash.length === 0)));
  const time = header.time;
  const timeEmpty = !time || (time.seconds === 0n && time.nanos === 0);
  const proposerAddress = header.proposerAddress ? addressFromBech32(header.proposerAddress) : new Uint8Array();

  return merkleRoot([bytesOrNil("version", header.version, header.version === ""), bytesOrNil("chainID", header.chainId, header.chainId === ""), bytesOrNil("height", header.height, header.height === 0n), bytesOrNil("time", time, timeEmpty), bytesOrNil("numTxs", header.numTxs, header.numTxs === 0n), bytesOrNil("totalTxs", header.totalTxs, header.totalTxs === 0n), bytesOrNil("appVersion", header.appVersion, header.appVersion === ""), bytesOrNil("lastBlockID", lastBlockId, lastBlockIdEmpty), bytesOrNil("lastCommitHash", header.lastCommitHash, header.lastCommitHash.length === 0), bytesOrNil("dataHash", header.dataHash, header.dataHash.length === 0), bytesOrNil("validatorsHash", header.validatorsHash, header.validatorsHash.length === 0), bytesOrNil("nextValidatorsHash", header.nextValidatorsHash, header.nextValidatorsHash.length === 0), bytesOrNil("consensusHash", header.consensusHash, header.consensusHash.length === 0), bytesOrNil("appHash", header.appHash, header.appHash.length === 0), bytesOrNil("lastResultsHash", header.lastResultsHash, header.lastResultsHash.length === 0), bytesOrNil("proposerAddress", proposerAddress, proposerAddress.length === 0)]);
}
