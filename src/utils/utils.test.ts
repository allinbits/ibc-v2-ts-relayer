import {
  Any,
} from "@atomone/cosmos-ibc-types/google/protobuf/any.js";
import {
  Packet,
} from "@atomone/cosmos-ibc-types/ibc/core/channel/v1/channel.js";
import {
  Packet as PacketV2,
} from "@atomone/cosmos-ibc-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/cosmos-ibc-types/ibc/core/client/v1/client.js";
import {
  ClientState as TendermintClientState,
  ConsensusState as TendermintConsensusState,
} from "@atomone/cosmos-ibc-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  fromHex,
  toUtf8,
} from "@cosmjs/encoding";
import type {
  DeliverTxResponse,
} from "@cosmjs/stargate";
import {
  Event,
} from "@cosmjs/stargate";
import {
  ReadonlyDateWithNanoseconds,
  tendermint34,
  tendermint37,
} from "@cosmjs/tendermint-rpc";
import {
  ibc,
} from "@gnolang/gno-types";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildGnoClientState,
  buildGnoConsensusState,
  buildTendermintClientState,
  buildTendermintConsensusState,
  createDeliverTxFailureMessage,
  decodeClientState,
  decodeConsensusState,
  deepCloneAndMutate,
  ensureIntHeight,
  heightGreater,
  heightQueryString,
  isV2Packet,
  may,
  mergeUint8Arrays,
  parseAck,
  parseHeightAttribute,
  parsePacket,
  parsePacketsFromEvents,
  parseRevisionNumber,
  presentPacketData,
  presentPacketDataV2,
  secondsFromDateNanos,
  splitPendingPackets,
  subtractBlock,
  timeGreater,
  timeGreaterV2,
  timestampFromDateNanos,
  toIntHeight,
} from "./utils";

// eslint-disable-next-line max-lines-per-function
describe("utils", () => {
  describe("toIntHeight", () => {
    it("should convert Height to number", () => {
      const height: Height = {
        revisionNumber: 1n,
        revisionHeight: 123n,
      };
      expect(toIntHeight(height)).toBe(123);
    });

    it("should return NaN for undefined height", () => {
      expect(toIntHeight(undefined)).toBeNaN();
    });

    it("should handle large revision heights", () => {
      const height: Height = {
        revisionNumber: 5n,
        revisionHeight: 999999n,
      };
      expect(toIntHeight(height)).toBe(999999);
    });
  });

  describe("ensureIntHeight", () => {
    it("should convert Height to number", () => {
      const height: Height = {
        revisionNumber: 1n,
        revisionHeight: 456n,
      };
      expect(ensureIntHeight(height)).toBe(456);
    });

    it("should convert bigint to number", () => {
      expect(ensureIntHeight(789n)).toBe(789);
    });

    it("should handle zero", () => {
      expect(ensureIntHeight(0n)).toBe(0);
    });
  });

  describe("subtractBlock", () => {
    it("should subtract one block by default", () => {
      const height: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      const result = subtractBlock(height);
      expect(result.revisionNumber).toBe(1n);
      expect(result.revisionHeight).toBe(99n);
    });

    it("should subtract custom number of blocks", () => {
      const height: Height = {
        revisionNumber: 2n,
        revisionHeight: 500n,
      };
      const result = subtractBlock(height, 10n);
      expect(result.revisionNumber).toBe(2n);
      expect(result.revisionHeight).toBe(490n);
    });

    it("should maintain revision number", () => {
      const height: Height = {
        revisionNumber: 5n,
        revisionHeight: 10n,
      };
      const result = subtractBlock(height, 5n);
      expect(result.revisionNumber).toBe(5n);
      expect(result.revisionHeight).toBe(5n);
    });
  });

  describe("heightQueryString", () => {
    it("should format height as query string", () => {
      const height: Height = {
        revisionNumber: 3n,
        revisionHeight: 456n,
      };
      expect(heightQueryString(height)).toBe("3-456");
    });

    it("should handle zero values", () => {
      const height: Height = {
        revisionNumber: 0n,
        revisionHeight: 0n,
      };
      expect(heightQueryString(height)).toBe("0-0");
    });
  });

  describe("parseRevisionNumber", () => {
    it("should parse revision number from chain id", () => {
      expect(parseRevisionNumber("cosmoshub-4")).toBe(4n);
      expect(parseRevisionNumber("testnet-1")).toBe(1n);
      expect(parseRevisionNumber("my-chain-999")).toBe(999n);
    });

    it("should return 0 for chain id without revision", () => {
      expect(parseRevisionNumber("cosmoshub")).toBe(0n);
      expect(parseRevisionNumber("test")).toBe(0n);
    });

    it("should not match revision at start of chain id", () => {
      expect(parseRevisionNumber("4-cosmoshub")).toBe(0n);
    });
  });

  describe("may", () => {
    it("should apply transform when value is defined", () => {
      const result = may(x => x * 2, 5);
      expect(result).toBe(10);
    });

    it("should return undefined when value is undefined", () => {
      const result = may(x => x * 2, undefined);
      expect(result).toBeUndefined();
    });

    it("should return undefined when value is null", () => {
      const result = may(x => x * 2, null);
      expect(result).toBeUndefined();
    });

    it("should work with complex transforms", () => {
      const result = may(x => BigInt(x), "123");
      expect(result).toBe(123n);
    });
  });

  describe("timestampFromDateNanos", () => {
    it("should convert date with nanoseconds to timestamp", () => {
      const date = {
        getTime: () => 1000000,
        nanoseconds: 500,
      } as ReadonlyDateWithNanoseconds;

      const result = timestampFromDateNanos(date);
      expect(result.seconds).toBe(1000n);
      expect(result.nanos).toBe(500);
    });

    it("should handle date without nanoseconds", () => {
      const date = {
        getTime: () => 2000000,
      } as ReadonlyDateWithNanoseconds;

      const result = timestampFromDateNanos(date);
      expect(result.seconds).toBe(2000n);
    });

    it("should correctly compute nanoseconds", () => {
      const date = {
        getTime: () => 1234567,
        nanoseconds: 123,
      } as ReadonlyDateWithNanoseconds;

      const result = timestampFromDateNanos(date);
      expect(result.seconds).toBe(1234n);
      expect(result.nanos).toBe(567000000 + 123);
    });
  });

  describe("secondsFromDateNanos", () => {
    it("should extract seconds from date", () => {
      const date = {
        getTime: () => 5000000,
      } as ReadonlyDateWithNanoseconds;

      expect(secondsFromDateNanos(date)).toBe(5000);
    });

    it("should floor fractional seconds", () => {
      const date = {
        getTime: () => 1234567,
      } as ReadonlyDateWithNanoseconds;

      expect(secondsFromDateNanos(date)).toBe(1234);
    });
  });

  describe("buildTendermintConsensusState", () => {
    it("should build consensus state from tendermint header", () => {
      const header = {
        time: {
          getTime: () => 1000000,
          nanoseconds: 0,
        } as ReadonlyDateWithNanoseconds,
        appHash: new Uint8Array([1, 2, 3]),
        nextValidatorsHash: new Uint8Array([4, 5, 6]),
      } as tendermint34.Header;

      const result = buildTendermintConsensusState(header);

      expect(result.root?.hash).toEqual(new Uint8Array([1, 2, 3]));
      expect(result.nextValidatorsHash).toEqual(new Uint8Array([4, 5, 6]));
      expect(result.timestamp?.seconds).toBe(1000n);
    });

    it("should work with tendermint37 header", () => {
      const header = {
        time: {
          getTime: () => 2000000,
          nanoseconds: 500,
        } as ReadonlyDateWithNanoseconds,
        appHash: new Uint8Array([7, 8, 9]),
        nextValidatorsHash: new Uint8Array([10, 11, 12]),
      } as tendermint37.Header;

      const result = buildTendermintConsensusState(header);

      expect(result.root?.hash).toEqual(new Uint8Array([7, 8, 9]));
      expect(result.nextValidatorsHash).toEqual(new Uint8Array([10, 11, 12]));
    });
  });

  describe("buildGnoConsensusState", () => {
    it("should build Gno consensus state from header", () => {
      const header = ibc.lightclients.gno.v1.gno.GnoHeader.fromPartial({
        time: {
          seconds: 1000n,
          nanos: 0,
        },
        appHash: new Uint8Array([1, 2, 3]),
        nextValidatorsHash: new Uint8Array([4, 5, 6]),
      });

      const result = buildGnoConsensusState(header);

      expect(result.root?.hash).toEqual(new Uint8Array([1, 2, 3]));
      expect(result.nextValidatorsHash).toEqual(new Uint8Array([4, 5, 6]));
      expect(result.lcType).toBe("10-gno");
    });
  });

  describe("buildTendermintClientState", () => {
    it("should build Tendermint client state with correct parameters", () => {
      const height: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };

      const result = buildTendermintClientState(
        "test-chain",
        1814400, // 21 days
        1209600, // 14 days
        height,
      );

      expect(result.chainId).toBe("test-chain");
      expect(result.trustLevel?.numerator).toBe(1n);
      expect(result.trustLevel?.denominator).toBe(3n);
      expect(result.unbondingPeriod?.seconds).toBe(1814400n);
      expect(result.trustingPeriod?.seconds).toBe(1209600n);
      expect(result.maxClockDrift?.seconds).toBe(20n);
      expect(result.latestHeight).toEqual(height);
      expect(result.allowUpdateAfterExpiry).toBe(false);
      expect(result.allowUpdateAfterMisbehaviour).toBe(false);
    });

    it("should include proof specs", () => {
      const height: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };

      const result = buildTendermintClientState("test", 1000, 500, height);

      expect(result.proofSpecs).toHaveLength(2);
    });

    it("should include upgrade path", () => {
      const height: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };

      const result = buildTendermintClientState("test", 1000, 500, height);

      expect(result.upgradePath).toEqual(["upgrade", "upgradedIBCState"]);
    });
  });

  describe("buildGnoClientState", () => {
    it("should build Gno client state with correct parameters", () => {
      const height: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };

      const result = buildGnoClientState(
        "gno-chain",
        1814400,
        1209600,
        height,
      );

      expect(result.chainId).toBe("gno-chain");
      expect(result.trustLevel?.numerator).toBe(1n);
      expect(result.trustLevel?.denominator).toBe(3n);
      expect(result.unbondingPeriod?.seconds).toBe(1814400n);
      expect(result.trustingPeriod?.seconds).toBe(1209600n);
      expect(result.latestHeight).toEqual(height);
    });
  });

  describe("parseHeightAttribute", () => {
    it("should parse valid height string", () => {
      const result = parseHeightAttribute("1-100");
      expect(result).toEqual({
        revisionNumber: 1n,
        revisionHeight: 100n,
      });
    });

    it("should handle zero revision number", () => {
      const result = parseHeightAttribute("0-50");
      expect(result).toEqual({
        revisionNumber: 0n,
        revisionHeight: 50n,
      });
    });

    it("should return undefined for invalid format", () => {
      expect(parseHeightAttribute("invalid")).toBeUndefined();
      expect(parseHeightAttribute("100")).toBeUndefined();
    });

    it("should return undefined for zero height", () => {
      expect(parseHeightAttribute("0-0")).toBeUndefined();
      expect(parseHeightAttribute("1-0")).toBeUndefined();
    });

    it("should return undefined for undefined input", () => {
      expect(parseHeightAttribute(undefined)).toBeUndefined();
    });

    it("should handle large numbers", () => {
      const result = parseHeightAttribute("999-123456789");
      expect(result).toEqual({
        revisionNumber: 999n,
        revisionHeight: 123456789n,
      });
    });
  });

  describe("parsePacket", () => {
    it("should parse send_packet event", () => {
      const event: Event = {
        type: "send_packet",
        attributes: [
          {
            key: "packet_sequence",
            value: "1",
          },
          {
            key: "packet_src_port",
            value: "transfer",
          },
          {
            key: "packet_src_channel",
            value: "channel-0",
          },
          {
            key: "packet_dst_port",
            value: "transfer",
          },
          {
            key: "packet_dst_channel",
            value: "channel-1",
          },
          {
            key: "packet_data_hex",
            value: "68656c6c6f",
          },
          {
            key: "packet_timeout_height",
            value: "1-1000",
          },
          {
            key: "packet_timeout_timestamp",
            value: "1234567890000000000",
          },
        ],
      };

      const result = parsePacket(event);

      expect(result.sequence).toBe(1n);
      expect(result.sourcePort).toBe("transfer");
      expect(result.sourceChannel).toBe("channel-0");
      expect(result.destinationPort).toBe("transfer");
      expect(result.destinationChannel).toBe("channel-1");
      expect(result.data).toEqual(fromHex("68656c6c6f"));
      expect(result.timeoutHeight).toEqual({
        revisionNumber: 1n,
        revisionHeight: 1000n,
      });
      expect(result.timeoutTimestamp).toBe(1234567890000000000n);
    });

    it("should throw error for wrong event type", () => {
      const event: Event = {
        type: "wrong_event",
        attributes: [],
      };

      expect(() => parsePacket(event)).toThrow("Cannot parse event of type wrong_event");
    });
  });

  describe("parsePacketsFromEvents", () => {
    it("should filter and parse send_packet events", () => {
      const events: Event[] = [
        {
          type: "message",
          attributes: [
            {
              key: "action",
              value: "send",
            },
          ],
        },
        {
          type: "send_packet",
          attributes: [
            {
              key: "packet_sequence",
              value: "1",
            },
            {
              key: "packet_src_port",
              value: "transfer",
            },
            {
              key: "packet_src_channel",
              value: "channel-0",
            },
            {
              key: "packet_dst_port",
              value: "transfer",
            },
            {
              key: "packet_dst_channel",
              value: "channel-1",
            },
            {
              key: "packet_timeout_height",
              value: "1-100",
            },
            {
              key: "packet_timeout_timestamp",
              value: "0",
            },
          ],
        },
        {
          type: "send_packet",
          attributes: [
            {
              key: "packet_sequence",
              value: "2",
            },
            {
              key: "packet_src_port",
              value: "transfer",
            },
            {
              key: "packet_src_channel",
              value: "channel-0",
            },
            {
              key: "packet_dst_port",
              value: "transfer",
            },
            {
              key: "packet_dst_channel",
              value: "channel-1",
            },
            {
              key: "packet_timeout_height",
              value: "1-200",
            },
            {
              key: "packet_timeout_timestamp",
              value: "0",
            },
          ],
        },
      ];

      const result = parsePacketsFromEvents(events);

      expect(result).toHaveLength(2);
      expect(result[0].sequence).toBe(1n);
      expect(result[1].sequence).toBe(2n);
    });

    it("should return empty array when no send_packet events", () => {
      const events: Event[] = [
        {
          type: "message",
          attributes: [],
        },
      ];

      const result = parsePacketsFromEvents(events);
      expect(result).toHaveLength(0);
    });
  });

  describe("parseAck", () => {
    it("should parse write_acknowledgement event", () => {
      const event: Event = {
        type: "write_acknowledgement",
        attributes: [
          {
            key: "packet_sequence",
            value: "1",
          },
          {
            key: "packet_src_port",
            value: "transfer",
          },
          {
            key: "packet_src_channel",
            value: "channel-0",
          },
          {
            key: "packet_dst_port",
            value: "transfer",
          },
          {
            key: "packet_dst_channel",
            value: "channel-1",
          },
          {
            key: "packet_data_hex",
            value: "68656c6c6f",
          },
          {
            key: "packet_timeout_height",
            value: "1-1000",
          },
          {
            key: "packet_timeout_timestamp",
            value: "0",
          },
          {
            key: "packet_ack_hex",
            value: "01",
          },
        ],
      };

      const result = parseAck(event);

      expect(result.acknowledgement).toEqual(fromHex("01"));
      expect(result.originalPacket.sequence).toBe(1n);
      expect(result.originalPacket.sourcePort).toBe("transfer");
    });

    it("should throw error for wrong event type", () => {
      const event: Event = {
        type: "send_packet",
        attributes: [],
      };

      expect(() => parseAck(event)).toThrow("Cannot parse event of type send_packet");
    });
  });

  describe("heightGreater", () => {
    it("should return true when a is undefined", () => {
      const b: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      expect(heightGreater(undefined, b)).toBe(true);
    });

    it("should return true when a is zero height", () => {
      const a: Height = {
        revisionNumber: 0n,
        revisionHeight: 0n,
      };
      const b: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      expect(heightGreater(a, b)).toBe(true);
    });

    it("should return true when revision number is greater", () => {
      const a: Height = {
        revisionNumber: 2n,
        revisionHeight: 50n,
      };
      const b: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      expect(heightGreater(a, b)).toBe(true);
    });

    it("should return true when revision numbers equal and height is greater", () => {
      const a: Height = {
        revisionNumber: 1n,
        revisionHeight: 200n,
      };
      const b: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      expect(heightGreater(a, b)).toBe(true);
    });

    it("should return false when b is greater", () => {
      const a: Height = {
        revisionNumber: 1n,
        revisionHeight: 50n,
      };
      const b: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      expect(heightGreater(a, b)).toBe(false);
    });

    it("should return false when heights are equal", () => {
      const a: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      const b: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      expect(heightGreater(a, b)).toBe(false);
    });
  });

  describe("timeGreater", () => {
    it("should return true when a is undefined", () => {
      expect(timeGreater(undefined, 1000)).toBe(true);
    });

    it("should return true when a is zero", () => {
      expect(timeGreater(0n, 1000)).toBe(true);
    });

    it("should return true when a is greater (nanoseconds vs seconds)", () => {
      expect(timeGreater(2000000000000n, 1000)).toBe(true);
    });

    it("should return false when b is greater", () => {
      expect(timeGreater(500000000000n, 1000)).toBe(false);
    });

    it("should handle edge cases", () => {
      expect(timeGreater(1000000000000n, 1000)).toBe(false);
      expect(timeGreater(1000000000001n, 1000)).toBe(true);
    });
  });

  describe("timeGreaterV2", () => {
    it("should return true when a is undefined", () => {
      expect(timeGreaterV2(undefined, 1000)).toBe(true);
    });

    it("should return true when a is zero", () => {
      expect(timeGreaterV2(0n, 1000)).toBe(true);
    });

    it("should return true when a is greater (both in seconds)", () => {
      expect(timeGreaterV2(2000n, 1000)).toBe(true);
    });

    it("should return false when b is greater", () => {
      expect(timeGreaterV2(500n, 1000)).toBe(false);
    });

    it("should handle equal values", () => {
      expect(timeGreaterV2(1000n, 1000)).toBe(false);
      expect(timeGreaterV2(1001n, 1000)).toBe(true);
    });
  });

  describe("mergeUint8Arrays", () => {
    it("should merge multiple arrays", () => {
      const arr1 = new Uint8Array([1, 2]);
      const arr2 = new Uint8Array([3, 4]);
      const arr3 = new Uint8Array([5, 6]);

      const result = mergeUint8Arrays(arr1, arr2, arr3);

      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it("should handle empty arrays", () => {
      const arr1 = new Uint8Array([1, 2]);
      const arr2 = new Uint8Array([]);
      const arr3 = new Uint8Array([3]);

      const result = mergeUint8Arrays(arr1, arr2, arr3);

      expect(result).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("should handle single array", () => {
      const arr = new Uint8Array([1, 2, 3]);
      const result = mergeUint8Arrays(arr);

      expect(result).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("should handle no arrays", () => {
      const result = mergeUint8Arrays();
      expect(result).toEqual(new Uint8Array([]));
    });
  });

  describe("splitPendingPackets", () => {
    it("should split packets into valid and timed out (v1)", () => {
      const currentHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      const currentTime = 1000;

      const packets = [
        {
          packet: Packet.fromPartial({
            sequence: 1n,
            timeoutHeight: {
              revisionNumber: 1n,
              revisionHeight: 200n,
            },
            timeoutTimestamp: 2000000000000n,
          }),
          height: 100,
        },
        {
          packet: Packet.fromPartial({
            sequence: 2n,
            timeoutHeight: {
              revisionNumber: 1n,
              revisionHeight: 50n,
            },
            timeoutTimestamp: 2000000000000n,
          }),
          height: 100,
        },
        {
          packet: Packet.fromPartial({
            sequence: 3n,
            timeoutHeight: {
              revisionNumber: 1n,
              revisionHeight: 200n,
            },
            timeoutTimestamp: 500000000000n,
          }),
          height: 100,
        },
      ];

      const result = splitPendingPackets(currentHeight, currentTime, packets);

      expect(result.toSubmit).toHaveLength(1);
      expect(result.toSubmit[0].packet.sequence).toBe(1n);
      expect(result.toTimeout).toHaveLength(2);
    });

    it("should handle all valid packets", () => {
      const currentHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      const currentTime = 1000;

      const packets = [
        {
          packet: Packet.fromPartial({
            sequence: 1n,
            timeoutHeight: {
              revisionNumber: 1n,
              revisionHeight: 200n,
            },
            timeoutTimestamp: 2000000000000n,
          }),
          height: 100,
        },
      ];

      const result = splitPendingPackets(currentHeight, currentTime, packets);

      expect(result.toSubmit).toHaveLength(1);
      expect(result.toTimeout).toHaveLength(0);
    });

    it("should handle all timed out packets", () => {
      const currentHeight: Height = {
        revisionNumber: 1n,
        revisionHeight: 100n,
      };
      const currentTime = 1000;

      const packets = [
        {
          packet: Packet.fromPartial({
            sequence: 1n,
            timeoutHeight: {
              revisionNumber: 1n,
              revisionHeight: 50n,
            },
            timeoutTimestamp: 500000000000n,
          }),
          height: 100,
        },
      ];

      const result = splitPendingPackets(currentHeight, currentTime, packets);

      expect(result.toSubmit).toHaveLength(0);
      expect(result.toTimeout).toHaveLength(1);
    });
  });

  describe("presentPacketData", () => {
    it("should parse JSON data", () => {
      const data = toUtf8(JSON.stringify({
        amount: "1000",
        denom: "uatom",
      }));

      const result = presentPacketData(data);

      expect(result.amount).toBe("1000");
      expect(result.denom).toBe("uatom");
    });

    it("should return hex for non-JSON data", () => {
      const data = new Uint8Array([1, 2, 3, 4]);

      const result = presentPacketData(data);

      expect(result).toHaveProperty("hex");
      expect(typeof result.hex).toBe("string");
    });
  });

  describe("presentPacketDataV2", () => {
    it("should parse JSON data", () => {
      const data = toUtf8(JSON.stringify({
        test: "value",
      }));

      const result = presentPacketDataV2(data);

      expect(result.test).toBe("value");
    });

    it("should return hex for non-JSON data", () => {
      const data = new Uint8Array([5, 6, 7, 8]);

      const result = presentPacketDataV2(data);

      expect(result).toHaveProperty("hex");
    });
  });

  describe("isV2Packet", () => {
    it("should return true for v2 packet", () => {
      const packet = PacketV2.fromPartial({
        sourceClient: "07-tendermint-0",
        destinationClient: "07-tendermint-1",
        sequence: 1n,
      });

      expect(isV2Packet(packet)).toBe(true);
    });

    it("should return false for v1 packet", () => {
      const packet = Packet.fromPartial({
        sourcePort: "transfer",
        sourceChannel: "channel-0",
        sequence: 1n,
      });

      expect(isV2Packet(packet)).toBe(false);
    });
  });

  describe("createDeliverTxFailureMessage", () => {
    it("should format error message", () => {
      const result = {
        transactionHash: "ABC123",
        height: 100,
        code: 5,
        rawLog: "insufficient funds",
      } as DeliverTxResponse;

      const message = createDeliverTxFailureMessage(result);

      expect(message).toContain("ABC123");
      expect(message).toContain("100");
      expect(message).toContain("5");
      expect(message).toContain("insufficient funds");
    });
  });

  describe("deepCloneAndMutate", () => {
    it("should deep clone and mutate object", () => {
      const original = {
        a: 1,
        b: {
          c: 2,
        },
      };

      const result = deepCloneAndMutate(original, (obj) => {
        obj.a = 999;
      });

      expect(result.a).toBe(999);
      expect(original.a).toBe(1); // original unchanged
    });
  });

  describe("decodeClientState", () => {
    it("should decode Tendermint client state", () => {
      const clientStateBytes = TendermintClientState.encode(
        TendermintClientState.fromPartial({
          chainId: "test-chain",
        }),
      ).finish();

      const any = Any.fromPartial({
        typeUrl: "/ibc.lightclients.tendermint.v1.ClientState",
        value: clientStateBytes,
      });

      const result = decodeClientState(any);
      expect((result as TendermintClientState).chainId).toBe("test-chain");
    });

    it("should throw error for unknown client state type", () => {
      const any = Any.fromPartial({
        typeUrl: "/unknown.ClientState",
        value: new Uint8Array(),
      });

      expect(() => decodeClientState(any)).toThrow();
    });
  });

  describe("decodeConsensusState", () => {
    it("should decode Tendermint consensus state", () => {
      const consensusStateBytes = TendermintConsensusState.encode(
        TendermintConsensusState.fromPartial({
          nextValidatorsHash: new Uint8Array([1, 2, 3]),
        }),
      ).finish();

      const any = Any.fromPartial({
        typeUrl: "/ibc.lightclients.tendermint.v1.ConsensusState",
        value: consensusStateBytes,
      });

      const result = decodeConsensusState(any);
      expect((result as TendermintConsensusState).nextValidatorsHash).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });

    it("should throw error for unknown consensus state type", () => {
      const any = Any.fromPartial({
        typeUrl: "/unknown.ConsensusState",
        value: new Uint8Array(),
      });

      expect(() => decodeConsensusState(any)).toThrow();
    });
  });
});
