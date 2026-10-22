import {
  describe, expect, it, vi,
} from "vitest";

import type {
  LightClientUpdate,
} from "./beacon.js";
import type {
  EthereumIbcClient,
} from "./IbcClient.js";
import {
  latestHeader,
} from "./source.js";

const executionHeader = vi.hoisted(() => vi.fn());
vi.mock("./execution.js", async importOriginal => ({
  ...await importOriginal<typeof import("./execution.js")>(),
  executionHeader,
}));

// Sepolia's timing: genesis 1655733600, 12 s slots.
const SLOT = 11407232;
const SLOT_TIME = 1655733600 + SLOT * 12;

function client(finalized: LightClientUpdate["finalized_header"]) {
  return {
    publicClient: {
    },
    beacon: {
      finalityUpdate: vi.fn(async () => ({
        finalized_header: finalized,
      })),
    },
  } as unknown as EthereumIbcClient;
}

/*
 * gno's Ethereum client stores, for a finalized slot, the timestamp of the
 * execution block its beacon block commits to, and checks timeouts against
 * it. Before Gloas that block is the slot's own payload; from Gloas on it
 * is the previous one, a slot or more earlier than the slot's time.
 */
describe("latestHeader", () => {
  it("dates a pre-Gloas finalized slot by its execution payload", async () => {
    const c = client({
      beacon: {
        slot: String(SLOT),
      },
      execution: {
        timestamp: String(SLOT_TIME),
      },
    } as unknown as LightClientUpdate["finalized_header"]);
    await expect(latestHeader(c)).resolves.toEqual({
      height: SLOT,
      time: {
        seconds: BigInt(SLOT_TIME),
        nanos: 0,
      },
    });
    expect(executionHeader).not.toHaveBeenCalled();
  });

  it("dates a Gloas finalized slot by the execution block it commits to, not by the slot", async () => {
    const HASH = `0x${"ab".repeat(32)}`;
    executionHeader.mockResolvedValue({
      timestamp: BigInt(SLOT_TIME - 12),
    });
    const c = client({
      beacon: {
        slot: String(SLOT),
      },
      execution_block_hash: HASH,
    } as unknown as LightClientUpdate["finalized_header"]);

    const h = await latestHeader(c);
    expect(h.time.seconds).toBe(BigInt(SLOT_TIME - 12));
    expect(executionHeader).toHaveBeenCalledWith(c.publicClient, HASH);
    // A finalized block never changes: it is fetched once.
    await latestHeader(c);
    expect(executionHeader).toHaveBeenCalledTimes(1);
  });
});
