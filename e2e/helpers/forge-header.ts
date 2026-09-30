import {
  Header as TendermintHeader,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";

/**
 * Test-only extension point — NOT YET IMPLEMENTED.
 *
 * Given an honestly built Tendermint update header for a height the source
 * chain (mars) actually committed, return a header for the SAME height that
 * mars never committed — e.g. with a different app hash — whose commit is
 * validly signed by mars's validator set, so a light client tracking mars
 * accepts it as a valid update. Two validly signed headers for one height with
 * different block hashes is exactly what light-client misbehaviour is.
 *
 * Everything on the returned header must stay internally consistent: after
 * changing the block, recompute the block hash and re-sign the commit, and
 * leave the trusted height and the trusted/current validator sets as built.
 * The mars validator's key lives inside the mars test container at
 * /home/tendermint/.mars/config/priv_validator_key.json.
 *
 * See ibc-go's `testing` package and 07-tendermint `misbehaviour_test.go` for
 * the canonical construction. Until this returns a real forged header, the
 * freeze e2e test skips itself (it recognises the error name below).
 */
export default function forgeConflictingHeader(_honest: TendermintHeader): Promise<TendermintHeader> {
  const error = new Error(
    "forgeConflictingHeader is not implemented — supply a mars-validator-signed conflicting "
    + "header (see the contract in e2e/helpers/forge-header.ts).",
  );
  error.name = "HeaderForgeNotImplemented";
  throw error;
}
