import {
  Packet as PacketV2,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";
import {
  sha256,
} from "viem";
import {
  describe, expect, it, vi,
} from "vitest";
import type * as winston from "winston";

import type {
  BaseEndpoint,
} from "../../endpoints/BaseEndpoint.js";
import {
  AckV2WithMetadata, ClientType,
} from "../../types/index.js";
import {
  Link,
} from "./link.js";

/*
 * The Ethereum => gno acknowledgement path as it failed on Sepolia:
 * ICS26Router wrote the ack in the block at slot 11406790, gno's Ethereum
 * client stood at the finalized slot 11406720, and the relayer proved the
 * ack commitment at the finalized slot its update reached, still before the
 * ack. The core rejected every attempt with "stored commitment differs from
 * the expected value".
 */
const ACK_SLOT = 11406790;
const FINALIZED_SLOT = 11406720;
const SLOTS_PER_EPOCH = 32;

const packet = PacketV2.fromPartial({
  sequence: 1n,
  sourceClient: "ethereum-1",
  destinationClient: "client-0",
  timeoutTimestamp: 1792635945n,
  payloads: [
    {
      sourcePort: "gov",
      destinationPort: "ibcgov",
      version: "ibcgov-1",
      encoding: "application/x-ibcgov",
      value: Uint8Array.from([1]),
    },
  ],
});

const ack: AckV2WithMetadata = {
  acknowledgement: Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0]),
  originalPacket: packet,
  height: ACK_SLOT,
  txHash: "",
  txEvents: [],
};

const height = (h: number): Height => Height.fromPartial({
  revisionNumber: 0n,
  revisionHeight: BigInt(h),
});

/** sha256(0x02 || sha256(ack)): the commitment ICS26Router stores. */
function ackCommitment(a: Uint8Array): Uint8Array {
  const buf = new Uint8Array(33);
  buf[0] = 2;
  buf.set(sha256(a, "bytes"), 1);
  return sha256(buf, "bytes");
}

/**
 * An Ethereum source whose finality advances one epoch per waitOneBlock
 * call, and whose storage proofs show the ack commitment only at slots from
 * ACK_SLOT on.
 */
function ethereumEnd() {
  let finalized = FINALIZED_SLOT;
  const provedAt: number[] = [];
  const client = {
    chainId: "11155111",
    clientType: ClientType.Ethereum,
    revisionHeight: height,
    latestHeader: vi.fn(async () => ({
      height: finalized,
    })),
    waitOneBlock: vi.fn(async () => {
      finalized += SLOTS_PER_EPOCH;
    }),
    getAckProofV2: vi.fn(async (_p: PacketV2, at: Height) => {
      const slot = Number(at.revisionHeight);
      provedAt.push(slot);
      const data = slot >= ACK_SLOT ? ackCommitment(ack.acknowledgement) : new Uint8Array();
      return {
        data,
        proof: data,
        proofHeight: at,
      };
    }),
  };
  return {
    end: {
      clientID: "client-0",
      client,
    } as unknown as BaseEndpoint,
    client,
    provedAt,
  };
}

/** A gno destination whose Ethereum client follows the source's finality. */
function gnoEnd(source: ReturnType<typeof ethereumEnd>["client"]) {
  let known = FINALIZED_SLOT;
  const client = {
    chainId: "test-ibc-1",
    clientType: ClientType.Gno,
    getLatestClientState: vi.fn(async () => ({
      lcType: "ethereum",
      forkParameters: {
      },
      latestHeight: height(known),
    })),
    updateClient: vi.fn(async () => {
      known = (await source.latestHeader()).height;
      return height(known);
    }),
    acknowledgePacketsV2: vi.fn(async (acks: readonly AckV2WithMetadata[], proofs: readonly Uint8Array[], proofHeight: Height) => {
      if (Number(proofHeight.revisionHeight) > known) {
        throw new Error(`no consensus state at height ${proofHeight.revisionHeight}`);
      }
      const want = ackCommitment(acks[0].acknowledgement);
      if (proofs[0].length !== want.length || !proofs[0].every((b, i) => b === want[i])) {
        throw new Error("failed packet acknowledgement verification for client (ethereum-1): stored commitment differs from the expected value");
      }
      return {
        events: [],
        transactionHash: "",
        height: 11053,
      };
    }),
  };
  return {
    end: {
      clientID: "ethereum-1",
      client,
    } as unknown as BaseEndpoint,
    client,
  };
}

const logger = {
  info: vi.fn(),
  verbose: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as winston.Logger;

describe("Link.relayAcks from Ethereum", () => {
  it("proves the ack at a finalized slot past the block that wrote it", async () => {
    const eth = ethereumEnd();
    const gno = gnoEnd(eth.client);
    const link = new Link(gno.end, eth.end, logger);

    await expect(link.relayAcks("B", [ack])).resolves.toBe(11053);

    // Three epochs of finality were needed before the ack's slot was provable.
    expect(eth.client.waitOneBlock).toHaveBeenCalledTimes(3);
    expect(eth.provedAt).toEqual([FINALIZED_SLOT + 3 * SLOTS_PER_EPOCH]);
    // One update, once the header was there: no update below the ack's slot.
    expect(gno.client.updateClient).toHaveBeenCalledTimes(1);
    const [, , proofHeight] = gno.client.acknowledgePacketsV2.mock.calls[0];
    expect(Number(proofHeight.revisionHeight)).toBeGreaterThan(ACK_SLOT);
  });

  it("needs no update when the client already covers the ack", async () => {
    const eth = ethereumEnd();
    const gno = gnoEnd(eth.client);
    for (let i = 0; i < 3; i++) {
      await eth.client.waitOneBlock();
    }
    await gno.client.updateClient();
    eth.client.waitOneBlock.mockClear();
    gno.client.updateClient.mockClear();
    const link = new Link(gno.end, eth.end, logger);

    await expect(link.relayAcks("B", [ack])).resolves.toBe(11053);
    expect(eth.client.waitOneBlock).not.toHaveBeenCalled();
    expect(gno.client.updateClient).not.toHaveBeenCalled();
    expect(eth.provedAt).toEqual([FINALIZED_SLOT + 3 * SLOTS_PER_EPOCH]);
  });

  it("gives up on the round when finality stalls", async () => {
    const eth = ethereumEnd();
    eth.client.waitOneBlock.mockImplementation(async () => {});
    const gno = gnoEnd(eth.client);
    const link = new Link(gno.end, eth.end, logger);

    await expect(link.relayAcks("B", [ack])).rejects.toThrow(/has not reached height 11406791/);
    expect(gno.client.updateClient).not.toHaveBeenCalled();
    expect(gno.client.acknowledgePacketsV2).not.toHaveBeenCalled();
  });
});
