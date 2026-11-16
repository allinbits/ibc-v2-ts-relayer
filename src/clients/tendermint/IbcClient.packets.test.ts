import {
  Packet as PacketV2,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  toHex,
} from "@cosmjs/encoding";
import {
  describe, expect, it, vi,
} from "vitest";

import {
  TendermintIbcClient,
} from "./IbcClient";

const packet = (sourceClient: string, destinationClient: string, sequence: bigint) => PacketV2.fromPartial({
  sequence,
  sourceClient,
  destinationClient,
  timeoutTimestamp: 1n,
});

// A client without a connection: only the methods under test run, over
// stubbed queries.
const bareClient = () => Object.create(TendermintIbcClient.prototype) as TendermintIbcClient;

describe("TendermintIbcClient v2 queries", () => {
  // A provider chain sends one packet per counterparty in the same block,
  // over a different client each, and a relayer serves one of those paths.
  it("returns only the packets sent from the queried client", async () => {
    const client = bareClient();
    vi.spyOn(client, "getPacketsFromTxsV2").mockResolvedValue([]);
    vi.spyOn(client, "getPacketsFromBlockEventsV2").mockResolvedValue([
      {
        packet: packet("07-tendermint-0", "07-tendermint-0", 7n),
        height: 10,
      },
      {
        packet: packet("07-tendermint-1", "07-tendermint-0", 3n),
        height: 10,
      },
    ]);

    const sent = await client.querySentPacketsV2("07-tendermint-1", undefined, undefined);

    expect(sent.map(({
      packet,
    }) => [packet.sourceClient, packet.sequence])).toEqual([["07-tendermint-1", 3n]]);
  });

  it("returns only the acknowledgements written for the queried client", async () => {
    const client = bareClient();
    const ackEvent = (p: PacketV2) => ({
      type: "write_acknowledgement",
      attributes: [
        {
          key: "encoded_packet_hex",
          value: toHex(PacketV2.encode(p).finish()),
        },
        {
          key: "encoded_acknowledgement_hex",
          value: "01",
        },
      ],
    });
    vi.spyOn(client, "searchTendermintTxs").mockResolvedValue({
      txs: [
        {
          height: 12,
          hash: new Uint8Array([1]),
          result: {
            events: [ackEvent(packet("07-tendermint-0", "07-tendermint-0", 7n)), ackEvent(packet("07-tendermint-0", "07-tendermint-1", 3n))],
          },
        },
      ],
      totalCount: 1,
    } as never);

    const acks = await client.queryWrittenAcksV2("07-tendermint-1", undefined, undefined);

    expect(acks.map(({
      originalPacket,
    }) => [originalPacket.destinationClient, originalPacket.sequence])).toEqual([["07-tendermint-1", 3n]]);
  });
});
