import {
  readFileSync,
} from "node:fs";

import {
  bytesToHex,
} from "viem";
import {
  describe, expect, it,
} from "vitest";

import {
  LightClientUpdate, SyncCommittee,
} from "./beacon.js";
import {
  encodeHeader, encodeMembershipProof, encodePacketMsg, hex, nonSigners, summarize, WireWriter,
} from "./wire.js";

// Recorded from live Sepolia by gno-eth-ibc's relayer/cmd/ts-vectors, with
// the bytes its Go encoder (relayer/ethgno) produced.
const vectors = JSON.parse(readFileSync(new URL("./testdata/wire-vectors.json", import.meta.url), "utf-8")) as {
  headers: {
    update: LightClientUpdate
    activeCommittee: SyncCommittee
    isNext: boolean
    trustedSlot: number
    finalizedExecHeader: string
    expected: string
  }[]
  membershipProof: {
    accountProof: string[]
    storageProof: string[]
    expected: string
  }
  recvPacket: string
  ackPacket: string
};

const strip = (h: string) => h.replace(/^0x/, "");

describe("wire encoding matches the Go relayer", () => {
  it.each(vectors.headers.map((v, i) => [i, v] as const))("header %i", (_i, v) => {
    const got = encodeHeader(
      v.update,
      v.activeCommittee,
      v.isNext,
      BigInt(v.trustedSlot),
      v.finalizedExecHeader ? hex(v.finalizedExecHeader) : undefined,
    );
    expect(strip(bytesToHex(got))).toBe(v.expected);
  });

  const proof = {
    accountProof: vectors.membershipProof.accountProof.map(hex),
    storageProof: vectors.membershipProof.storageProof.map(hex),
    value: new Uint8Array(),
  };
  const packet = {
    sequence: 7n,
    sourceClient: "client-0",
    destinationClient: "ethereum-1",
    timeoutTimestamp: 1792078494n,
    payloads: [
      {
        sourcePort: "transfer",
        destinationPort: "transfer",
        version: "ics20-1",
        encoding: "application/x-solidity-abi",
        value: Uint8Array.of(0, 1, 2, 3),
      },
    ],
  };

  it("membership proof", () => {
    expect(strip(bytesToHex(encodeMembershipProof(proof)))).toBe(vectors.membershipProof.expected);
  });

  it("recv packet message", () => {
    expect(strip(bytesToHex(encodePacketMsg(packet, 11361600n, undefined, encodeMembershipProof(proof))))).toBe(vectors.recvPacket);
  });

  it("ack packet message", () => {
    const ack = new TextEncoder().encode("{\"result\":\"AQ==\"}");
    expect(strip(bytesToHex(encodePacketMsg(packet, 11361600n, [ack], encodeMembershipProof(proof))))).toBe(vectors.ackPacket);
  });
});

describe("WireWriter", () => {
  it("encodes uvarints as LEB128", () => {
    expect(bytesToHex(new WireWriter().uvarint(0).uvarint(127).uvarint(128).uvarint(300).bytes())).toBe("0x007f8001ac02");
  });

  it("encodes uints as 8 bytes big-endian", () => {
    expect(bytesToHex(new WireWriter().uint(258n).bytes())).toBe("0x0000000000000102");
  });
});

describe("sync committee helpers", () => {
  const committee = vectors.headers[0].activeCommittee;

  it("lists every member whose bit is unset, and only those", () => {
    const allSigned = "0x" + "ff".repeat(committee.pubkeys.length / 8);
    expect(nonSigners(committee, allSigned)).toHaveLength(0);
    const firstMissing = "0xfe" + "ff".repeat(committee.pubkeys.length / 8 - 1);
    const ns = nonSigners(committee, firstMissing);
    expect(ns).toHaveLength(1);
    expect(bytesToHex(ns[0].pubkey)).toBe(committee.pubkeys[0]);
    expect(ns[0].branch).toHaveLength(Math.log2(committee.pubkeys.length));
  });

  it("summarizes to a 32-byte root and the aggregate key", () => {
    const s = summarize(committee);
    expect(s.pubkeysHash).toHaveLength(32);
    expect(bytesToHex(s.aggregatePubkey)).toBe(committee.aggregate_pubkey);
  });
});
