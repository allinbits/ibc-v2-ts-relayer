/* eslint-disable max-lines -- one fixture set serves every relay-round scenario */
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

import {
  GnoIbcClient,
} from "../../clients/gno/IbcClient.js";
import {
  TendermintIbcClient,
} from "../../clients/tendermint/IbcClient.js";
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
function ethereumEnd(proofOffset = 0) {
  let finalized = FINALIZED_SLOT;
  const provedAt: number[] = [];
  const client = {
    chainId: "11155111",
    clientType: ClientType.Ethereum,
    revisionHeight: height,
    eventProofOffset: vi.fn(async () => proofOffset),
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

    await expect(link.relayAcks("B", [ack])).rejects.toThrow(/has not reached height 11406790/);
    expect(gno.client.updateClient).not.toHaveBeenCalled();
    expect(gno.client.acknowledgePacketsV2).not.toHaveBeenCalled();
  });

  it("proves the ack at its own slot before Gloas and needs the next one from Gloas on", async () => {
    // Finality reaching the ack's slot exactly, as it does when the ack's
    // block is the epoch's checkpoint.
    for (const [offset, needed] of [[0, ACK_SLOT], [1, ACK_SLOT + 1]]) {
      const eth = ethereumEnd(offset);
      const gno = gnoEnd(eth.client);
      eth.client.latestHeader.mockResolvedValue({
        height: ACK_SLOT,
      });
      // A wait advances finality past the ack.
      eth.client.waitOneBlock.mockImplementation(async () => {
        eth.client.latestHeader.mockResolvedValue({
          height: ACK_SLOT + SLOTS_PER_EPOCH,
        });
      });
      const link = new Link(gno.end, eth.end, logger);

      await link.relayAcks("B", [ack]);
      expect(eth.client.eventProofOffset).toHaveBeenCalledWith(ACK_SLOT);
      expect(eth.client.waitOneBlock).toHaveBeenCalledTimes(needed === ACK_SLOT ? 0 : 1);
      expect(eth.provedAt).toEqual([needed === ACK_SLOT ? ACK_SLOT : ACK_SLOT + SLOTS_PER_EPOCH]);
    }
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

const SLOT_SECONDS = 12;
/** The time of a slot, on a clock whose genesis is at 0. */
const slotTime = (slot: number) => slot * SLOT_SECONDS;

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
    eventProofOffset: vi.fn(async () => 0),
    currentHeight: vi.fn(async () => state.head),
    currentTime: vi.fn(async () => dateAt(slotTime(state.head))),
    timeoutHeight: vi.fn(async (blocks: number) => height(state.head + blocks)),
    latestHeader: vi.fn(async () => ({
      height: state.finalized,
      time: {
        seconds: BigInt(slotTime(state.finalized)),
        nanos: 0,
      },
    })),
    waitOneBlock: vi.fn(async () => {
      state.finalized += EPOCH;
    }),
    waitForIndexer: vi.fn(async () => {}),
    queryUnreceivedPacketsV2: vi.fn(async () => []),
    // Every packet it sent is still committed.
    queryUnreceivedAcksV2: vi.fn(async (_client: string, sequences: readonly bigint[]) => [...sequences]),
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
    currentTime: vi.fn(async () => dateAt(state.height)),
    timeoutHeight: vi.fn(async (blocks: number) => height(state.height + blocks)),
    latestHeader: vi.fn(async () => ({
      height: BigInt(state.height),
      time: {
        seconds: BigInt(state.height),
        nanos: 0,
      },
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
    queryUnreceivedPacketsV2: vi.fn(async (_client: string, sequences: readonly bigint[]) => sequences.filter(s => !received.includes(Number(s)))),
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

    // The packet's slot is past the finalized one: the scan reaches the
    // finalized slot, whose own events it proves, and the floor it hands
    // back is the bound it reached.
    let heights = await link.checkAndRelayPacketsAndAcks({
      packetHeightB: FINALIZED - 100,
      ackHeightB: FINALIZED - 100,
    });
    expect(eth.scans).toEqual([[FINALIZED - 100, FINALIZED]]);
    expect(gno.client.receivePacketsV2).not.toHaveBeenCalled();
    expect(heights.packetHeightB).toBe(FINALIZED);

    // Two epochs on, the slot is still not final.
    eth.state.finalized += 2 * EPOCH;
    heights = await link.checkAndRelayPacketsAndAcks(heights);
    expect(gno.client.receivePacketsV2).not.toHaveBeenCalled();
    expect(heights.packetHeightB).toBe(FINALIZED + 2 * EPOCH);

    // One more and it is: the round delivers it, proven at the finalized
    // slot the one update brought gno's client to, with no block waited.
    eth.state.finalized += EPOCH;
    heights = await link.checkAndRelayPacketsAndAcks(heights);
    expect(eth.scans).toHaveLength(3);
    expect(eth.scans[2]).toEqual([FINALIZED + 2 * EPOCH, FINALIZED + 3 * EPOCH]);
    expect(gno.received).toEqual([1]);
    expect(eth.client.waitOneBlock).not.toHaveBeenCalled();
    expect(gno.client.updateClient).toHaveBeenCalledTimes(1);
    const [, , proofHeight] = gno.client.receivePacketsV2.mock.calls[0];
    expect(Number(proofHeight.revisionHeight)).toBe(FINALIZED + 3 * EPOCH);
    expect(heights.packetHeightB).toBe(FINALIZED + 3 * EPOCH);

    // Once: with finality unmoved the next round has nothing to scan, and
    // the one after scans on from the bound.
    heights = await link.checkAndRelayPacketsAndAcks(heights);
    expect(eth.scans).toHaveLength(3);
    eth.state.finalized += EPOCH;
    await link.checkAndRelayPacketsAndAcks(heights);
    expect(eth.scans).toHaveLength(4);
    expect(eth.scans[3]).toEqual([FINALIZED + 3 * EPOCH, FINALIZED + 4 * EPOCH]);
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
    const provable = sent.filter(p => p.height <= eth.state.finalized).map(p => Number(p.packet.sequence));
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
    expect(heights.packetHeightB).toBe(eth.state.finalized);
  });

  it("relays an event in the finalized checkpoint's own block in the same round", async () => {
    const eth = ethereumSource(FINALIZED, [sentPacket(1, FINALIZED)]);
    const gno = gnoDestination(eth.client, FINALIZED - EPOCH);
    const link = new Link(gno.end, eth.end, logger);

    const heights = await link.checkAndRelayPacketsAndAcks({
      packetHeightB: FINALIZED - 10,
      ackHeightB: FINALIZED - 10,
    });
    expect(gno.received).toEqual([1]);
    const [, , proofHeight] = gno.client.receivePacketsV2.mock.calls[0];
    expect(Number(proofHeight.revisionHeight)).toBe(FINALIZED);
    expect(heights.packetHeightB).toBe(FINALIZED);
  });

  it("from Gloas on, leaves the finalized checkpoint's own block for the next finalized slot", async () => {
    const eth = ethereumSource(FINALIZED, [sentPacket(1, FINALIZED)]);
    eth.client.eventProofOffset.mockResolvedValue(1);
    const gno = gnoDestination(eth.client, FINALIZED - EPOCH);
    const link = new Link(gno.end, eth.end, logger);

    let heights = await link.checkAndRelayPacketsAndAcks({
      packetHeightB: FINALIZED - 10,
      ackHeightB: FINALIZED - 10,
    });
    expect(eth.scans).toEqual([[FINALIZED - 10, FINALIZED - 1]]);
    expect(gno.received).toEqual([]);
    expect(heights.packetHeightB).toBe(FINALIZED - 1);

    eth.state.finalized += EPOCH;
    heights = await link.checkAndRelayPacketsAndAcks(heights);
    expect(gno.received).toEqual([1]);
    const [, , proofHeight] = gno.client.receivePacketsV2.mock.calls[0];
    expect(Number(proofHeight.revisionHeight)).toBe(FINALIZED + EPOCH);
    expect(heights.packetHeightB).toBe(FINALIZED + EPOCH - 1);
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
    expect(eth.scans).toEqual([[FINALIZED + 70, FINALIZED + 3 * EPOCH]]);
    expect(gno.received).toEqual([1]);
    expect(heights.packetHeightB).toBe(FINALIZED + 3 * EPOCH);
  });
});

/*
 * The gno => Ethereum timeout path as it ran on Sepolia: a packet's timeout
 * passed on Sepolia's head, and the relay loop timed it out against that
 * head at once. But the proof of non-receipt is taken at the finalized
 * slot, 13 minutes behind the head, whose time was still before the
 * timeout, so gno's Ethereum client rejected the timeout: every round, for
 * a transaction's gas each, until finality caught up.
 */
const SENT_HEIGHT = 100;

/** A packet gno sent in the block at SENT_HEIGHT, timing out at `timeout`. */
function gnoPacket(sequence: number, timeout: number): PacketV2WithMetadata {
  return {
    packet: PacketV2.fromPartial({
      sequence: BigInt(sequence),
      sourceClient: "ethereum-1",
      destinationClient: "client-0",
      timeoutTimestamp: BigInt(timeout),
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
    height: SENT_HEIGHT,
  };
}

/** Router state as the latest block and the finalized one hold it. */
function routerState() {
  const state = {
    latest: new Set<bigint>(),
    finalized: new Set<bigint>(),
  };
  return {
    state,
    at: (tag: "latest" | "finalized" = "latest") => state[tag],
    /** Finality reaches the latest block. */
    finalize: () => {
      state.finalized = new Set(state.latest);
    },
    /** A reorg drops every block past the finalized one. */
    reorg: () => {
      state.latest = new Set(state.finalized);
    },
  };
}

/**
 * An Ethereum destination whose head and finalized slots move as a test
 * says. Its router's receipts, and the commitments of the packets it sent,
 * are read at the latest or the finalized block; its writes land in the
 * latest one only. Its proofs of non-receipt record the slot they were
 * taken at.
 */
function ethereumDestination(finalized: number) {
  const state = {
    head: finalized + 2 * EPOCH + 5,
    finalized,
    // How far the execution block a finalized slot commits to is behind the
    // slot's own time: 0 before Gloas, a slot or more from it on.
    execLag: 0,
  };
  /** The time gno's Ethereum client stores for a finalized slot. */
  const execTime = (slot: number) => slotTime(slot) - state.execLag;
  const receipts = routerState();
  const commitments = routerState();
  const provedAt: number[] = [];
  const client = {
    chainId: "11155111",
    clientType: ClientType.Ethereum,
    revisionHeight: height,
    eventProofOffset: vi.fn(async () => 0),
    execTime,
    currentHeight: vi.fn(async () => state.head),
    currentTime: vi.fn(async () => dateAt(slotTime(state.head))),
    timeoutHeight: vi.fn(async (blocks: number) => height(state.head + blocks)),
    latestHeader: vi.fn(async () => ({
      height: state.finalized,
      time: {
        seconds: BigInt(execTime(state.finalized)),
        nanos: 0,
      },
    })),
    waitOneBlock: vi.fn(async () => {
      state.head += 1;
    }),
    waitForIndexer: vi.fn(async () => {}),
    queryUnreceivedPacketsV2: vi.fn(async (_client: string, sequences: readonly bigint[], at?: "latest" | "finalized") =>
      sequences.filter(seq => !receipts.at(at).has(seq))),
    queryUnreceivedAcksV2: vi.fn(async (_client: string, sequences: readonly bigint[], at?: "latest" | "finalized") =>
      sequences.filter(seq => commitments.at(at).has(seq))),
    // gno's client on Ethereum already covers the packets' block.
    getLatestClientState: vi.fn(async () => ({
      lcType: "10-gno",
      latestHeight: height(SENT_HEIGHT + 1),
    })),
    receivePacketsV2: vi.fn(async (packets: readonly PacketV2[]) => {
      for (const p of packets) {
        receipts.state.latest.add(p.sequence);
      }
      return {
        events: [],
        transactionHash: "",
        height: 1,
      };
    }),
    acknowledgePacketsV2: vi.fn(async (acks: readonly AckV2WithMetadata[]) => {
      for (const a of acks) {
        commitments.state.latest.delete(a.originalPacket.sequence);
      }
      return {
        events: [],
        transactionHash: "",
        height: 1,
      };
    }),
    getTimeoutProofV2: vi.fn(async (_p: PacketV2, at: Height) => {
      provedAt.push(Number(at.revisionHeight));
      return {
        data: new Uint8Array(),
        proof: new Uint8Array(),
        proofHeight: at,
      };
    }),
  };
  const end = {
    clientID: "client-0",
    client,
    querySentPackets: vi.fn(async () => []),
    queryWrittenAcks: vi.fn(async () => []),
  } as unknown as BaseEndpoint;
  return {
    end,
    client,
    state,
    receipts,
    commitments,
    provedAt,
  };
}

/**
 * A gno source: its Ethereum client follows the destination's finality on
 * update, and it accepts a timeout as gno's core does, with a proof at a
 * slot its client knows whose time is not before the packet's timeout. It
 * may also have written acks, of packets the destination sent.
 */
function gnoSource(dest: ReturnType<typeof ethereumDestination>["client"], known: number, sent: PacketV2WithMetadata[], written: AckV2WithMetadata[] = []) {
  const state = {
    height: 200,
    known,
    // While set, every state query fails as an overloaded node does.
    unavailable: false,
  };
  const scans: [number | undefined, number | undefined][] = [];
  const timedOut: number[] = [];
  const available = () => {
    if (state.unavailable) {
      throw new Error("abci query: HTTP 503 Service Unavailable");
    }
  };
  const client = {
    chainId: "test-ibc-1",
    clientType: ClientType.Gno,
    revisionHeight: height,
    currentHeight: vi.fn(async () => state.height),
    currentTime: vi.fn(async () => dateAt(state.height)),
    timeoutHeight: vi.fn(async (blocks: number) => height(state.height + blocks)),
    latestHeader: vi.fn(async () => ({
      height: BigInt(state.height),
      time: {
        seconds: BigInt(state.height),
        nanos: 0,
      },
    })),
    waitForIndexer: vi.fn(async () => {}),
    queryUnreceivedPacketsV2: vi.fn(async () => {
      available();
      return [];
    }),
    // The packets it sent whose commitment is still there.
    queryUnreceivedAcksV2: vi.fn(async (_client: string, sequences: readonly bigint[]) => {
      available();
      return sequences.filter(seq => !timedOut.includes(Number(seq)));
    }),
    getLatestClientState: vi.fn(async () => ({
      lcType: "ethereum",
      forkParameters: {
      },
      latestHeight: height(state.known),
    })),
    getPacketProofV2: vi.fn(async (_p: PacketV2, at: Height) => ({
      data: new Uint8Array(),
      proof: new Uint8Array(),
      proofHeight: at,
    })),
    getAckProofV2: vi.fn(async (_p: PacketV2, at: Height) => ({
      data: new Uint8Array(),
      proof: new Uint8Array(),
      proofHeight: at,
    })),
    updateClient: vi.fn(async () => {
      state.known = (await dest.latestHeader()).height;
      return height(state.known);
    }),
    timeoutPacketsV2: vi.fn(async (packets: readonly PacketV2[], _proofs: readonly Uint8Array[], proofHeight: Height) => {
      const slot = Number(proofHeight.revisionHeight);
      if (slot > state.known) {
        throw new Error(`timeoutPacket x${packets.length}: ConsensusStateNotFound(${slot})`);
      }
      for (const p of packets) {
        // gno's Ethereum client checks the execution timestamp it stored.
        if (dest.execTime(slot) < Number(p.timeoutTimestamp)) {
          throw new Error(`timeoutPacket x${packets.length}: consensus state at slot ${slot} has timestamp ${dest.execTime(slot)}, before the packet's timeout ${p.timeoutTimestamp}`);
        }
        timedOut.push(Number(p.sequence));
      }
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
    querySentPackets: vi.fn(async (min: number | undefined, max: number | undefined) => {
      scans.push([min, max]);
      return sent.filter(({
        height: h,
      }) => (min === undefined || h > min) && (max === undefined || h <= max));
    }),
    queryWrittenAcks: vi.fn(async (min: number | undefined, max: number | undefined) => written.filter(({
      height: h,
    }) => (min === undefined || h > min) && (max === undefined || h <= max))),
  } as unknown as BaseEndpoint;
  return {
    end,
    client,
    state,
    scans,
    timedOut,
  };
}

describe("Link.checkAndRelayPacketsAndAcks timeouts on Ethereum", () => {
  const FINALIZED = 11407200;
  // Past the finalized slot's time, before the head's.
  const TIMEOUT = slotTime(FINALIZED + EPOCH);

  it("leaves a packet dead at the head and live at the finalized slot waiting, then times it out once", async () => {
    const eth = ethereumDestination(FINALIZED);
    const gno = gnoSource(eth.client, FINALIZED, [gnoPacket(1, TIMEOUT)]);
    const link = new Link(gno.end, eth.end, logger);
    const start: RelayedHeights = {
      packetHeightA: SENT_HEIGHT - 10,
      ackHeightA: SENT_HEIGHT - 10,
      packetHeightB: FINALIZED - 1,
      ackHeightB: FINALIZED - 1,
    };

    // The head is past the timeout, the finalized slot is not: nothing is
    // attempted, and the floor is held below the packet for the next round.
    let heights = await link.checkAndRelayPacketsAndAcks(start, 2, 6);
    expect(gno.scans).toEqual([[SENT_HEIGHT - 10, gno.state.height - 1]]);
    expect(eth.client.receivePacketsV2).not.toHaveBeenCalled();
    expect(eth.client.getTimeoutProofV2).not.toHaveBeenCalled();
    expect(gno.client.timeoutPacketsV2).not.toHaveBeenCalled();
    expect(gno.client.updateClient).not.toHaveBeenCalled();
    expect(heights.packetHeightA).toBe(SENT_HEIGHT - 1);
    expect(heights.ackHeightA).toBe(gno.state.height - 1);

    // Finality has not reached the timeout yet: the same, round after round.
    gno.state.height += 50;
    eth.state.head += 50;
    heights = await link.checkAndRelayPacketsAndAcks(heights, 2, 6);
    expect(gno.scans[1]).toEqual([SENT_HEIGHT - 1, gno.state.height - 1]);
    expect(gno.client.timeoutPacketsV2).not.toHaveBeenCalled();
    expect(heights.packetHeightA).toBe(SENT_HEIGHT - 1);

    // The finalized slot's time reaches the timeout: the packet is timed
    // out, with a proof at the finalized slot gno's client was updated to.
    eth.state.finalized += EPOCH;
    gno.state.height += 50;
    eth.state.head += 50;
    heights = await link.checkAndRelayPacketsAndAcks(heights, 2, 6);
    expect(gno.timedOut).toEqual([1]);
    expect(gno.client.timeoutPacketsV2).toHaveBeenCalledTimes(1);
    expect(eth.provedAt).toEqual([FINALIZED + EPOCH]);
    expect(gno.state.known).toBe(FINALIZED + EPOCH);
    expect(eth.client.receivePacketsV2).not.toHaveBeenCalled();
    expect(heights.packetHeightA).toBe(gno.state.height - 2);

    // Timed out, the packet has no commitment left: a later round that
    // scans its block again, from a floor below it, does not time it out
    // twice.
    gno.state.height += 50;
    await link.checkAndRelayPacketsAndAcks(heights, 2, 6);
    await link.checkAndRelayPacketsAndAcks({
      ...heights,
      packetHeightA: SENT_HEIGHT - 10,
    }, 2, 6);
    expect(gno.scans).toHaveLength(5);
    expect(gno.client.timeoutPacketsV2).toHaveBeenCalledTimes(1);
    expect(gno.timedOut).toEqual([1]);
  });

  it("delivers a packet live at the head and times out one dead at the finalized slot in the same round", async () => {
    const live = gnoPacket(1, slotTime(FINALIZED + 10 * EPOCH));
    const dead = gnoPacket(2, slotTime(FINALIZED));
    const waiting = gnoPacket(3, TIMEOUT);
    const eth = ethereumDestination(FINALIZED);
    const gno = gnoSource(eth.client, FINALIZED, [live, dead, waiting]);
    const link = new Link(gno.end, eth.end, logger);

    const heights = await link.checkAndRelayPacketsAndAcks({
      packetHeightA: SENT_HEIGHT - 10,
      ackHeightA: SENT_HEIGHT - 10,
      packetHeightB: FINALIZED - 1,
      ackHeightB: FINALIZED - 1,
    }, 2, 6);

    const [received] = eth.client.receivePacketsV2.mock.calls[0] as unknown as [readonly PacketV2[]];
    expect(received.map(p => Number(p.sequence))).toEqual([1]);
    expect(gno.timedOut).toEqual([2]);
    expect(eth.provedAt).toEqual([FINALIZED]);
    // The waiting packet holds the floor.
    expect(heights.packetHeightA).toBe(SENT_HEIGHT - 1);
  });
});

/*
 * Ethereum returns a write after one confirmation, long before finality. A
 * round used to move the floor past every packet it delivered there: a
 * reorg that dropped the receive (or the ack, or the timeout) left the
 * send event below every later floor, after a restart too, so the packet
 * was neither delivered again nor timed out.
 */
describe("Link.checkAndRelayPacketsAndAcks with Ethereum writes not final yet", () => {
  const FINALIZED = 11407200;
  const start: RelayedHeights = {
    packetHeightA: SENT_HEIGHT - 10,
    ackHeightA: SENT_HEIGHT - 10,
    packetHeightB: FINALIZED - 1,
    ackHeightB: FINALIZED - 1,
  };

  it("holds the floor below a packet received on Ethereum until the receipt is final, and delivers it again after a reorg", async () => {
    const eth = ethereumDestination(FINALIZED);
    const gno = gnoSource(eth.client, FINALIZED, [gnoPacket(1, slotTime(FINALIZED + 100 * EPOCH))]);

    let heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(start);
    expect(eth.client.receivePacketsV2).toHaveBeenCalledTimes(1);
    expect(heights.packetHeightA).toBe(SENT_HEIGHT - 1);

    // Received in the latest block only: not delivered twice, still held.
    gno.state.height += 5;
    heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(heights);
    expect(eth.client.receivePacketsV2).toHaveBeenCalledTimes(1);
    expect(heights.packetHeightA).toBe(SENT_HEIGHT - 1);

    // A reorg drops the receive: a restarted relayer delivers it again.
    eth.receipts.reorg();
    heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(heights);
    expect(eth.client.receivePacketsV2).toHaveBeenCalledTimes(2);
    expect(heights.packetHeightA).toBe(SENT_HEIGHT - 1);

    // Final, the receipt releases the floor.
    eth.receipts.finalize();
    gno.state.height += 5;
    heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(heights);
    expect(eth.client.receivePacketsV2).toHaveBeenCalledTimes(2);
    expect(heights.packetHeightA).toBe(gno.state.height - 1);
  });

  it("holds the ack floor below an ack Ethereum processed until that is final, and relays it again after a reorg", async () => {
    const eth = ethereumDestination(FINALIZED);
    // A packet Ethereum sent, whose ack gno wrote at SENT_HEIGHT.
    const sent = PacketV2.fromPartial({
      ...gnoPacket(7, slotTime(FINALIZED + 100 * EPOCH)).packet,
      sourceClient: "client-0",
      destinationClient: "ethereum-1",
    });
    eth.commitments.state.latest.add(7n);
    eth.commitments.finalize();
    const gno = gnoSource(eth.client, FINALIZED, [], [
      {
        acknowledgement: Uint8Array.from([1]),
        originalPacket: sent,
        height: SENT_HEIGHT,
        txHash: "",
        txEvents: [],
      },
    ]);

    let heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(start);
    expect(eth.client.acknowledgePacketsV2).toHaveBeenCalledTimes(1);
    expect(heights.ackHeightA).toBe(SENT_HEIGHT - 1);

    gno.state.height += 5;
    heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(heights);
    expect(eth.client.acknowledgePacketsV2).toHaveBeenCalledTimes(1);
    expect(heights.ackHeightA).toBe(SENT_HEIGHT - 1);

    eth.commitments.reorg();
    heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(heights);
    expect(eth.client.acknowledgePacketsV2).toHaveBeenCalledTimes(2);
    expect(heights.ackHeightA).toBe(SENT_HEIGHT - 1);

    eth.commitments.finalize();
    heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(heights);
    expect(eth.client.acknowledgePacketsV2).toHaveBeenCalledTimes(2);
    expect(heights.ackHeightA).toBe(gno.state.height - 1);
  });

  it("holds the floor below a packet timed out on Ethereum until the timeout is final, and times it out again after a reorg", async () => {
    const SENT_SLOT = FINALIZED - 5;
    const dead: PacketV2WithMetadata = {
      packet: PacketV2.fromPartial({
        ...sentPacket(1, SENT_SLOT).packet,
        timeoutTimestamp: 1000n,
      }),
      height: SENT_SLOT,
    };
    const eth = ethereumSource(FINALIZED, [dead]);
    const gno = gnoDestination(eth.client, FINALIZED);
    const commitments = routerState();
    commitments.state.latest.add(1n);
    commitments.finalize();
    eth.client.queryUnreceivedAcksV2.mockImplementation(async (_client: string, sequences: readonly bigint[], at?: "latest" | "finalized") =>
      sequences.filter(seq => commitments.at(at).has(seq)));
    const timeoutPacketsV2 = vi.fn(async (packets: readonly PacketV2[]) => {
      for (const p of packets) {
        commitments.state.latest.delete(p.sequence);
      }
      return {
        events: [],
        transactionHash: "",
        height: 1,
      };
    });
    Object.assign(eth.client, {
      // gno's client on Ethereum already covers gno's head.
      getLatestClientState: vi.fn(async () => ({
        lcType: "10-gno",
        latestHeight: height(gno.state.height),
      })),
      timeoutPacketsV2,
    });
    Object.assign(gno.client, {
      getTimeoutProofV2: vi.fn(async (_p: PacketV2, at: Height) => ({
        data: new Uint8Array(),
        proof: new Uint8Array(),
        proofHeight: at,
      })),
    });
    const from: RelayedHeights = {
      packetHeightB: FINALIZED - 10,
      ackHeightB: FINALIZED - 10,
    };

    let heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(from);
    expect(timeoutPacketsV2).toHaveBeenCalledTimes(1);
    expect(heights.packetHeightB).toBe(SENT_SLOT - 1);

    heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(heights);
    expect(timeoutPacketsV2).toHaveBeenCalledTimes(1);
    expect(heights.packetHeightB).toBe(SENT_SLOT - 1);

    commitments.reorg();
    heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(heights);
    expect(timeoutPacketsV2).toHaveBeenCalledTimes(2);
    expect(heights.packetHeightB).toBe(SENT_SLOT - 1);

    commitments.finalize();
    heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(heights);
    expect(timeoutPacketsV2).toHaveBeenCalledTimes(2);
    expect(heights.packetHeightB).toBe(FINALIZED);
  });
});

/*
 * The source's commitments decide which unreceived packets are still
 * pending. Reading them one at a time took any error for an absent
 * commitment: a 503 dropped a pending packet, and the round then saved a
 * floor past it, so no later round, after a restart neither, looked at it
 * again.
 */
describe("Link.checkAndRelayPacketsAndAcks when a commitment query fails", () => {
  const FINALIZED = 11407200;

  it("fails the round and keeps the floor, so a restarted relayer delivers the packet", async () => {
    const eth = ethereumDestination(FINALIZED);
    const gno = gnoSource(eth.client, FINALIZED, [gnoPacket(1, slotTime(FINALIZED + 100 * EPOCH))]);
    const stored: RelayedHeights = {
      packetHeightA: SENT_HEIGHT - 10,
      ackHeightA: SENT_HEIGHT - 10,
      packetHeightB: FINALIZED - 1,
      ackHeightB: FINALIZED - 1,
    };

    gno.state.unavailable = true;
    await expect(new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(stored)).rejects.toThrow(/503/);
    expect(eth.client.receivePacketsV2).not.toHaveBeenCalled();

    // The relayer restarts from the floor it had stored.
    gno.state.unavailable = false;
    await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(stored);
    expect(eth.client.receivePacketsV2).toHaveBeenCalledTimes(1);
  });
});

describe("Link timeouts and the header that classified them", () => {
  const FINALIZED = 11407200;

  it("refuses to prove a timeout below the header the packet timed out at", async () => {
    const eth = ethereumDestination(FINALIZED + EPOCH);
    const gno = gnoSource(eth.client, FINALIZED, [gnoPacket(1, slotTime(FINALIZED + EPOCH))]);
    // The round reads the finalized slot past the timeout, then a lagging
    // beacon node serves an older one.
    const stale = {
      height: FINALIZED,
      time: {
        seconds: BigInt(slotTime(FINALIZED)),
        nanos: 0,
      },
    };
    const fresh = await eth.client.latestHeader();
    eth.client.latestHeader.mockReset();
    eth.client.latestHeader.mockResolvedValueOnce(fresh).mockResolvedValueOnce(fresh).mockResolvedValue(stale);

    await expect(new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks({
      packetHeightA: SENT_HEIGHT - 10,
      ackHeightA: SENT_HEIGHT - 10,
      packetHeightB: FINALIZED - 1,
      ackHeightB: FINALIZED - 1,
    }, 2, 6)).rejects.toThrow(new RegExp(`has not reached height ${FINALIZED + EPOCH}`));
    expect(gno.client.updateClient).not.toHaveBeenCalled();
    expect(eth.client.getTimeoutProofV2).not.toHaveBeenCalled();
    expect(gno.client.timeoutPacketsV2).not.toHaveBeenCalled();
  });
});

/*
 * A Tendermint or gno waitOneBlock polls until the height moves: on a
 * halted chain, forever, so the cap on blocks waited never came into play.
 */
describe("Link.updateClientToHeight from a halted chain", () => {
  for (const [name, type, waitOneBlock] of [["gno", ClientType.Gno, GnoIbcClient.prototype.waitOneBlock], ["Tendermint", ClientType.Tendermint, TendermintIbcClient.prototype.waitOneBlock]] as const) {
    it(`gives up once the wait has taken its blocks' time on ${name}`, async () => {
      const halted = {
        chainId: "halted-1",
        clientType: type,
        estimatedBlockTime: 2,
        currentHeight: vi.fn(async () => 100),
        latestHeader: vi.fn(async () => ({
          height: 100,
        })),
        waitOneBlock,
      };
      const host = {
        chainId: "11155111",
        clientType: ClientType.Ethereum,
        getLatestClientState: vi.fn(async () => ({
          lcType: "10-gno",
          latestHeight: height(90),
        })),
        updateClient: vi.fn(),
      };
      const link = new Link({
        clientID: "client-0",
        client: halted,
      } as unknown as BaseEndpoint, {
        clientID: "client-1",
        client: host,
      } as unknown as BaseEndpoint, logger);

      const started = Date.now();
      await expect(link.updateClientToHeight("A", 101)).rejects.toThrow(/has not reached height 101/);
      // 150 blocks of 2ms, with room for a slow machine.
      expect(Date.now() - started).toBeLessThan(5000);
      expect(host.updateClient).not.toHaveBeenCalled();
    });
  }
});

describe("waitOneBlock", () => {
  for (const [name, waitOneBlock] of [["gno", GnoIbcClient.prototype.waitOneBlock], ["Tendermint", TendermintIbcClient.prototype.waitOneBlock]] as const) {
    it(`returns at the next block, or at the deadline, on ${name}`, async () => {
      let h = 100;
      const chain = {
        estimatedBlockTime: 1,
        currentHeight: vi.fn(async () => h),
      };
      const wait = waitOneBlock.bind(chain as never);

      // The height moves after a few polls.
      chain.currentHeight.mockImplementation(async () => (chain.currentHeight.mock.calls.length > 3 ? ++h : h));
      await wait();
      expect(h).toBe(101);

      // It never moves again: the deadline ends the wait.
      chain.currentHeight.mockImplementation(async () => h);
      const deadline = Date.now() + 20;
      await wait(deadline);
      expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    });
  }
});

/*
 * From Gloas on, the state a finalized slot commits to is the previous
 * execution payload's, a slot or more older than the slot, and gno's
 * Ethereum client checks a timeout against that payload's timestamp. A
 * timeout between the two used to be decided against the slot's time and
 * submitted too early, round after round.
 */
describe("Link timeouts on Ethereum from Gloas on", () => {
  const FINALIZED = 11407200;

  it("waits on a timeout between the execution timestamp and the slot's time", async () => {
    const eth = ethereumDestination(FINALIZED);
    eth.state.execLag = 12;
    const gno = gnoSource(eth.client, FINALIZED, [gnoPacket(1, slotTime(FINALIZED) - 6)]);
    const start: RelayedHeights = {
      packetHeightA: SENT_HEIGHT - 10,
      ackHeightA: SENT_HEIGHT - 10,
      packetHeightB: FINALIZED - 1,
      ackHeightB: FINALIZED - 1,
    };

    const heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(start, 2, 6);
    expect(gno.client.timeoutPacketsV2).not.toHaveBeenCalled();
    expect(heights.packetHeightA).toBe(SENT_HEIGHT - 1);

    eth.state.finalized += EPOCH;
    await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(heights, 2, 6);
    expect(gno.timedOut).toEqual([1]);
    expect(eth.provedAt).toEqual([FINALIZED + EPOCH]);
  });
});

describe("Link with gno render answers", () => {
  const FINALIZED = 11407200;
  const start: RelayedHeights = {
    packetHeightA: SENT_HEIGHT - 10,
    ackHeightA: SENT_HEIGHT - 10,
    packetHeightB: FINALIZED - 1,
    ackHeightB: FINALIZED - 1,
  };

  /** Has gno's client answer its commitment list from `answer`, through the real parsing. */
  function renders(client: ReturnType<typeof gnoSource>["client"], answer: () => string) {
    Object.assign(client, {
      queryUnreceivedAcksV2: GnoIbcClient.prototype.queryUnreceivedAcksV2,
      pagedAbciQuery: GnoIbcClient.prototype.pagedAbciQuery,
      openRenderList: GnoIbcClient.prototype.openRenderList,
      tm: {
        abciQuery: vi.fn(async () => ({
          responseBase: {
            data: Buffer.from(answer(), "utf-8"),
          },
        })),
      },
    });
  }

  it("fails the round on the realm's error answer and keeps the floor, so the packet is delivered later", async () => {
    const eth = ethereumDestination(FINALIZED);
    const gno = gnoSource(eth.client, FINALIZED, [gnoPacket(1, slotTime(FINALIZED + 100 * EPOCH))]);
    let answer = "{\"error\":\"client ethereum-1 not found\"}";
    renders(gno.client, () => answer);

    await expect(new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(start)).rejects.toThrow(/client ethereum-1 not found/);
    expect(eth.client.receivePacketsV2).not.toHaveBeenCalled();

    answer = "{\"items\":[{\"sequence\":\"1\",\"data\":\"oy\"}],\"page\":1,\"total\":1}";
    const heights = await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(start);
    expect(eth.client.receivePacketsV2).toHaveBeenCalledTimes(1);
    expect(heights.packetHeightA).toBe(SENT_HEIGHT - 1);
  });

  it("relays a packet whose sequence is past 2^53 under its own sequence", async () => {
    const SEQUENCE = 9007199254740993n;
    const eth = ethereumDestination(FINALIZED);
    const sent = gnoPacket(1, slotTime(FINALIZED + 100 * EPOCH));
    sent.packet = PacketV2.fromPartial({
      ...sent.packet,
      sequence: SEQUENCE,
    });
    const gno = gnoSource(eth.client, FINALIZED, [sent]);
    renders(gno.client, () => `{"items":[{"sequence":"${SEQUENCE}","data":"oy"}],"page":1,"total":1}`);

    await new Link(gno.end, eth.end, logger).checkAndRelayPacketsAndAcks(start);
    const [received] = eth.client.receivePacketsV2.mock.calls[0] as unknown as [readonly PacketV2[]];
    expect(received.map(p => p.sequence)).toEqual([SEQUENCE]);
    expect(eth.receipts.state.latest).toEqual(new Set([SEQUENCE]));
  });
});
