import {
  describe, expect, it, vi,
} from "vitest";

import {
  TendermintIbcClient,
} from "./IbcClient.js";

/** A Tendermint client whose node is at `height` and whose event index has blocks through `indexed`. */
function node(height: number, indexed: number | undefined, earliest?: number) {
  const blockSearch = vi.fn(async () => ({
    blocks: indexed === undefined
      ? []
      : [
        {
          block: {
            header: {
              height: indexed,
            },
          },
        },
      ],
    totalCount: indexed === undefined ? 0 : 1,
  }));
  const client = Object.assign(Object.create(TendermintIbcClient.prototype) as TendermintIbcClient, {
    chainId: "test-1",
    currentHeight: vi.fn(async () => height),
    tm: {
      blockSearch,
      status: vi.fn(async () => ({
        syncInfo: {
          earliestBlockHeight: earliest,
        },
      })),
    },
  });
  return {
    client,
    blockSearch,
  };
}

/*
 * tx_search and block_search read an index the node fills after each
 * commit, asynchronously: a node at 102 whose index has reached block 100
 * holds the transactions through 99 only, and a scan to 101 missed the
 * events at 100 for good.
 */
describe("TendermintIbcClient.scanHorizon", () => {
  it("is the block before the latest indexed one, not the node's height", async () => {
    const {
      client, blockSearch,
    } = node(102, 100);
    await expect(client.scanHorizon()).resolves.toBe(99);
    expect(blockSearch).toHaveBeenCalledWith({
      query: "block.height >= 1",
      order_by: "desc",
      page: 1,
      per_page: 1,
    });
  });

  it("looks only at the latest blocks", async () => {
    const {
      client, blockSearch,
    } = node(5000, 4990);
    await expect(client.scanHorizon()).resolves.toBe(4989);
    expect(blockSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: "block.height >= 4000",
    }));
  });

  it("fails when none of the latest blocks is indexed", async () => {
    const {
      client,
    } = node(5000, undefined);
    await expect(client.scanHorizon()).rejects.toThrow(/indexer lags or is off/);
  });
});

describe("TendermintIbcClient.earliestAvailableHeight", () => {
  it("is the node's earliest block", async () => {
    await expect(node(100, 99, 25).client.earliestAvailableHeight()).resolves.toBe(25);
    await expect(node(100, 99).client.earliestAvailableHeight()).resolves.toBeUndefined();
  });
});
