import {
  ibc,
} from "@gnolang/gno-types";

type GnoHeader = ibc.lightclients.gno.v1.gno.Header;

/**
 * Test-only extension point — NOT YET IMPLEMENTED.
 *
 * The mirror of forge-header.ts for the AtomOne side: given an honestly built
 * Gno update header for a height the Gno chain committed, return a header for
 * the SAME height the Gno chain never committed (e.g. a different app hash),
 * with the tm2 commit re-signed by the Gno chain's validator, so AtomOne's
 * `10-gno` light client accepts it. Freezing that client then follows the same
 * detect -> record -> submit(Misbehaviour) path as the Tendermint case.
 *
 * The Gno validator key is now readable: the gno image pins gnodev's validator
 * with -validator-key-file (gnolang/gno#6259), so `gnoValidatorKeypair()` in
 * forge-header.ts returns it. What remains is the tm2 header hashing and
 * canonical precommit signing (the amino-encoded analogue of forge-header.ts's
 * Tendermint math). Until this returns a real forged header, the AtomOne-side
 * freeze test skips.
 */
export default function forgeConflictingGnoHeader(_honest: GnoHeader): Promise<GnoHeader> {
  const error = new Error(
    "forgeConflictingGnoHeader is not implemented — sign a conflicting Gno header with "
    + "gnoValidatorKeypair() (see e2e/helpers/forge-gno-header.ts).",
  );
  error.name = "HeaderForgeNotImplemented";
  throw error;
}
