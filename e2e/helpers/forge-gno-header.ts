import {
  ibc,
} from "@gnolang/gno-types";

type GnoHeader = ibc.lightclients.gno.v1.gno.Header;

/**
 * Test-only extension point — NOT IMPLEMENTED, and currently NOT FEASIBLE.
 *
 * The mirror of forge-header.ts for the AtomOne side: given an honestly built
 * Gno update header for a height the Gno chain committed, return a header for
 * the SAME height the Gno chain never committed (e.g. a different app hash),
 * with the tm2 commit re-signed by the Gno chain's validator, so AtomOne's
 * `10-gno` light client accepts it. Freezing that client then follows the same
 * detect -> record -> submit(Misbehaviour) path as the Tendermint case.
 *
 * Blocker: gnodev generates its validator signing key in memory and never
 * writes a priv_validator_key.json, so — unlike mars/venus/atomone — the Gno
 * validator key cannot be read out of the container. Until the gno test image
 * exposes that key (or gnodev grows a flag for it), this cannot be signed, and
 * the AtomOne-side freeze test skips.
 */
export default function forgeConflictingGnoHeader(_honest: GnoHeader): Promise<GnoHeader> {
  const error = new Error(
    "forgeConflictingGnoHeader is not implemented: gnodev does not expose its validator "
    + "signing key, so a conflicting Gno header cannot be signed (see e2e/helpers/forge-gno-header.ts).",
  );
  error.name = "HeaderForgeNotImplemented";
  throw error;
}
