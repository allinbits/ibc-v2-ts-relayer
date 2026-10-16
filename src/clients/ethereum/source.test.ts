import {
  describe, expect, it,
} from "vitest";

import type {
  LightClientUpdate,
} from "./beacon.js";
import {
  planUpdates,
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
