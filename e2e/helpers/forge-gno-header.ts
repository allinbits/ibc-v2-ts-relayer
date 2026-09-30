import {
  Ed25519,
  Ed25519Keypair,
} from "@cosmjs/crypto";
import {
  ibc,
} from "@gnolang/gno-types";

import {
  gnoValidatorKeypair,
} from "./forge-header.ts";
import {
  gnoHeaderHash, gnoPrecommitSignBytes,
} from "./gno-signbytes.ts";

type GnoHeader = ibc.lightclients.gno.v1.gno.Header;

/**
 * The mirror of forge-header.ts for the AtomOne side: given an honestly built
 * Gno update header for a height the Gno chain committed, return a header for
 * the SAME height the Gno chain never committed (a flipped app-hash bit), with
 * the tm2 commit re-signed by the Gno chain's validator, so AtomOne's `10-gno`
 * light client accepts it. Freezing that client then follows the same
 * detect -> record -> submit(Misbehaviour) path as the Tendermint case.
 *
 * The header hash and precommit sign bytes are the amino-encoded analogues of
 * forge-header.ts's Tendermint math (see gno-signbytes.ts). The signing key
 * comes from the gno image's pinned validator (gnolang/gno#6259) via
 * `gnoValidatorKeypair()`; pass it in to avoid re-reading it from the container.
 */
export default async function forgeConflictingGnoHeader(input: GnoHeader, signingKeypair?: Ed25519Keypair): Promise<GnoHeader> {
  const keypair = signingKeypair ?? await gnoValidatorKeypair();
  const output = structuredClone(input);
  const header = output.signedHeader?.header;
  const commit = output.signedHeader?.commit;
  const precommit = commit!.precommits[0];

  const blockId = commit!.blockId;
  const changedAppHash = new Uint8Array(header!.appHash);
  changedAppHash[0] ^= 1;
  header!.appHash = changedAppHash;
  blockId!.hash = gnoHeaderHash(header!);
  precommit.blockId!.hash = blockId!.hash;
  precommit.signature = await Ed25519.createSignature(gnoPrecommitSignBytes(header!.chainId, precommit), keypair);
  return output;
}
