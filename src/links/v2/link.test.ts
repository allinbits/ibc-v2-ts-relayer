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
  AckV2WithMetadata, ClientType, PacketV2WithMetadata,
} from "../../types/index.js";
import {
  Link, RelayedHeights,
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

/*
 * The Ethereum => gno packet path as it ran on Sepolia: the router sent a
 * packet in the block at slot 11407273 while gno's Ethereum client stood at
 * the finalized slot 11407200. The relay loop read packets up to the head,
 * so it saw the packet at once, then stood still for 17 minutes until
 * Sepolia finalized the slot; and it took the head as the next round's
 * floor, read apart from the blocks the scan had covered, so a block
 * between the two was lost for good.
 */
const PACKET_SLOT = 11407273;
const EPOCH = 32;

const dateAt = (seconds: number) => Object.assign(new Date(seconds * 1000), {
  nanoseconds: 0,
});

/** A packet the router sent in the block at `slot`, timing out far ahead. */
function sentPacket(sequence: number, slot: number): PacketV2WithMetadata {
  return {
    packet: PacketV2.fromPartial({
      sequence: BigInt(sequence),
      sourceClient: "client-0",
      destinationClient: "ethereum-1",
      timeoutTimestamp: 4102444800n,
      payloads: [
        {
          sourcePort: "transfer",
          destinationPort: "transfer",
          version: "ics20-1",
          encoding: "application/x-solidity-abi",
          value: Uint8Array.from([1]),
        },
      ],
    }),
    height: slot,
  };
}

/**
 * An Ethereum source: its head and finalized slots move as a test says, and
 * it serves the packets sent in a window of slots as eth_getLogs does. A
 * scan with no bound is the unbounded read the link used to make, and it
 * stops a slot short of the head the same round reads: the race that lost
 * a block whenever a packet sat in it.
 */
function ethereumSource(finalized: number, sent: PacketV2WithMetadata[]) {
  const state = {
    head: finalized + 2 * EPOCH + 5,
    finalized,
  };
  const scans: [number | undefined, number | undefined][] = [];
  const client = {
    chainId: "11155111",
    clientType: ClientType.Ethereum,
    revisionHeight: height,
    currentHeight: vi.fn(async () => state.head),
    currentTime: vi.fn(async () => dateAt(0)),
    timeoutHeight: vi.fn(async (blocks: number) => height(state.head + blocks)),
    latestHeader: vi.fn(async () => ({
      height: state.finalized,
    })),
    waitOneBlock: vi.fn(async () => {
      state.finalized += EPOCH;
    }),
    waitForIndexer: vi.fn(async () => {}),
    queryCommitmentsV2: vi.fn(async () => Uint8Array.from([1])),
    queryUnreceivedPacketsV2: vi.fn(async () => []),
    queryUnreceivedAcksV2: vi.fn(async () => []),
    getPacketProofV2: vi.fn(async (_p: PacketV2, at: Height) => ({
      data: new Uint8Array(),
      proof: new Uint8Array(),
      proofHeight: at,
    })),
  };
  const end = {
    clientID: "client-0",
    client,
    querySentPackets: vi.fn(async (min: number | undefined, max: number | undefined) => {
      scans.push([min, max]);
      const to = max ?? state.head - 1;
      return sent.filter(({
        height: slot,
      }) => (min === undefined || slot > min) && slot <= to);
    }),
    queryWrittenAcks: vi.fn(async () => []),
  } as unknown as BaseEndpoint;
  return {
    end,
    client,
    state,
    scans,
  };
}

/** A gno destination whose Ethereum client follows the source's finality on update. */
function gnoDestination(source: ReturnType<typeof ethereumSource>["client"], known: number) {
  const state = {
    height: 16000,
    known,
  };
  const received: number[] = [];
  const client = {
    chainId: "test-ibc-1",
    clientType: ClientType.Gno,
    revisionHeight: height,
    currentHeight: vi.fn(async () => state.height),
    currentTime: vi.fn(async () => dateAt(0)),
    timeoutHeight: vi.fn(async (blocks: number) => height(state.height + blocks)),
    latestHeader: vi.fn(async () => ({
      height: BigInt(state.height),
    })),
    waitForIndexer: vi.fn(async () => {}),
    getLatestClientState: vi.fn(async () => ({
      lcType: "ethereum",
      forkParameters: {
      },
      latestHeight: height(state.known),
    })),
    updateClient: vi.fn(async () => {
      state.known = (await source.latestHeader()).height;
      return height(state.known);
    }),
    queryUnreceivedPacketsV2: vi.fn(async (_client: string, sequences: readonly number[]) => sequences.filter(s => !received.includes(s))),
    queryUnreceivedAcksV2: vi.fn(async () => []),
    receivePacketsV2: vi.fn(async (packets: readonly PacketV2[], _proofs: readonly Uint8Array[], proofHeight: Height) => {
      if (Number(proofHeight.revisionHeight) > state.known) {
        throw new Error(`no consensus state at height ${proofHeight.revisionHeight}`);
      }
      received.push(...packets.map(p => Number(p.sequence)));
      state.height += 1;
      return {
        events: [],
        transactionHash: "",
        height: state.height,
      };
    }),
  };
  const end = {
    clientID: "ethereum-1",
    client,
    querySentPackets: vi.fn(async () => []),
    queryWrittenAcks: vi.fn(async () => []),
  } as unknown as BaseEndpoint;
  return {
    end,
    client,
    state,
    received,
  };
}

describe("Link.checkAndRelayPacketsAndAcks from Ethereum", () => {
  const FINALIZED = 11407200;

  it("relays a packet in the round its slot is provable, with no wait on finality", async () => {
    const eth = ethereumSource(FINALIZED, [sentPacket(1, PACKET_SLOT)]);
    const gno = gnoDestination(eth.client, FINALIZED - EPOCH);
    const link = new Link(gno.end, eth.end, logger);

    // The packet's slot is past the finalized one: the scan stops short of
    // it, and the floor it hands back is the bound it reached.
    let heights = await link.checkAndRelayPacketsAndAcks({
      packetHeightB: FINALIZED - 100,
      ackHeightB: FINALIZED - 100,
    });
    expect(eth.scans).toEqual([[FINALIZED - 100, FINALIZED - 1]]);
    expect(gno.client.receivePacketsV2).not.toHaveBeenCalled();
    expect(heights.packetHeightB).toBe(FINALIZED - 1);

    // Two epochs on, the slot is still not final.
    eth.state.finalized += 2 * EPOCH;
    heights = await link.checkAndRelayPacketsAndAcks(heights);
    expect(gno.client.receivePacketsV2).not.toHaveBeenCalled();
    expect(heights.packetHeightB).toBe(FINALIZED + 2 * EPOCH - 1);

    // One more and it is: the round delivers it, proven at the finalized
    // slot the one update brought gno's client to, with no block waited.
    eth.state.finalized += EPOCH;
    heights = await link.checkAndRelayPacketsAndAcks(heights);
    expect(eth.scans).toHaveLength(3);
    expect(eth.scans[2]).toEqual([FINALIZED + 2 * EPOCH - 1, FINALIZED + 3 * EPOCH - 1]);
    expect(gno.received).toEqual([1]);
    expect(eth.client.waitOneBlock).not.toHaveBeenCalled();
    expect(gno.client.updateClient).toHaveBeenCalledTimes(1);
    const [, , proofHeight] = gno.client.receivePacketsV2.mock.calls[0];
    expect(Number(proofHeight.revisionHeight)).toBe(FINALIZED + 3 * EPOCH);
    expect(heights.packetHeightB).toBe(FINALIZED + 3 * EPOCH - 1);

    // Once: with finality unmoved the next round has nothing to scan, and
    // the one after scans on from the bound.
    heights = await link.checkAndRelayPacketsAndAcks(heights);
    expect(eth.scans).toHaveLength(3);
    eth.state.finalized += EPOCH;
    await link.checkAndRelayPacketsAndAcks(heights);
    expect(eth.scans).toHaveLength(4);
    expect(eth.scans[3]).toEqual([FINALIZED + 3 * EPOCH - 1, FINALIZED + 4 * EPOCH - 1]);
    expect(gno.received).toEqual([1]);
  });

  it("relays every packet once as the head and finality move", async () => {
    // A packet in every slot: whichever block a round's floor lands on
    // holds one.
    const sent = Array.from({
      length: 400,
    }, (_, i) => sentPacket(i + 1, FINALIZED + 1 + i));
    const eth = ethereumSource(FINALIZED, sent);
    const gno = gnoDestination(eth.client, FINALIZED);
    const link = new Link(gno.end, eth.end, logger);

    let heights: RelayedHeights = {
      packetHeightB: FINALIZED,
      ackHeightB: FINALIZED,
    };
    for (let round = 0; round < 12; round++) {
      heights = await link.checkAndRelayPacketsAndAcks(heights);
      eth.state.head += 40;
      // Finality stalls one round in three.
      if (round % 3 !== 2) {
        eth.state.finalized += EPOCH;
      }
    }

    // Every packet in a provable slot was received, in order, once.
    const provable = sent.filter(p => p.height < eth.state.finalized).map(p => Number(p.packet.sequence));
    expect(provable.length).toBeGreaterThan(200);
    expect(gno.received).toEqual(provable);
    // The scans tiled the chain, each starting where the last one ended,
    // and none read up to the head.
    expect(eth.scans.length).toBeGreaterThan(5);
    for (let i = 1; i < eth.scans.length; i++) {
      expect(eth.scans[i][0]).toBe(eth.scans[i - 1][1]);
    }
    expect(eth.scans.every(([, bound]) => bound !== undefined && bound < eth.state.head)).toBe(true);
    expect(eth.client.waitOneBlock).not.toHaveBeenCalled();
    expect(heights.packetHeightB).toBe(eth.state.finalized - 1);
  });

  it("keeps a floor past the provable header and scans on from it", async () => {
    // A floor recorded at the head, before scans were bounded: the slots
    // below it were read, and no scan may start below it.
    const eth = ethereumSource(FINALIZED, [sentPacket(1, FINALIZED + 80)]);
    const gno = gnoDestination(eth.client, FINALIZED);
    const link = new Link(gno.end, eth.end, logger);

    let heights = await link.checkAndRelayPacketsAndAcks({
      packetHeightB: FINALIZED + 70,
      ackHeightB: FINALIZED + 70,
    });
    expect(eth.scans).toEqual([]);
    expect(heights.packetHeightB).toBe(FINALIZED + 70);
    expect(heights.ackHeightB).toBe(FINALIZED + 70);

    eth.state.finalized += 3 * EPOCH;
    heights = await link.checkAndRelayPacketsAndAcks(heights);
    expect(eth.scans).toEqual([[FINALIZED + 70, FINALIZED + 3 * EPOCH - 1]]);
    expect(gno.received).toEqual([1]);
    expect(heights.packetHeightB).toBe(FINALIZED + 3 * EPOCH - 1);
  });
});
