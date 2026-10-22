import {
  keccak256,
} from "viem";
import {
  describe, expect, it,
} from "vitest";

import type {
  LightClientUpdate,
} from "./beacon.js";
import {
  packetPath,
} from "./execution.js";
import type {
  EthereumIbcClient,
} from "./IbcClient.js";
import {
  eventProofOffset, finalizedSnapshot, planUpdates, querySentPacketsV2, queryUnreceivedAcksV2, queryUnreceivedPacketsV2, queryWrittenAcksV2, scanHorizon,
} from "./source.js";

// Slots per sync committee period in these tests.
const PERIOD = 64n;

// An update with only the fields planUpdates reads.
function update(finalized: bigint, signature: bigint, withNext: boolean): LightClientUpdate {
  return {
    attested_header: {
      beacon: {
        slot: String(signature - 1n),
      },
    },
    finalized_header: {
      beacon: {
        slot: String(finalized),
      },
    },
    next_sync_committee: withNext
      ? {
        pubkeys: [],
        aggregate_pubkey: "0x",
      }
      : undefined,
    signature_slot: String(signature),
  } as unknown as LightClientUpdate;
}

function beacon(byPeriod: Record<string, LightClientUpdate>) {
  return {
    updates: async (start: bigint, count: number) => {
      expect(count).toBe(1);
      const u = byPeriod[String(start)];
      return u ? [u] : [];
    },
  };
}

describe("planUpdates", () => {
  it("submits the finality update when the next committee is known", async () => {
    const fin = update(100n, 110n, false);
    const plan = await planUpdates(beacon({
    }), PERIOD, fin, 80n, true);
    expect(plan.map(s => [s.update, s.trustedSlot, s.isNext])).toEqual([[fin, 80n, false]]);
  });

  it("crosses a rotation with the finality update, signed by the next committee", async () => {
    const fin = update(130n, 140n, false);
    const plan = await planUpdates(beacon({
    }), PERIOD, fin, 100n, true);
    expect(plan).toHaveLength(1);
    expect(plan[0].isNext).toBe(true);
    expect(plan[0].signingPeriod).toBe(2n);
  });

  it("learns the next committee first, then follows finality", async () => {
    const reveal = update(140n, 150n, true);
    const fin = update(160n, 170n, false);
    const plan = await planUpdates(beacon({
      2: reveal,
    }), PERIOD, fin, 130n, false);
    expect(plan.map(s => [s.update, s.trustedSlot])).toEqual([[reveal, 130n], [fin, 140n]]);
  });

  // After a rotation the client does not know the next committee; the update
  // revealing it may already finalize the finality update's slot, and then
  // that finality update must not follow it: the client refuses an update
  // that does not advance finality.
  it("stops when the committee update already reaches finality", async () => {
    const reveal = update(160n, 170n, true);
    const fin = update(160n, 171n, false);
    const plan = await planUpdates(beacon({
      2: reveal,
    }), PERIOD, fin, 130n, false);
    expect(plan.map(s => s.update)).toEqual([reveal]);
  });

  it("does nothing when finality has not advanced", async () => {
    const plan = await planUpdates(beacon({
    }), PERIOD, update(100n, 110n, false), 100n, true);
    expect(plan).toEqual([]);
  });

  it("steps period by period when several behind", async () => {
    const p2 = update(140n, 150n, true);
    const fin = update(200n, 210n, false);
    const plan = await planUpdates(beacon({
      2: p2,
    }), PERIOD, fin, 100n, true);
    expect(plan.map(s => [s.update, s.signingPeriod, s.isNext])).toEqual([[p2, 2n, true], [fin, 3n, true]]);
  });
});

/*
 * The router's packet events are read by block over a window of slots the
 * link hands down, (floor, bound]. Block numbers drift from slots at every
 * missed slot, so a window's blocks are found by timestamp.
 */
const GENESIS = 1655733600n;
// Slot 105 has no block: block n sits at slot n below it, at slot n + 1 from it.
const MISSED_SLOT = 105n;
const slotOf = (block: bigint): bigint => block >= MISSED_SLOT ? block + 1n : block;

function sendPacketLog(blockNumber: bigint) {
  return {
    blockNumber,
    args: {
      packet: {
        sequence: 1n,
        sourceClient: "client-0",
        destClient: "ethereum-1",
        timeoutTimestamp: 4102444800n,
        payloads: [],
      },
    },
  };
}

/** A chain of latest + 1 blocks whose router logs are all in `logs`. */
function source(latest: bigint, fromBlock?: string, logs: ReturnType<typeof sendPacketLog>[] = []) {
  const scanned: [bigint, bigint][] = [];
  const c = {
    config: {
      router: "0x6a1E8C6F167006dE6d95fE05e930765d0EA9f49d",
      fromBlock,
    },
    beacon: {
      genesis: async () => ({
        genesis_time: GENESIS.toString(),
        genesis_validators_root: "0x",
        genesis_fork_version: "0x90000069",
      }),
      spec: async () => ({
        SECONDS_PER_SLOT: "12",
        SLOTS_PER_EPOCH: "32",
        EPOCHS_PER_SYNC_COMMITTEE_PERIOD: "256",
        SYNC_COMMITTEE_SIZE: "512",
      }),
    },
    publicClient: {
      getBlock: async (args?: {
        blockNumber?: bigint
      }) => {
        const number = args?.blockNumber ?? latest;
        return {
          number,
          timestamp: GENESIS + slotOf(number) * 12n,
        };
      },
      getBlockNumber: async () => latest,
      getContractEvents: async ({
        fromBlock, toBlock,
      }: {
        fromBlock: bigint
        toBlock: bigint
      }) => {
        scanned.push([fromBlock, toBlock]);
        return logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      },
    },
  } as unknown as EthereumIbcClient;
  return {
    c,
    scanned,
  };
}

describe("querySentPacketsV2", () => {
  it("scans the blocks of (floor, bound], found by timestamp across a missed slot", async () => {
    const {
      c, scanned,
    } = source(200n);
    await querySentPacketsV2(c, "client-0", 100, 110);
    // Slots 101 to 110; with slot 105 missed, block 109 holds slot 110.
    expect(scanned).toEqual([[101n, 109n]]);
  });

  it("tiles consecutive windows with no block between them", async () => {
    const {
      c, scanned,
    } = source(200n);
    await querySentPacketsV2(c, "client-0", 100, 110);
    await querySentPacketsV2(c, "client-0", 110, 120);
    expect(scanned).toEqual([[101n, 109n], [110n, 119n]]);
  });

  it("scans nothing when the bound is not past the floor", async () => {
    const {
      c, scanned,
    } = source(200n);
    await expect(querySentPacketsV2(c, "client-0", 110, 110)).resolves.toEqual([]);
    expect(scanned).toEqual([]);
  });

  it("scans to the latest block without a bound", async () => {
    const {
      c, scanned,
    } = source(200n);
    await querySentPacketsV2(c, "client-0", 100, undefined);
    expect(scanned).toEqual([[101n, 200n]]);
  });

  it("starts at the deployment block without a floor", async () => {
    const {
      c, scanned,
    } = source(200n, "150");
    await querySentPacketsV2(c, "client-0", undefined, 160);
    // Slot 160 is block 159, past the missed slot.
    expect(scanned).toEqual([[150n, 159n]]);
  });

  it("refuses a window past the execution RPC's head rather than end it there", async () => {
    // Block 100 is at slot 100, the head; finality may stand past it.
    const {
      c, scanned,
    } = source(100n);
    await expect(scanHorizon(c)).resolves.toBe(100);
    await expect(querySentPacketsV2(c, "client-0", 90, 110)).rejects.toThrow(/at slot 100, not yet at 110/);
    await expect(queryWrittenAcksV2(c, "client-0", 90, 110)).rejects.toThrow(/at slot 100, not yet at 110/);
    expect(scanned).toEqual([]);
    await querySentPacketsV2(c, "client-0", 90, 100);
    expect(scanned).toEqual([[91n, 100n]]);
  });

  it("derives and checks the range from one read of the head", async () => {
    // The head read first is block 120; a second read, from a lagging node
    // behind the same RPC URL, would be block 100.
    const {
      c, scanned,
    } = source(120n);
    const getBlock = c.publicClient.getBlock.bind(c.publicClient);
    let headReads = 0;
    Object.assign(c.publicClient, {
      getBlock: async (args?: {
        blockNumber?: bigint
      }) => {
        if (args?.blockNumber === undefined) {
          headReads++;
          return getBlock(headReads === 1
            ? undefined
            : {
              blockNumber: 100n,
            });
        }
        return getBlock(args);
      },
    });
    await querySentPacketsV2(c, "client-0", 100, 115);
    // Slots 101 to 115 are blocks 101 to 114, past the missed slot.
    expect(scanned).toEqual([[101n, 114n]]);
    expect(headReads).toBe(1);
  });

  it("reports a packet at the slot of its block", async () => {
    const {
      c,
    } = source(200n, undefined, [sendPacketLog(109n)]);
    const packets = await querySentPacketsV2(c, "client-0", 100, 110);
    expect(packets.map(p => [Number(p.packet.sequence), p.height])).toEqual([[1, 110]]);
  });
});

/** A client whose beacon spec schedules Gloas at gloasEpoch, if given. */
function forkSchedule(gloasEpoch?: number) {
  return {
    beacon: {
      genesis: async () => ({
        genesis_time: GENESIS.toString(),
        genesis_validators_root: "0x",
        genesis_fork_version: "0x90000069",
      }),
      spec: async () => ({
        SECONDS_PER_SLOT: "12",
        SLOTS_PER_EPOCH: "32",
        EPOCHS_PER_SYNC_COMMITTEE_PERIOD: "256",
        SYNC_COMMITTEE_SIZE: "512",
        ...(gloasEpoch === undefined
          ? {
          }
          : {
            GLOAS_FORK_VERSION: "0x90000075",
            GLOAS_FORK_EPOCH: String(gloasEpoch),
          }),
      }),
    },
  } as unknown as EthereumIbcClient;
}

/*
 * Before Gloas a finalized beacon block commits to its own slot's execution
 * payload, whose state root gno's Ethereum client stores for the slot: an
 * event in the block at slot S is proven at S. From Gloas on it commits to
 * the latest payload before it (its bid's parent_block_hash), so the event
 * needs a slot past S.
 */
describe("eventProofOffset", () => {
  it("proves an event at its own slot while Gloas is unscheduled", async () => {
    const c = forkSchedule();
    await expect(eventProofOffset(c, 11407273)).resolves.toBe(0);
  });

  it("proves an event a slot later from the Gloas fork epoch on", async () => {
    const c = forkSchedule(10);
    await expect(eventProofOffset(c, 10 * 32 - 1)).resolves.toBe(0);
    await expect(eventProofOffset(c, 10 * 32)).resolves.toBe(1);
    await expect(eventProofOffset(c, 10 * 32 + 1000)).resolves.toBe(1);
  });
});

describe("router state reads", () => {
  /** A router whose commitments differ between the latest and the finalized block. */
  function router(latest: Record<string, string>, finalized: Record<string, string>) {
    const tags: (string | bigint | undefined)[] = [];
    const c = {
      config: {
        router: "0x6a1E8C6F167006dE6d95fE05e930765d0EA9f49d",
      },
      publicClient: {
        readContract: async ({
          args, blockTag, blockNumber,
        }: {
          args: [`0x${string}`]
          blockTag?: string
          blockNumber?: bigint
        }) => {
          tags.push(blockTag ?? blockNumber);
          // Block 7 is the finalized one.
          const state = blockNumber === 7n ? finalized : latest;
          return state[args[0]] ?? ZERO_WORD;
        },
        getBlock: async ({
          blockTag,
        }: {
          blockTag: string
        }) => {
          expect(blockTag).toBe("finalized");
          return {
            number: 7n,
            timestamp: GENESIS + 70n * 12n,
          };
        },
      },
      beacon: forkSchedule().beacon,
    } as unknown as EthereumIbcClient;
    return {
      c,
      tags,
    };
  }
  const ZERO_WORD = `0x${"00".repeat(32)}`;
  const SET = `0x${"11".repeat(32)}`;
  const key = (type: 1 | 2 | 3, seq: bigint) => keccak256(packetPath("client-0", type, seq));

  it("reads a receipt at the latest or the finalized block", async () => {
    // Packet 1's receipt is final, packet 2's only in the latest block.
    const {
      c, tags,
    } = router({
      [key(2, 1n)]: SET,
      [key(2, 2n)]: SET,
    }, {
      [key(2, 1n)]: SET,
    });
    await expect(queryUnreceivedPacketsV2(c, "client-0", [1n, 2n, 3n])).resolves.toEqual([3n]);
    const snapshot = await finalizedSnapshot(c);
    expect(snapshot).toEqual({
      number: 7n,
      slot: 70,
    });
    await expect(queryUnreceivedPacketsV2(c, "client-0", [1n, 2n, 3n], snapshot.number)).resolves.toEqual([2n, 3n]);
    expect(tags).toEqual(["latest", "latest", "latest", 7n, 7n, 7n]);
  });

  it("reads a commitment at the latest or the finalized block", async () => {
    // Packet 1's commitment was cleared, by an ack or a timeout not final yet.
    const {
      c,
    } = router({
    }, {
      [key(1, 1n)]: SET,
    });
    await expect(queryUnreceivedAcksV2(c, "client-0", [1n])).resolves.toEqual([]);
    await expect(queryUnreceivedAcksV2(c, "client-0", [1n], 7n)).resolves.toEqual([1n]);
  });

  it("propagates a failed read rather than take it for an absent commitment", async () => {
    const c = {
      config: {
        router: "0x6a1E8C6F167006dE6d95fE05e930765d0EA9f49d",
      },
      publicClient: {
        readContract: async () => {
          throw new Error("HTTP request failed. Status: 503");
        },
      },
    } as unknown as EthereumIbcClient;
    await expect(queryUnreceivedAcksV2(c, "client-0", [1n])).rejects.toThrow(/503/);
  });
});
