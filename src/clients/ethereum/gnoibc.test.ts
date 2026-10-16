import {
  fromHex,
} from "@cosmjs/encoding";
import {
  ibc,
} from "@gnolang/gno-types";
import {
  toHex,
} from "viem";
import {
  describe, expect, it,
} from "vitest";

import {
  encodeHeader, encodeMembershipProof, encodeNonMembershipProof, toValidators, validatorSetHash,
} from "./gnoibc.js";
import vectors from "./testdata/gnoibc-vectors.json";

/*
 * gnoibc-vectors.json comes from github.com/gnolang/gno-eth-ibc:
 *   cd fixtures && go run ./cmd/genfixtures -ts-out <this repo>/src/clients/ethereum/testdata/gnoibc-vectors.json
 * Headers are signed by tm2 MockPVs with secp256k1 keys; the expected bytes
 * are the Go encoder's (relayer/gnoibc), which GnoLightClient's tests consume.
 */

type Json = Record<string, unknown>;

const b = (h: string | undefined) => fromHex(h ?? "");
const n = (s: string | undefined) => BigInt(s ?? "0");

function ts(t: Json | undefined) {
  return t
    ? {
      seconds: n(t.seconds as string),
      nanos: t.nanos as number,
    }
    : undefined;
}

function blockId(j: Json | undefined) {
  if (!j) {
    return undefined;
  }
  const ph = j.partsHeader as Json;
  return {
    hash: b(j.hash as string),
    partsHeader: {
      total: n(ph.total as string),
      hash: b(ph.hash as string),
    },
  };
}

function valSet(j: Json | undefined, field: "secp256k1" | "ed25519" = "secp256k1") {
  if (!j) {
    return undefined;
  }
  return ibc.lightclients.gno.v1.gno.ValidatorSet.fromPartial({
    validators: (j.validators as Json[]).map(v => ({
      address: v.address as string,
      pubKey: field === "secp256k1"
        ? {
          secp256k1: b((v.pubKey as Json).secp256k1 as string),
        }
        : {
          ed25519: b((v.pubKey as Json).secp256k1 as string),
        },
      votingPower: n(v.votingPower as string),
    })),
  });
}

/** The ibc.lightclients.gno.v1 Header GnoIbcClient.buildHeader would return. */
function toHeader(j: Json, keyField: "secp256k1" | "ed25519" = "secp256k1") {
  const sh = j.signedHeader as Json;
  const h = sh.header as Json;
  const c = sh.commit as Json;
  return ibc.lightclients.gno.v1.gno.Header.fromPartial({
    signedHeader: {
      header: {
        version: h.version as string,
        chainId: h.chainId as string,
        height: n(h.height as string),
        time: ts(h.time as Json),
        numTxs: n(h.numTxs as string),
        totalTxs: n(h.totalTxs as string),
        appVersion: h.appVersion as string,
        lastBlockId: blockId(h.lastBlockId as Json),
        lastCommitHash: b(h.lastCommitHash as string),
        dataHash: b(h.dataHash as string),
        validatorsHash: b(h.validatorsHash as string),
        nextValidatorsHash: b(h.nextValidatorsHash as string),
        consensusHash: b(h.consensusHash as string),
        appHash: b(h.appHash as string),
        lastResultsHash: b(h.lastResultsHash as string),
        proposerAddress: h.proposerAddress as string,
      },
      commit: {
        blockId: blockId(c.blockId as Json),
        precommits: (c.precommits as Json[]).map(pc => pc.signature
          ? {
            type: pc.type as number,
            height: n(pc.height as string),
            round: n(pc.round as string),
            blockId: blockId(pc.blockId as Json),
            timestamp: ts(pc.timestamp as Json),
            validatorAddress: pc.validatorAddress as string,
            validatorIndex: n(pc.validatorIndex as string),
            signature: b(pc.signature as string),
          }
          : {
          }),
      },
    },
    validatorSet: valSet(j.validatorSet as Json, keyField),
    trustedHeight: {
      revisionNumber: n((j.trustedHeight as Json).revisionNumber as string),
      revisionHeight: n((j.trustedHeight as Json).revisionHeight as string),
    },
    trustedValidators: valSet(j.trustedValidators as Json, keyField),
  });
}

describe("gnoibc vectors (Go relayer/gnoibc)", () => {
  it.each(vectors.headers.map(c => [c.name, c] as const))("header: %s", async (_name, c) => {
    const header = toHeader(c.header as unknown as Json);
    expect(toHex(validatorSetHash(toValidators(header.validatorSet)))).toBe(`0x${c.validatorsHash}`);
    const enc = await encodeHeader(header, {
      trustedHeight: header.trustedHeight.revisionHeight,
      trustedValidators: header.trustedValidators,
      omitValidators: c.options.omitValidators,
      omitTrusted: c.options.omitTrusted,
      allSignatures: c.options.allSignatures,
    });
    expect(toHex(enc.blockHash)).toBe(`0x${c.blockHash}`);
    expect(enc.message).toBe(`0x${c.expected}`);
  });

  it("accepts the secp256k1 key in the ed25519 field, as the gno client fills it today", async () => {
    const c = vectors.headers[0];
    const header = toHeader(c.header as unknown as Json, "ed25519");
    const enc = await encodeHeader(header, {
      trustedHeight: header.trustedHeight.revisionHeight,
      trustedValidators: header.trustedValidators,
      allSignatures: true,
    });
    expect(enc.message).toBe(`0x${c.expected}`);
  });

  it("refuses a validator set in another order", async () => {
    const header = toHeader(vectors.headers[0].header as unknown as Json);
    header.validatorSet.validators.reverse();
    await expect(encodeHeader(header, {
      trustedHeight: 10n,
    })).rejects.toThrow(/does not hash/);
  });

  it("refuses a header whose fields do not hash to the committed block", async () => {
    const header = toHeader(vectors.headers[0].header as unknown as Json);
    header.signedHeader.header.appVersion = "tampered";
    await expect(encodeHeader(header, {
      trustedHeight: 10n,
    })).rejects.toThrow(/does not match the committed block hash/);
  });

  it("refuses an unreachable trust level when picking minimal signers", async () => {
    const c = vectors.headers.find(h => h.name.startsWith("trust level unreachable"));
    const header = toHeader(c.header as unknown as Json);
    await expect(encodeHeader(header, {
      trustedHeight: header.trustedHeight.revisionHeight,
      trustedValidators: header.trustedValidators,
    })).rejects.toThrow(/trusted signers hold/);
  });

  it.each(vectors.proofs.map(c => [c.name, c] as const))("proof: %s", (_name, c) => {
    const enc = c.membership ? encodeMembershipProof(b(c.merkleProof)) : encodeNonMembershipProof(b(c.merkleProof));
    expect(enc).toBe(`0x${c.expected}`);
  });
});
