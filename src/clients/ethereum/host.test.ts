import {
  Acknowledgement, Packet as PacketV2,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  encodeAbiParameters, encodeEventTopics, Hex, toHex,
} from "viem";
import {
  describe, expect, it,
} from "vitest";

import {
  parseAcksFromTxEventsV2,
} from "../../utils/utils.js";
import {
  isGnoClientState, isGnoConsensusState,
} from "../BaseIbcClient.js";
import {
  iCS26RouterAbi,
} from "./artifacts/ICS26Router.js";
import {
  appAcknowledgement, toAbiPacket, toGnoClientState, toGnoConsensusState, writeAckEvents,
} from "./host.js";
import {
  getLogsChunked,
  MIN_LOG_CHUNK,
} from "./logs.js";

const ROUTER: Hex = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";

const packet = PacketV2.fromPartial({
  sequence: 7n,
  sourceClient: "ethereum-1",
  destinationClient: "client-0",
  timeoutTimestamp: 1_800_000_000n,
  payloads: [
    {
      sourcePort: "transfer",
      destinationPort: "transfer",
      version: "ics20-1",
      encoding: "application/x-solidity-abi",
      value: Uint8Array.from([1, 2, 3]),
    },
  ],
});

/** A WriteAcknowledgement log as ICS26Router emits it. */
function writeAckLog(acks: Uint8Array[]) {
  const ev = iCS26RouterAbi.find(x => x.type === "event" && x.name === "WriteAcknowledgement");
  if (!ev || ev.type !== "event") {
    throw new Error("no WriteAcknowledgement in the router ABI");
  }
  const topics = encodeEventTopics({
    abi: [ev],
    eventName: "WriteAcknowledgement",
    args: {
      clientId: "client-0",
      sequence: 7n,
    },
  } as never) as Hex[];
  const data = encodeAbiParameters(
    ev.inputs.filter(i => !i.indexed),
    [toAbiPacket(packet), acks.map(a => toHex(a))] as never,
  );
  return {
    address: ROUTER,
    data,
    topics,
  };
}

describe("Ethereum host", () => {
  it("turns WriteAcknowledgement logs into the events link.ts parses", () => {
    const appAck = new TextEncoder().encode("{\"result\":\"AQ==\"}");
    const events = writeAckEvents([writeAckLog([appAck])], ROUTER);
    const acks = parseAcksFromTxEventsV2(events);
    expect(acks).toHaveLength(1);
    expect(PacketV2.toJSON(acks[0].originalPacket)).toEqual(PacketV2.toJSON(packet));
    // encoded like the gno core's write_acknowledgement: protobuf Acknowledgement
    expect(Acknowledgement.decode(acks[0].acknowledgement).appAcknowledgements).toEqual([appAck]);
    // and back to the app ack the router's ackPacket wants
    expect(appAcknowledgement(acks[0].acknowledgement)).toEqual(appAck);
  });

  it("ignores logs of other contracts", () => {
    const log = writeAckLog([Uint8Array.of(1)]);
    expect(writeAckEvents([
      {
        ...log,
        address: "0x0000000000000000000000000000000000000001",
      },
    ], ROUTER)).toEqual([]);
  });

  it("passes raw app acks through", () => {
    const raw = new TextEncoder().encode("{\"result\":\"AQ==\"}");
    expect(appAcknowledgement(raw)).toEqual(raw);
  });

  it("refuses acknowledgements of several payloads", () => {
    const multi = Acknowledgement.encode(Acknowledgement.fromPartial({
      appAcknowledgements: [Uint8Array.of(1), Uint8Array.of(2)],
    })).finish();
    expect(() => appAcknowledgement(multi)).toThrow(/one payload per packet/);
  });

  it("presents GnoLightClient's states as gno client states", () => {
    const cs = toGnoClientState({
      chainId: "gno-eth-dev",
      revisionNumber: 0n,
      latestHeight: 42n,
      trustLevel: {
        numerator: 1n,
        denominator: 3n,
      },
      trustingPeriod: 1_209_600n,
      maxClockDrift: 20n,
      isFrozen: false,
    });
    expect(isGnoClientState(cs)).toBe(true);
    expect(cs.latestHeight.revisionHeight).toBe(42n);
    expect(cs.frozenHeight).toBeUndefined();
    const cons = toGnoConsensusState({
      timestamp: 1_767_225_600_123_456_789n,
      appHash: `0x${"11".repeat(32)}`,
      nextValidatorsHash: `0x${"22".repeat(32)}`,
    });
    expect(isGnoConsensusState(cons)).toBe(true);
    expect(cons.timestamp.seconds).toBe(1_767_225_600n);
    expect(cons.timestamp.nanos).toBe(123_456_789);
    expect(cons.root.hash).toEqual(new Uint8Array(32).fill(0x11));
  });
});

describe("getLogsChunked", () => {
  /** A node that refuses any range wider than `max` blocks, as public Sepolia RPCs do. */
  function node(max: bigint) {
    const ranges: [bigint, bigint][] = [];
    const request = async (from: bigint, to: bigint) => {
      if (to - from + 1n > max) {
        throw new Error("getLogs request exceeded max allowed range");
      }
      ranges.push([from, to]);
      return [`${from}-${to}`];
    };
    return {
      request,
      ranges,
    };
  }

  it("covers the whole range once, in chunks the node accepts", async () => {
    const n = node(10_000n);
    const logs = await getLogsChunked(n.request, 11_964_087n, 12_000_000n);
    expect(n.ranges[0]).toEqual([11_964_087n, 11_964_087n + 6_250n - 1n]);
    let next = 11_964_087n;
    for (const [from, to] of n.ranges) {
      expect(from).toBe(next);
      expect(to - from + 1n).toBeLessThanOrEqual(10_000n);
      next = to + 1n;
    }
    expect(next).toBe(12_000_001n);
    expect(logs).toHaveLength(n.ranges.length);
  });

  it("asks for one range when the node takes it whole", async () => {
    const n = node(1_000_000n);
    await getLogsChunked(n.request, 0n, 49_999n);
    expect(n.ranges).toEqual([[0n, 49_999n]]);
  });

  it("gives up only below the smallest chunk", async () => {
    const n = node(MIN_LOG_CHUNK - 1n);
    await expect(getLogsChunked(n.request, 0n, 5_000n)).rejects.toThrow("exceeded max allowed range");
    expect(n.ranges).toEqual([]);
  });

  it("scans nothing past the tip", async () => {
    const n = node(1_000_000n);
    expect(await getLogsChunked(n.request, 10n, 9n)).toEqual([]);
    expect(n.ranges).toEqual([]);
  });
});
