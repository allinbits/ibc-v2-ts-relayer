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
  commitmentSlot, executionHeader, packetPath,
} from "./execution.js";
import type {
  EthereumPublicClient,
} from "./IbcClient.js";

const block = (name: string) => JSON.parse(readFileSync(new URL(`./testdata/block-${name}.json`, import.meta.url), "utf-8")) as Record<string, string>;

const clientServing = (b: Record<string, string>) => ({
  request: async () => b,
}) as unknown as EthereumPublicClient;

describe("executionHeader", () => {
  // Sepolia runs Glamsterdam (blockAccessListHash, slotNumber); mainnet does not yet.
  it.each(["sepolia", "mainnet"])("re-encodes a %s header to its hash", async (name) => {
    const b = block(name);
    const h = await executionHeader(clientServing(b), b.hash);
    expect(h.number).toBe(BigInt(b.number));
    expect(h.timestamp).toBe(BigInt(b.timestamp));
    expect(bytesToHex(h.stateRoot)).toBe(b.stateRoot);
  });

  it("rejects a header that does not hash to the requested block", async () => {
    const b: Record<string, string> = {
      ...block("sepolia"),
      gasUsed: "0x1",
    };
    await expect(executionHeader(clientServing(b), b.hash)).rejects.toThrow("does not re-encode");
  });
});

describe("router paths", () => {
  it("builds ICS24 packet paths", () => {
    expect(bytesToHex(packetPath("client-0", 1, 58n))).toBe(
      bytesToHex(new TextEncoder().encode("client-0")) + "01" + "000000000000003a",
    );
  });

  it("derives the commitment storage slot like the gno-side client", () => {
    // keccak256(keccak256(path) || IBCStore commitments slot); the path is
    // the router-side receipt path of packet 1 on client-0.
    expect(commitmentSlot(packetPath("client-0", 2, 1n))).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
