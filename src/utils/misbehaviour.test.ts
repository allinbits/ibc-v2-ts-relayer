import {
  BinaryWriter,
} from "@atomone/atomone-types/binary.js";
import {
  Any,
} from "@atomone/atomone-types/google/protobuf/any.js";
import {
  MsgUpdateClient,
} from "@atomone/atomone-types/ibc/core/client/v1/tx.js";
import {
  ConsensusState as TendermintConsensusState,
  Header as TendermintHeader,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  Header as CometProtoHeader,
} from "@atomone/atomone-types/tendermint/types/types.js";
import {
  fromHex,
} from "@cosmjs/encoding";
import {
  GeneratedType,
  Registry,
} from "@cosmjs/proto-signing";
import {
  ibc,
} from "@gnolang/gno-types";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  ClientStatus,
  ConsensusStateSummary,
  HeaderSummary,
  MisbehaviourKind,
} from "../types/index.js";
import {
  detectConsensusStateConflict,
  findUpdateClientHeader,
  GNO_HEADER_TYPE_URL,
  parseClientStatus,
  summarizeConsensusState,
  TENDERMINT_HEADER_TYPE_URL,
  timestampToNanos,
} from "./misbehaviour.js";

describe("misbehaviour utils", () => {
  describe("timestampToNanos", () => {
    it("combines seconds and nanos", () => {
      expect(timestampToNanos({
        seconds: 2n,
        nanos: 5,
      })).toBe(2_000_000_005n);
    });

    it("treats a missing timestamp as zero", () => {
      expect(timestampToNanos(undefined)).toBe(0n);
    });
  });

  describe("parseClientStatus", () => {
    it("parses known statuses", () => {
      expect(parseClientStatus("Active")).toBe(ClientStatus.Active);
      expect(parseClientStatus("Frozen")).toBe(ClientStatus.Frozen);
      expect(parseClientStatus("Expired")).toBe(ClientStatus.Expired);
    });

    it("maps anything else to Unknown", () => {
      expect(parseClientStatus("frozen")).toBe(ClientStatus.Unknown);
      expect(parseClientStatus("")).toBe(ClientStatus.Unknown);
    });
  });

  describe("summarizeConsensusState", () => {
    it("normalizes a Tendermint consensus state", () => {
      const summary = summarizeConsensusState(
        {
          revisionNumber: 1n,
          revisionHeight: 42n,
        },
        TendermintConsensusState.fromPartial({
          timestamp: {
            seconds: 3n,
            nanos: 7,
          },
          root: {
            hash: fromHex("aa"),
          },
          nextValidatorsHash: fromHex("bb"),
        }),
      );

      expect(summary).toEqual({
        revisionNumber: 1n,
        revisionHeight: 42n,
        timestampNanos: 3_000_000_007n,
        timestampPrecision: "nanoseconds",
        root: fromHex("aa"),
        nextValidatorsHash: fromHex("bb"),
      });
    });
  });

  describe("detectConsensusStateConflict", () => {
    const header: HeaderSummary = {
      height: 10,
      timestampNanos: 5_000_000_123n,
      appHash: fromHex("aa"),
      nextValidatorsHash: fromHex("bb"),
    };
    const matching: ConsensusStateSummary = {
      revisionNumber: 0n,
      revisionHeight: 10n,
      timestampNanos: 5_000_000_123n,
      timestampPrecision: "nanoseconds",
      root: fromHex("aa"),
      nextValidatorsHash: fromHex("bb"),
    };

    it("accepts a consensus state derived from the header", () => {
      expect(detectConsensusStateConflict(matching, header)).toBeUndefined();
    });

    it("flags a different app hash as a fork", () => {
      expect(detectConsensusStateConflict({
        ...matching,
        root: fromHex("cc"),
      }, header)).toBe(MisbehaviourKind.Fork);
    });

    it("flags a different next validators hash as a fork", () => {
      expect(detectConsensusStateConflict({
        ...matching,
        nextValidatorsHash: fromHex("cc"),
      }, header)).toBe(MisbehaviourKind.Fork);
    });

    it("flags a timestamp-only difference as a time violation", () => {
      expect(detectConsensusStateConflict({
        ...matching,
        timestampNanos: 6_000_000_000n,
      }, header)).toBe(MisbehaviourKind.Time);
    });

    it("compares whole seconds when the host only stores seconds", () => {
      const seconds: ConsensusStateSummary = {
        ...matching,
        timestampNanos: 5_000_000_000n,
        timestampPrecision: "seconds",
      };

      expect(detectConsensusStateConflict(seconds, header)).toBeUndefined();
      expect(detectConsensusStateConflict({
        ...seconds,
        timestampNanos: 4_000_000_000n,
      }, header)).toBe(MisbehaviourKind.Time);
    });
  });

  describe("findUpdateClientHeader", () => {
    const registry = new Registry([["/ibc.core.client.v1.MsgUpdateClient", MsgUpdateClient as unknown as GeneratedType]]);

    function tendermintHeaderAny(height: bigint): Any {
      return {
        typeUrl: TENDERMINT_HEADER_TYPE_URL,
        value: TendermintHeader.encode(TendermintHeader.fromPartial({
          signedHeader: {
            header: CometProtoHeader.fromPartial({
              height,
            }),
          },
        })).finish(),
      };
    }

    function gnoHeaderAny(height: bigint): Any {
      return {
        typeUrl: GNO_HEADER_TYPE_URL,
        value: ibc.lightclients.gno.v1.gno.Header.encode(ibc.lightclients.gno.v1.gno.Header.fromPartial({
          signedHeader: {
            header: {
              height,
            },
          },
        })).finish(),
      };
    }

    function txWithUpdates(...updates: [string, Any][]): Uint8Array {
      const body = registry.encodeTxBody({
        messages: updates.map(([clientId, clientMessage]) => ({
          typeUrl: "/ibc.core.client.v1.MsgUpdateClient",
          value: MsgUpdateClient.fromPartial({
            clientId,
            clientMessage,
            signer: "cosmos1signer",
          }),
        })),
      });
      // TxRaw { body_bytes = 1; auth_info_bytes = 2; }
      return new BinaryWriter().uint32(10).bytes(body).uint32(18).bytes(new Uint8Array()).finish();
    }

    it("returns the header submitted for the client at that height", () => {
      const wanted = tendermintHeaderAny(12n);
      const tx = txWithUpdates(["07-tendermint-1", tendermintHeaderAny(12n)], ["07-tendermint-0", wanted]);

      expect(findUpdateClientHeader(tx, "07-tendermint-0", 12n)).toEqual(wanted);
    });

    it("recovers Gno headers", () => {
      const wanted = gnoHeaderAny(30n);

      expect(findUpdateClientHeader(txWithUpdates(["10-gno-0", wanted]), "10-gno-0", 30n)).toEqual(wanted);
    });

    it("ignores updates for other heights or clients", () => {
      const tx = txWithUpdates(["07-tendermint-0", tendermintHeaderAny(11n)], ["07-tendermint-1", tendermintHeaderAny(12n)]);

      expect(findUpdateClientHeader(tx, "07-tendermint-0", 12n)).toBeUndefined();
    });

    it("ignores client messages that are not headers", () => {
      const tx = txWithUpdates([
        "07-tendermint-0",
        {
          typeUrl: "/ibc.lightclients.tendermint.v1.Misbehaviour",
          value: new Uint8Array(),
        },
      ]);

      expect(findUpdateClientHeader(tx, "07-tendermint-0", 12n)).toBeUndefined();
    });
  });
});
