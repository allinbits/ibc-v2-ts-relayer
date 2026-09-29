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
  ChainType,
  ClientStatus,
  ClientType,
  ConsensusStateSummary,
  MisbehaviourKind,
  MisbehaviourStatus,
  RelayPaths,
} from "../types/index.js";
import {
  storage,
} from "../utils/storage.js";
import {
  connectQueryClient, resolveClientId,
} from "./clients.js";
import {
  MisbehaviourMonitor,
} from "./monitor.js";

vi.mock("../utils/storage.js", () => ({
  storage: {
    getRelayPaths: vi.fn(async () => []),
    getMonitorCursor: vi.fn(async () => 0),
    setMonitorCursor: vi.fn(async () => undefined),
    addMisbehaviourEvidence: vi.fn(async evidence => ({
      ...evidence,
      id: 11,
    })),
  },
}));

vi.mock("./clients.js", () => ({
  connectQueryClient: vi.fn(),
  resolveClientId: vi.fn(async (_host, storedId: string) => storedId),
}));

vi.mock("../storage/sqlite.js", () => ({
  closeDB: vi.fn(),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as winston.Logger;

const path: RelayPaths = {
  id: 1,
  chainIdA: "chain-a",
  nodeA: "http://a",
  chainIdB: "chain-b",
  nodeB: "http://b",
  chainTypeA: ChainType.Cosmos,
  chainTypeB: ChainType.Cosmos,
  clientA: "07-tendermint-0",
  clientB: "07-tendermint-1",
  version: 2,
};

// The source chain's header at every height has app hash [height] and next
// validators hash [0xff]; a consensus state conflicts when its root differs.
function honestState(height: number, root = height): ConsensusStateSummary {
  return {
    revisionNumber: 0n,
    revisionHeight: BigInt(height),
    timestampNanos: BigInt(height) * 1_000_000_000n,
    timestampPrecision: "nanoseconds",
    root: new Uint8Array([root]),
    nextValidatorsHash: new Uint8Array([0xff]),
  };
}

function mockHost(chainId: string, states: ConsensusStateSummary[] = [], status = ClientStatus.Active) {
  const client = {
    chainId,
    clientType: ClientType.Tendermint,
    getClientStatus: vi.fn(async () => status),
    getConsensusStatesAfter: vi.fn(async (_clientId: string, _type: ClientType, after: bigint, limit: number) => states
      .filter(state => state.revisionHeight > after)
      .slice(0, limit)),
    findConflictingHeader: vi.fn(async () => ({
      typeUrl: "/ibc.lightclients.tendermint.v1.Header",
      value: new Uint8Array([1, 2, 3]),
    })),
    getHeaderSummary: vi.fn(),
    currentHeight: vi.fn(async () => 1000),
    disconnect: vi.fn(),
  };
  return client as typeof client & BaseIbcClient;
}

function mockSource(chainId: string, currentHeight = 1000) {
  const client = {
    chainId,
    clientType: ClientType.Tendermint,
    currentHeight: vi.fn(async () => currentHeight),
    getHeaderSummary: vi.fn(async (height: number) => ({
      height,
      timestampNanos: BigInt(height) * 1_000_000_000n,
      appHash: new Uint8Array([height]),
      nextValidatorsHash: new Uint8Array([0xff]),
    })),
    getClientStatus: vi.fn(async () => ClientStatus.Active),
    getConsensusStatesAfter: vi.fn(async () => []),
    disconnect: vi.fn(),
  };
  return client as typeof client & BaseIbcClient;
}

// Side B: the client on chain B tracks chain A.
function monitored(host: BaseIbcClient, source: BaseIbcClient) {
  return {
    path,
    chainA: source,
    chainB: host,
    clientIdA: path.clientA,
    clientIdB: path.clientB,
  };
}

describe("MisbehaviourMonitor.checkClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storage.getMonitorCursor).mockResolvedValue(0);
  });

  it("advances the cursor past consensus states that match the source chain", async () => {
    const host = mockHost("chain-b", [honestState(10), honestState(20)]);
    const monitor = new MisbehaviourMonitor(logger);

    await monitor.checkClient(monitored(host, mockSource("chain-a")), "B");

    expect(host.getConsensusStatesAfter).toHaveBeenCalledWith("07-tendermint-1", ClientType.Tendermint, 0n, 100);
    expect(storage.addMisbehaviourEvidence).not.toHaveBeenCalled();
    expect(storage.setMonitorCursor).toHaveBeenCalledWith(1, "B", 20);
  });

  it("resumes from the stored cursor", async () => {
    vi.mocked(storage.getMonitorCursor).mockResolvedValue(10);
    const host = mockHost("chain-b", [honestState(10), honestState(20)]);
    const source = mockSource("chain-a");

    await new MisbehaviourMonitor(logger).checkClient(monitored(host, source), "B");

    expect(source.getHeaderSummary).toHaveBeenCalledTimes(1);
    expect(source.getHeaderSummary).toHaveBeenCalledWith(20);
  });

  it("records a conflicting consensus state and stops there", async () => {
    const host = mockHost("chain-b", [honestState(10), honestState(20), honestState(30, 99), honestState(40)]);
    const source = mockSource("chain-a");

    await new MisbehaviourMonitor(logger).checkClient(monitored(host, source), "B");

    expect(storage.addMisbehaviourEvidence).toHaveBeenCalledWith({
      relayPathId: 1,
      side: "B",
      hostChainId: "chain-b",
      clientId: "07-tendermint-1",
      revisionNumber: 0,
      revisionHeight: 30,
      trustedRevisionHeight: 20,
      kind: MisbehaviourKind.Fork,
      conflictingHeader: "AQID",
      conflictingHeaderTypeUrl: "/ibc.lightclients.tendermint.v1.Header",
      status: MisbehaviourStatus.Pending,
    });
    expect(host.findConflictingHeader).toHaveBeenCalledWith("07-tendermint-1", {
      revisionNumber: 0n,
      revisionHeight: 30n,
    });
    expect(source.getHeaderSummary).not.toHaveBeenCalledWith(40);
    expect(storage.setMonitorCursor).toHaveBeenCalledWith(1, "B", 30);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("MISBEHAVIOUR (fork)"), expect.anything());
  });

  it("only records evidence in dry-run mode", async () => {
    const host = mockHost("chain-b", [honestState(10), honestState(20, 99)]);

    await new MisbehaviourMonitor(logger, {
      dryRun: true,
    }).checkClient(monitored(host, mockSource("chain-a")), "B");

    expect(storage.addMisbehaviourEvidence).toHaveBeenCalledWith(expect.objectContaining({
      status: MisbehaviourStatus.DryRun,
    }));
  });

  it("records evidence without the offending header when it cannot be recovered", async () => {
    const host = mockHost("chain-b", [honestState(10), honestState(20, 99)]);
    host.findConflictingHeader.mockRejectedValueOnce(new Error("tx index disabled"));

    await new MisbehaviourMonitor(logger).checkClient(monitored(host, mockSource("chain-a")), "B");

    expect(storage.addMisbehaviourEvidence).toHaveBeenCalledWith(expect.objectContaining({
      conflictingHeader: null,
      conflictingHeaderTypeUrl: null,
    }));
  });

  it("skips clients that are not active", async () => {
    const host = mockHost("chain-b", [honestState(10)], ClientStatus.Frozen);

    await new MisbehaviourMonitor(logger).checkClient(monitored(host, mockSource("chain-a")), "B");

    expect(host.getConsensusStatesAfter).not.toHaveBeenCalled();
    expect(storage.setMonitorCursor).not.toHaveBeenCalled();
  });

  it("waits for the source chain to reach a consensus state's height", async () => {
    const host = mockHost("chain-b", [honestState(10), honestState(20)]);
    const source = mockSource("chain-a", 15);

    await new MisbehaviourMonitor(logger).checkClient(monitored(host, source), "B");

    expect(source.getHeaderSummary).not.toHaveBeenCalledWith(20);
    expect(storage.setMonitorCursor).toHaveBeenCalledWith(1, "B", 10);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("above chain-a's current height 15"));
  });

  it("does not trust consensus states whose header is unavailable", async () => {
    const host = mockHost("chain-b", [honestState(10), honestState(20), honestState(30, 99)]);
    const source = mockSource("chain-a");
    source.getHeaderSummary.mockImplementation(async (height: number) => {
      if (height === 20) {
        throw new Error("height 20 is not available, lowest height is 25");
      }
      return {
        height,
        timestampNanos: BigInt(height) * 1_000_000_000n,
        appHash: new Uint8Array([height]),
        nextValidatorsHash: new Uint8Array([0xff]),
      };
    });

    await new MisbehaviourMonitor(logger).checkClient(monitored(host, source), "B");

    expect(storage.addMisbehaviourEvidence).toHaveBeenCalledWith(expect.objectContaining({
      revisionHeight: 30,
      trustedRevisionHeight: 10,
    }));
  });

  it("checks at most maxHeightsPerCheck consensus states", async () => {
    const host = mockHost("chain-b", [honestState(10), honestState(20), honestState(30)]);

    await new MisbehaviourMonitor(logger, {
      maxHeightsPerCheck: 2,
    }).checkClient(monitored(host, mockSource("chain-a")), "B");

    expect(storage.setMonitorCursor).toHaveBeenCalledWith(1, "B", 20);
  });
});

describe("MisbehaviourMonitor.checkOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storage.getMonitorCursor).mockResolvedValue(0);
  });

  it("connects query clients for each path and checks both sides", async () => {
    const chainA = mockHost("chain-a", [honestState(5)]);
    const chainB = mockHost("chain-b", [honestState(7)]);
    chainA.getHeaderSummary = mockSource("chain-a").getHeaderSummary;
    chainB.getHeaderSummary = mockSource("chain-b").getHeaderSummary;
    vi.mocked(storage.getRelayPaths).mockResolvedValue([path]);
    vi.mocked(connectQueryClient).mockResolvedValueOnce(chainA).mockResolvedValueOnce(chainB);

    await new MisbehaviourMonitor(logger).checkOnce();

    expect(connectQueryClient).toHaveBeenCalledWith(ChainType.Cosmos, "http://a", undefined, logger);
    expect(resolveClientId).toHaveBeenCalledWith(chainA, "07-tendermint-0", 2);
    expect(chainA.getConsensusStatesAfter).toHaveBeenCalledWith("07-tendermint-0", ClientType.Tendermint, 0n, 100);
    expect(chainB.getConsensusStatesAfter).toHaveBeenCalledWith("07-tendermint-1", ClientType.Tendermint, 0n, 100);
    expect(storage.setMonitorCursor).toHaveBeenCalledWith(1, "A", 5);
    expect(storage.setMonitorCursor).toHaveBeenCalledWith(1, "B", 7);
  });

  it("only monitors the selected paths", async () => {
    vi.mocked(storage.getRelayPaths).mockResolvedValue([path]);

    await new MisbehaviourMonitor(logger, {
      pathIds: [2],
    }).checkOnce();

    expect(connectQueryClient).not.toHaveBeenCalled();
  });

  it("keeps checking the other side when one side fails", async () => {
    const chainA = mockHost("chain-a");
    chainA.getClientStatus.mockRejectedValue(new Error("rpc down"));
    const chainB = mockHost("chain-b", [honestState(7)]);
    chainA.getHeaderSummary = mockSource("chain-a").getHeaderSummary;
    vi.mocked(storage.getRelayPaths).mockResolvedValue([path]);
    vi.mocked(connectQueryClient).mockResolvedValueOnce(chainA).mockResolvedValueOnce(chainB);

    await new MisbehaviourMonitor(logger).checkOnce();

    expect(logger.error).toHaveBeenCalledWith("Failed to check side A of path 1: rpc down");
    expect(storage.setMonitorCursor).toHaveBeenCalledWith(1, "B", 7);
  });

  it("logs paths it cannot set up and retries them next time", async () => {
    vi.mocked(storage.getRelayPaths).mockResolvedValue([path]);
    vi.mocked(connectQueryClient).mockRejectedValueOnce(new Error("connection refused"));
    const monitor = new MisbehaviourMonitor(logger);

    await monitor.checkOnce();

    expect(logger.error).toHaveBeenCalledWith("Failed to set up monitoring for path 1: connection refused");
    vi.mocked(connectQueryClient).mockResolvedValueOnce(mockHost("chain-a")).mockResolvedValueOnce(mockHost("chain-b"));
    await monitor.checkOnce();
    expect(connectQueryClient).toHaveBeenCalledTimes(3);
  });

  it("drops paths removed from the database", async () => {
    const chainA = mockHost("chain-a");
    const chainB = mockHost("chain-b");
    vi.mocked(storage.getRelayPaths).mockResolvedValueOnce([path]).mockResolvedValueOnce([]);
    vi.mocked(connectQueryClient).mockResolvedValueOnce(chainA).mockResolvedValueOnce(chainB);
    const monitor = new MisbehaviourMonitor(logger);

    await monitor.checkOnce();
    await monitor.checkOnce();

    expect(chainA.disconnect).toHaveBeenCalled();
    expect(chainB.disconnect).toHaveBeenCalled();
  });
});
