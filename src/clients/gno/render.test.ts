import {
  describe, expect, it, vi,
} from "vitest";

import {
  GnoIbcClient,
} from "./IbcClient.js";
import {
  parseRenderPage, renderedSequences,
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
    for (const raw of ["", "not json", "null", "[]", "1", "\"x\"", "{}", "{\"items\":null,\"page\":1,\"total\":1}", "{\"items\":[],\"total\":1}", "{\"items\":[],\"page\":2,\"total\":1}", "{\"items\":[],\"page\":1,\"total\":-1}", "{\"items\":[],\"page\":1,\"total\":\"1\"}", "{\"items\":[],\"page\":1,\"total\":1.5}"]) {
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
