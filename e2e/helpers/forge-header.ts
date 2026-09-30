import {
  execFileSync,
} from "node:child_process";

import {
  Header as TendermintHeader,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  Ed25519,
  Ed25519Keypair,
} from "@cosmjs/crypto";
import {
  fromBase64,
} from "@cosmjs/encoding";

// The mars chain runs as a service container (named `mars` in CI and compose);
// override for differently named setups. Its CometBFT validator key is baked
// into the image at scaffold time — a deterministic throwaway, not a secret.
const MARS_CONTAINER = process.env.MARS_CONTAINER ?? "mars";
const VALIDATOR_KEY_PATH = "/home/tendermint/.mars/config/priv_validator_key.json";

/**
 * Loads the mars validator's ed25519 keypair out of its container, ready to
 * sign a forged commit. The suite runs on the host, not inside a chain
 * container, so the key is read with `docker exec`.
 *
 * priv_validator_key.json holds `priv_key.value` as base64 of 64 bytes:
 * the ed25519 seed (first 32) followed by the public key (last 32).
 */
export async function marsValidatorKeypair(): Promise<Ed25519Keypair> {
  const raw = execFileSync("docker", ["exec", MARS_CONTAINER, "cat", VALIDATOR_KEY_PATH]);
  const key = JSON.parse(raw.toString()) as {
    priv_key: {
      value: string
    }
  };
  const secret = fromBase64(key.priv_key.value);
  return Ed25519.makeKeypair(secret.slice(0, 32));
}

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
 * changing the block, recompute the block hash and re-sign the commit with
 * `marsValidatorKeypair()`, and leave the trusted height and the
 * trusted/current validator sets as built.
 *
 * See ibc-go's `testing` package and 07-tendermint `misbehaviour_test.go` for
 * the canonical construction. Until this returns a real forged header, the
 * freeze e2e test skips itself (it recognises the error name below).
 */
export default function forgeConflictingHeader(_honest: TendermintHeader): Promise<TendermintHeader> {
  const error = new Error(
    "forgeConflictingHeader is not implemented — build the conflicting block, recompute its "
    + "hash and re-sign the commit with marsValidatorKeypair() (see e2e/helpers/forge-header.ts).",
  );
  error.name = "HeaderForgeNotImplemented";
  throw error;
}
