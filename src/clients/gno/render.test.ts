import {
  describe, expect, it, vi,
} from "vitest";

import {
  ClientType,
} from "../../types/index.js";
import {
  GnoIbcClient,
} from "./IbcClient.js";
import {
  parseRenderPage, renderedCommitment, renderedConsensusState, renderedSequences,
} from "./render.js";

const Q = "gno.land/r/aib/ibc/core:clients/ethereum-1/packet_commitments?limit=100&page=1";

describe("parseRenderPage", () => {
  it("reads a well-formed page, an empty one included", () => {
    expect(parseRenderPage("{\"items\":[],\"page\":1,\"total\":1}", Q, 1)).toEqual({
      items: [],
      total: 1,
    });
    expect(parseRenderPage("{\"items\":[{\"sequence\":\"1\",\"data\":\"oy\"}],\"page\":2,\"total\":3}", Q, 2).items).toHaveLength(1);
  });

  it("refuses the realm's error answer, as gno renders it for an unknown client", () => {
    expect(() => parseRenderPage("{\"error\":\"client ethereum-1 not found\"}", Q, 1)).toThrow(/client ethereum-1 not found/);
  });

  it("refuses every other shape", () => {
    for (const raw of ["{\"items\":[],\"page\":1,\"total\":0}", "{\"items\":[],\"page\":3,\"total\":2}", "", "not json", "null", "[]", "1", "\"x\"", "{}", "{\"items\":null,\"page\":1,\"total\":1}", "{\"items\":[],\"total\":1}", "{\"items\":[],\"page\":2,\"total\":1}", "{\"items\":[],\"page\":1,\"total\":-1}", "{\"items\":[],\"page\":1,\"total\":\"1\"}", "{\"items\":[],\"page\":1,\"total\":1.5}"]) {
      expect(() => parseRenderPage(raw, Q, 1), raw).toThrow();
    }
  });
});

describe("renderedSequences", () => {
  it("keeps a uint64 sequence exact", () => {
    expect(renderedSequences([
      {
        sequence: "9007199254740993",
      },
      {
        sequence: "18446744073709551615",
      },
    ], Q)).toEqual(new Set([9007199254740993n, 18446744073709551615n]));
  });

  it("refuses an item without a decimal sequence", () => {
    for (const item of [
      null,
      {
      },
      {
        sequence: 1,
      },
      {
        sequence: "-1",
      },
      {
        sequence: "0x1",
      },
    ]) {
      expect(() => renderedSequences([item], Q)).toThrow();
    }
  });
});

/** A gno client whose node answers each render query from `answer`. */
function gno(answer: (query: string, height?: number) => string, height = 500) {
  const queries: [string, number | undefined][] = [];
  const client = Object.assign(Object.create(GnoIbcClient.prototype) as GnoIbcClient, {
    currentHeight: vi.fn(async () => height),
    tm: {
      abciQuery: vi.fn(async ({
        data, height: at,
      }: {
        data: Uint8Array
        height?: number
      }) => {
        const query = Buffer.from(data).toString("utf-8");
        queries.push([query, at]);
        return {
          responseBase: {
            error: undefined,
            data: Buffer.from(answer(query, at), "utf-8"),
          },
        };
      }),
    },
  });
  return {
    client,
    queries,
  };
}

describe("GnoIbcClient render queries", () => {
  it("fails on the realm's error answer instead of taking it for an empty list", async () => {
    const {
      client,
    } = gno(() => "{\"error\":\"client ethereum-1 not found\"}");
    await expect(client.queryUnreceivedAcksV2("ethereum-1", [1n])).rejects.toThrow(/client ethereum-1 not found/);
    await expect(client.queryUnreceivedPacketsV2("ethereum-1", [1n])).rejects.toThrow(/client ethereum-1 not found/);
  });

  it("answers an empty list only for a well-formed empty page", async () => {
    const {
      client,
    } = gno(() => "{\"items\":[],\"page\":1,\"total\":1}");
    await expect(client.queryUnreceivedAcksV2("ethereum-1", [1n])).resolves.toEqual([]);
    await expect(client.queryUnreceivedPacketsV2("ethereum-1", [1n])).resolves.toEqual([1n]);
  });

  it("keeps sequences past 2^53 exact", async () => {
    const {
      client,
    } = gno(() => "{\"items\":[{\"sequence\":\"9007199254740993\",\"data\":\"oy\"}],\"page\":1,\"total\":1}");
    await expect(client.queryUnreceivedAcksV2("ethereum-1", [9007199254740992n, 9007199254740993n])).resolves.toEqual([9007199254740993n]);
    await expect(client.queryUnreceivedPacketsV2("ethereum-1", [9007199254740992n, 9007199254740993n])).resolves.toEqual([9007199254740992n]);
  });

  it("reads every page with the query's own separator, all at one height", async () => {
    const {
      client, queries,
    } = gno((query) => {
      const page = Number(/page=(\d+)/.exec(query)?.[1]);
      return JSON.stringify({
        items: [
          {
            sequence: String(page),
          },
        ],
        page,
        total: 3,
      });
    });
    await expect(client.queryUnreceivedAcksV2("ethereum-1", [1n, 2n, 3n, 4n])).resolves.toEqual([1n, 2n, 3n]);
    const base = "gno.land/r/aib/ibc/core:clients/ethereum-1/packet_commitments?limit=100";
    expect(queries).toEqual([[`${base}&page=1`, undefined], [`${base}&page=1`, 500], [`${base}&page=2`, 500], [`${base}&page=3`, 500]]);
  });

  it("fails when a later page is an error answer", async () => {
    const {
      client,
    } = gno(query => (query.endsWith("page=1") ? "{\"items\":[],\"page\":1,\"total\":2}" : "{\"error\":\"internal\"}"));
    await expect(client.queryUnreceivedAcksV2("ethereum-1", [1n])).rejects.toThrow(/internal/);
  });
});

describe("renderedConsensusState", () => {
  const item = {
    height: {
      revision_number: 2,
      revision_height: 2,
    },
    timestamp: 1234567890,
    root: "YXBwaGFzaA==",
    next_validators_hash: "/9gNNzK6IBcVWTwBsskTrrKk/SQzd29h1wP8LYFJbKo=",
  };

  it("reads the realm's item", () => {
    const cs = renderedConsensusState(item, "07-tendermint-1");
    expect([cs.revisionNumber, cs.revisionHeight, cs.timestampNanos]).toEqual([2n, 2n, 1234567890n * 1_000_000_000n]);
    expect(Buffer.from(cs.root).toString()).toBe("apphash");
  });

  it("refuses a malformed item", () => {
    for (const bad of [
      null,
      {
      },
      {
        ...item,
        height: undefined,
      },
      {
        ...item,
        height: {
          revision_number: 2,
        },
      },
      {
        ...item,
        timestamp: -1,
      },
      {
        ...item,
        root: 7,
      },
      {
        ...item,
        next_validators_hash: "not base64!",
      },
    ]) {
      expect(() => renderedConsensusState(bad, "07-tendermint-1")).toThrow();
    }
  });
});

describe("renderedCommitment", () => {
  it("finds a commitment by its exact sequence, and refuses one without data", () => {
    const items = [
      {
        sequence: "9007199254740993",
        data: "AQ==",
      },
    ];
    expect(renderedCommitment(items, 9007199254740993n, Q)).toEqual(Uint8Array.from([1]));
    expect(renderedCommitment(items, 9007199254740992n, Q)).toBeUndefined();
    expect(() => renderedCommitment([
      {
        sequence: "1",
      },
    ], 1n, Q)).toThrow();
  });
});

/*
 * The misbehaviour monitor walks consensus states from the last page back
 * to its cursor. Pages read at different heights shifted when the realm
 * pruned states between reads, and the cursor moved past states never
 * checked.
 */
describe("GnoIbcClient.getConsensusStatesAfter", () => {
  /** Consensus states at heights from..to, as the realm renders them. */
  const states = (from: number, to: number) => Array.from({
    length: to - from + 1,
  }, (_, i) => ({
    height: {
      revision_number: 1,
      revision_height: from + i,
    },
    timestamp: 1000 + from + i,
    root: "AA==",
    next_validators_hash: "AA==",
  }));
  const page = (all: unknown[], n: number) => JSON.stringify({
    items: all.slice((n - 1) * 100, n * 100),
    page: n,
    total: Math.max(1, Math.ceil(all.length / 100)),
  });

  it("reads every page at one height while the realm prunes between reads", async () => {
    // At the pinned height 500 the realm held heights 1 to 250; every read
    // of the latest state finds ten more pruned.
    const snapshot = states(1, 250);
    let pruned = 0;
    const {
      client, queries,
    } = gno((query, at) => {
      const n = Number(/page=(\d+)/.exec(query)?.[1]);
      if (at === 500) {
        return page(snapshot, n);
      }
      pruned += 10;
      return page(states(1 + pruned, 250), n);
    });

    const found = await client.getConsensusStatesAfter("07-tendermint-1", ClientType.Tendermint, 100n, 1000);
    expect(found.map(cs => Number(cs.revisionHeight))).toEqual(Array.from({
      length: 150,
    }, (_, i) => 101 + i));
    expect(queries.slice(1).every(([, at]) => at === 500)).toBe(true);
  });

  it("fails on an answer that is not a page", async () => {
    for (const raw of ["{}", "{\"error\":\"client 07-tendermint-1 not found\"}", "{\"items\":[],\"page\":1,\"total\":0}"]) {
      const {
        client,
      } = gno(() => raw);
      await expect(client.getConsensusStatesAfter("07-tendermint-1", ClientType.Tendermint, 0n, 10), raw).rejects.toThrow();
    }
  });

  it("fails when a later page counts other pages than the first", async () => {
    const {
      client,
    } = gno((query) => {
      const n = Number(/page=(\d+)/.exec(query)?.[1]);
      return JSON.stringify({
        items: states(n * 100 - 99, n * 100),
        page: n,
        total: n === 1 ? 2 : 3,
      });
    });
    await expect(client.getConsensusStatesAfter("07-tendermint-1", ClientType.Tendermint, 0n, 1000)).rejects.toThrow(/page 2 counts 3 pages, page 1 2/);
  });
});
