import {
  Any,
} from "@atomone/atomone-types/google/protobuf/any.js";
import {
  Header as TendermintHeader,
  Misbehaviour as TendermintMisbehaviour,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  Header as CometProtoHeader,
} from "@atomone/atomone-types/tendermint/types/types.js";
import {
  toBase64,
} from "@cosmjs/encoding";
import {
  ibc,
} from "@gnolang/gno-types";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as winston from "winston";

import {
  BaseIbcClient,
} from "../clients/BaseIbcClient.js";
import {
  ClientStatus,
  ClientType,
  MisbehaviourEvidence,
  MisbehaviourKind,
  MisbehaviourStatus,
} from "../types/index.js";
import {
  GNO_HEADER_TYPE_URL,
  GNO_MISBEHAVIOUR_TYPE_URL,
  TENDERMINT_HEADER_TYPE_URL,
  TENDERMINT_MISBEHAVIOUR_TYPE_URL,
} from "../utils/misbehaviour.js";
import {
  storage,
} from "../utils/storage.js";
import {
  freezeClient,
  processMisbehaviourEvidence,
} from "./evidence.js";

vi.mock("../utils/storage.js", () => ({
  storage: {
    updateMisbehaviourEvidence: vi.fn(async () => undefined),
  },
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as winston.Logger;

function tendermintHeader(height: bigint, appHash: number): TendermintHeader {
  return TendermintHeader.fromPartial({
    signedHeader: {
      header: CometProtoHeader.fromPartial({
        height,
        appHash: new Uint8Array([appHash]),
      }),
    },
  });
}

function gnoHeader(height: bigint, appHash: number) {
  return ibc.lightclients.gno.v1.gno.Header.fromPartial({
    signedHeader: {
      header: {
        height,
        appHash: new Uint8Array([appHash]),
      },
    },
  });
}

// Host clients report Active until evidence is submitted, then Frozen.
function mockHost(clientType: ClientType, before = ClientStatus.Active, after = ClientStatus.Frozen) {
  let submitted = false;
  const host = {
    chainId: "host-1",
    clientType,
    getClientStatus: vi.fn(async () => (submitted ? after : before)),
    submitMisbehaviour: vi.fn(async (_clientId: string, _misbehaviour: Any) => {
      submitted = true;
      return {
        events: [],
        transactionHash: "MISBEHAVIOUR_TX",
        height: 1,
      };
    }),
    submitConflictingHeader: vi.fn(async () => {
      submitted = true;
      return 50;
    }),
  };
  return host as typeof host & BaseIbcClient;
}

function mockSource(clientType: ClientType) {
  const source = {
    chainId: "source-1",
    clientType,
    buildHeader: vi.fn(async (_trusted: number, height: number) => (clientType === ClientType.Gno
      ? gnoHeader(BigInt(height), 2)
      : tendermintHeader(BigInt(height), 2))),
  };
  return source as typeof source & BaseIbcClient;
}

const evidence: MisbehaviourEvidence = {
  id: 3,
  relayPathId: 1,
  side: "B",
  hostChainId: "host-1",
  clientId: "07-tendermint-0",
  revisionNumber: 0,
  revisionHeight: 50,
  trustedRevisionHeight: 40,
  kind: MisbehaviourKind.Fork,
  conflictingHeader: toBase64(TendermintHeader.encode(tendermintHeader(50n, 1)).finish()),
  conflictingHeaderTypeUrl: TENDERMINT_HEADER_TYPE_URL,
  status: MisbehaviourStatus.Pending,
  attempts: 0,
  txHash: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("freezeClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits a Misbehaviour built from the offending and source headers", async () => {
    const host = mockHost(ClientType.Tendermint);
    const source = mockSource(ClientType.Tendermint);

    const txHash = await freezeClient(evidence, host, source, logger);

    expect(txHash).toBe("MISBEHAVIOUR_TX");
    expect(source.buildHeader).toHaveBeenCalledWith(40, 50);
    const [clientId, any] = host.submitMisbehaviour.mock.calls[0];
    expect(clientId).toBe("07-tendermint-0");
    expect(any.typeUrl).toBe(TENDERMINT_MISBEHAVIOUR_TYPE_URL);
    const misbehaviour = TendermintMisbehaviour.decode(any.value);
    expect(misbehaviour.clientId).toBe("07-tendermint-0");
    expect(misbehaviour.header1).toEqual(tendermintHeader(50n, 1));
    expect(misbehaviour.header2).toEqual(tendermintHeader(50n, 2));
    expect(host.submitConflictingHeader).not.toHaveBeenCalled();
  });

  it("builds a Gno Misbehaviour when the host tracks a Gno chain", async () => {
    const host = mockHost(ClientType.Tendermint);
    const source = mockSource(ClientType.Gno);

    await freezeClient({
      ...evidence,
      clientId: "10-gno-0",
      conflictingHeader: toBase64(ibc.lightclients.gno.v1.gno.Header.encode(gnoHeader(50n, 1)).finish()),
      conflictingHeaderTypeUrl: GNO_HEADER_TYPE_URL,
    }, host, source, logger);

    const [, any] = host.submitMisbehaviour.mock.calls[0];
    expect(any.typeUrl).toBe(GNO_MISBEHAVIOUR_TYPE_URL);
    const misbehaviour = ibc.lightclients.gno.v1.gno.Misbehaviour.decode(any.value);
    expect(misbehaviour.clientId).toBe("10-gno-0");
    expect(misbehaviour.header1?.signedHeader?.header?.appHash).toEqual(new Uint8Array([1]));
    expect(misbehaviour.header2?.signedHeader?.header?.appHash).toEqual(new Uint8Array([2]));
  });

  it("submits the source header when the offending header was not recovered", async () => {
    const host = mockHost(ClientType.Tendermint);
    const source = mockSource(ClientType.Tendermint);

    const txHash = await freezeClient({
      ...evidence,
      conflictingHeader: null,
      conflictingHeaderTypeUrl: null,
    }, host, source, logger);

    expect(txHash).toBeNull();
    expect(host.submitMisbehaviour).not.toHaveBeenCalled();
    expect(host.submitConflictingHeader).toHaveBeenCalledWith("07-tendermint-0", source, 40, 50);
  });

  it("ignores a recovered header of the wrong light client type", async () => {
    const host = mockHost(ClientType.Tendermint);
    const source = mockSource(ClientType.Gno);

    await freezeClient(evidence, host, source, logger);

    expect(host.submitMisbehaviour).not.toHaveBeenCalled();
    expect(host.submitConflictingHeader).toHaveBeenCalled();
  });

  it("falls back to the source header when the Misbehaviour is rejected", async () => {
    const host = mockHost(ClientType.Tendermint);
    host.submitMisbehaviour.mockRejectedValueOnce(new Error("trusted consensus state not found"));
    const source = mockSource(ClientType.Tendermint);

    const txHash = await freezeClient(evidence, host, source, logger);

    expect(txHash).toBeNull();
    expect(host.submitConflictingHeader).toHaveBeenCalledWith("07-tendermint-0", source, 40, 50);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("freezes Gno-hosted clients with the source header", async () => {
    const host = mockHost(ClientType.Gno);
    const source = mockSource(ClientType.Tendermint);

    await freezeClient(evidence, host, source, logger);

    expect(host.submitMisbehaviour).not.toHaveBeenCalled();
    expect(host.submitConflictingHeader).toHaveBeenCalledWith("07-tendermint-0", source, 40, 50);
  });

  it("does nothing when the client is already frozen", async () => {
    const host = mockHost(ClientType.Tendermint, ClientStatus.Frozen);

    expect(await freezeClient(evidence, host, mockSource(ClientType.Tendermint), logger)).toBeNull();
    expect(host.submitMisbehaviour).not.toHaveBeenCalled();
    expect(host.submitConflictingHeader).not.toHaveBeenCalled();
  });

  it("refuses clients that are not active", async () => {
    const host = mockHost(ClientType.Tendermint, ClientStatus.Expired);

    await expect(freezeClient(evidence, host, mockSource(ClientType.Tendermint), logger))
      .rejects.toThrow("is Expired and cannot be frozen");
  });

  it("refuses evidence without a verified trusted height", async () => {
    const host = mockHost(ClientType.Tendermint);

    await expect(freezeClient({
      ...evidence,
      trustedRevisionHeight: 0,
    }, host, mockSource(ClientType.Tendermint), logger)).rejects.toThrow("No verified consensus state below height 50");
    expect(host.submitConflictingHeader).not.toHaveBeenCalled();
  });

  it("fails when the client is not frozen afterwards", async () => {
    const host = mockHost(ClientType.Tendermint, ClientStatus.Active, ClientStatus.Active);

    await expect(freezeClient(evidence, host, mockSource(ClientType.Tendermint), logger))
      .rejects.toThrow("is still Active after submitting evidence");
  });
});

describe("processMisbehaviourEvidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks frozen clients confirmed", async () => {
    await processMisbehaviourEvidence(evidence, mockHost(ClientType.Tendermint), mockSource(ClientType.Tendermint), 5, logger);

    expect(storage.updateMisbehaviourEvidence).toHaveBeenCalledWith(3, {
      status: MisbehaviourStatus.Confirmed,
      attempts: 1,
      txHash: "MISBEHAVIOUR_TX",
      error: null,
    });
  });

  it("keeps failed evidence pending until the last attempt", async () => {
    const host = mockHost(ClientType.Tendermint, ClientStatus.Active, ClientStatus.Active);

    await processMisbehaviourEvidence(evidence, host, mockSource(ClientType.Tendermint), 5, logger);

    expect(storage.updateMisbehaviourEvidence).toHaveBeenCalledWith(3, expect.objectContaining({
      status: MisbehaviourStatus.Pending,
      attempts: 1,
    }));
    expect(logger.error).toHaveBeenCalled();
  });

  it("marks evidence failed on the last attempt", async () => {
    const host = mockHost(ClientType.Tendermint, ClientStatus.Active, ClientStatus.Active);

    await processMisbehaviourEvidence({
      ...evidence,
      attempts: 4,
    }, host, mockSource(ClientType.Tendermint), 5, logger);

    expect(storage.updateMisbehaviourEvidence).toHaveBeenCalledWith(3, {
      status: MisbehaviourStatus.Failed,
      attempts: 5,
      error: "Client 07-tendermint-0 on host-1 is still Active after submitting evidence",
    });
  });
});
