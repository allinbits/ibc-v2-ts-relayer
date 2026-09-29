import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as winston from "winston";

import {
  TendermintIbcClient,
} from "./clients/tendermint/IbcClient";
import {
  Link,
} from "./links/v1/link";
import {
  processMisbehaviourEvidence,
} from "./misbehaviour/evidence";
import {
  Relayer,
} from "./relayer";
import {
  ChainType,
  ClientStatus,
  MisbehaviourEvidence,
  MisbehaviourKind,
  MisbehaviourStatus,
} from "./types";
import {
  storage,
} from "./utils/storage";

// Mocks
globalThis.setTimeout = vi.fn(fn => fn()) as unknown as typeof setTimeout;

const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock("winston", () => ({
  createLogger: vi.fn(() => ({
    info: mockLoggerInfo,
    error: mockLoggerError,
    warn: mockLoggerWarn,
  })),
}));

vi.mock("./clients/tendermint/IbcClient", () => ({
  TendermintIbcClient: {
    connectWithSigner: vi.fn(async () => ({
      // mock client
      chainId: "chain",
      currentHeight: vi.fn(async () => 100),
      disconnect: vi.fn(),
    })),
  },
}));

vi.mock("./misbehaviour/evidence", () => ({
  processMisbehaviourEvidence: vi.fn(async () => undefined),
}));

function mockEnd(chainId: string, clientID: string) {
  return {
    clientID,
    client: {
      chainId,
      getClientStatus: vi.fn(async () => ClientStatus.Active),
      disconnect: vi.fn(),
    },
  };
}

vi.mock("./links/v1/link", () => ({
  Link: {
    createWithNewConnections: vi.fn(async () => ({
      endA: {
        connectionID: "connA",
        clientID: "clientA",
      },
      endB: {
        connectionID: "connB",
        clientID: "clientB",
      },
      createChannel: vi.fn(),
      checkAndRelayPacketsAndAcks: vi.fn(async heights => heights),
      updateClientIfStale: vi.fn(),
    })),
    createWithExistingConnections: vi.fn(async () => ({
      endA: mockEnd("chainA", "clientA"),
      endB: mockEnd("chainB", "clientB"),
      checkAndRelayPacketsAndAcks: vi.fn(async heights => heights),
      updateClientIfStale: vi.fn(),
    })),
  },
}));

vi.mock("./links/v2/link", () => ({
  Link: {
    createWithNewClientsV2: vi.fn(async () => ({
      endA: {
        connectionID: "connA",
        clientID: "clientA",
      },
      endB: {
        connectionID: "connB",
        clientID: "clientB",
      },
      checkAndRelayPacketsAndAcks: vi.fn(async heights => heights),
      updateClientIfStale: vi.fn(),
    })),
    createWithExistingClients: vi.fn(async () => ({
      checkAndRelayPacketsAndAcks: vi.fn(async heights => heights),
      updateClientIfStale: vi.fn(),
    })),
  },
}));

vi.mock("./utils/signers", () => ({
  getSigner: vi.fn(async () => ({
    getAccounts: vi.fn(async () => [
      {
        address: "addr",
      },
    ]),
  })),
}));

vi.mock("./utils/utils", () => ({
  getPrefix: vi.fn(async () => "cosmos"),
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

const relayPathsMock = [
  {
    id: 1,
    chainIdA: "chainA",
    nodeA: "nodeA",
    chainIdB: "chainB",
    nodeB: "nodeB",
    chainTypeA: ChainType.Cosmos,
    chainTypeB: ChainType.Cosmos,
    clientA: "clientA",
    clientB: "clientB",
    version: 1,
  },
];

const relayedHeightsMock = {
  id: 0,
  relayPathId: 1,
  packetHeightA: 0,
  packetHeightB: 0,
  ackHeightA: 0,
  ackHeightB: 0,
};

vi.mock("./utils/storage", () => (
  {
    storage: {
      addRelayPath: vi.fn(async () => relayPathsMock[0]),
      getRelayPaths: vi.fn(async () => relayPathsMock),
      getRelayedHeights: vi.fn(async () => relayedHeightsMock),
      updateRelayedHeights: vi.fn(async () => undefined),
      getMisbehaviourEvidence: vi.fn(async () => []),
      updateMisbehaviourEvidence: vi.fn(async () => undefined),
      getChainFees: vi.fn(async () => ({
        chainId: "test",
        gasPrice: 0.025,
        gasDenom: "uatom",
        gasAdjustment: 1.4,
      })),
    },
  }
));

describe("Relayer", () => {
  let logger: winston.Logger;
  let relayer: Relayer;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = winston.createLogger();
    relayer = new Relayer(logger);
  });

  it("should initialize with no relay paths", async () => {
    vi.mocked(storage.getRelayPaths).mockResolvedValueOnce([]);
    await relayer.init();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "No relay paths found. Please add a relay path to start relaying messages.",
    );
  });

  it("should initialize with relay paths", async () => {
    await relayer.init();
    expect(mockLoggerInfo).toHaveBeenCalledWith("Found 1 relay paths.");
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Relay Path: chainA (cosmos) <-> chainB (cosmos)",
    );
  });

  it("should add a new relay path (v1)", async () => {
    await relayer.addNewRelayPath(
      "chainA", "nodeA", undefined, "chainB", "nodeB", undefined, ChainType.Cosmos, ChainType.Cosmos, 1,
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Added new relay path: chainA (cosmos) <-> chainB (cosmos)",
    );
    // Initial relayed heights are seeded to the chains' current height (100)
    // so the first relay query is bounded rather than a genesis scan.
    expect(storage.updateRelayedHeights).toHaveBeenCalledWith(1, 100, 100, 100, 100);
  });

  it("should add a new relay path (v2)", async () => {
    await relayer.addNewRelayPath(
      "chainA", "nodeA", undefined, "chainB", "nodeB", undefined, ChainType.Cosmos, ChainType.Cosmos, 2,
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Added new relay path: chainA (cosmos) <-> chainB (cosmos)",
    );
    // Initial relayed heights are seeded to the chains' current height (100)
    // so the first relay query is bounded rather than a genesis scan.
    expect(storage.updateRelayedHeights).toHaveBeenCalledWith(1, 100, 100, 100, 100);
  });

  it("should add an existing relay path", async () => {
    await relayer.addExistingRelayPath(
      "chainA", "nodeA", undefined, "chainB", "nodeB", undefined, ChainType.Cosmos, ChainType.Cosmos, "clientA", "clientB", 1,
    );
    expect(storage.addRelayPath).toHaveBeenCalledWith(
      "chainA", "nodeA", undefined, "chainB", "nodeB", undefined, ChainType.Cosmos, ChainType.Cosmos, "clientA", "clientB", 1,
    );
  });

  it("should start and stop the relayer", async () => {
    relayer.relayerLoop = vi.fn();
    await relayer.start();
    expect(relayer["running"]).toBe(true);
    expect(mockLoggerInfo).toHaveBeenCalledWith("Starting relayer...");
    await relayer.stop();
    expect(relayer["running"]).toBe(false);
    expect(mockLoggerInfo).toHaveBeenCalledWith("Stopping relayer...");
  });

  it("should emit messageRelayed event", () => {
    relayer.on("messageRelayed", (msg: string) => {
      expect(msg).toBe("test");
    });
    relayer.relayMessage("test");
  });

  it("keeps setting up later paths when one path fails", async () => {
    vi.mocked(storage.getRelayPaths).mockResolvedValueOnce([
      relayPathsMock[0],
      {
        ...relayPathsMock[0],
        id: 2,
      },
    ]);
    vi.mocked(Link.createWithExistingConnections).mockRejectedValueOnce(new Error("consensus state mismatch"));

    await relayer.init();

    expect(mockLoggerError).toHaveBeenCalledWith("Failed to set up relay path 1: consensus state mismatch");
    expect(relayer["links"].has(1)).toBe(false);
    expect(relayer["links"].has(2)).toBe(true);
  });

  describe("misbehaviour evidence", () => {
    const evidence: MisbehaviourEvidence = {
      id: 7,
      relayPathId: 1,
      side: "B",
      hostChainId: "chainB",
      clientId: "clientB",
      revisionNumber: 0,
      revisionHeight: 50,
      trustedRevisionHeight: 40,
      kind: MisbehaviourKind.Fork,
      conflictingHeader: null,
      conflictingHeaderTypeUrl: null,
      status: MisbehaviourStatus.Pending,
      attempts: 0,
      txHash: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
    };

    it("submits pending evidence with the link's clients", async () => {
      await relayer.init();
      vi.mocked(storage.getMisbehaviourEvidence).mockResolvedValueOnce([evidence]);

      await relayer.processPendingMisbehaviour();

      const link = relayer["links"].get(1)!;
      expect(storage.getMisbehaviourEvidence).toHaveBeenCalledWith(MisbehaviourStatus.Pending);
      expect(processMisbehaviourEvidence).toHaveBeenCalledWith(evidence, link.endB.client, link.endA.client, 5, logger);
    });

    it("connects to the path when it has no link", async () => {
      vi.mocked(storage.getRelayPaths).mockResolvedValueOnce(relayPathsMock);
      vi.mocked(Link.createWithExistingConnections).mockRejectedValueOnce(new Error("consensus state mismatch"));
      await relayer.init();
      vi.mocked(storage.getMisbehaviourEvidence).mockResolvedValueOnce([
        {
          ...evidence,
          side: "A",
        },
      ]);
      vi.mocked(TendermintIbcClient.connectWithSigner).mockClear();

      await relayer.processPendingMisbehaviour();

      expect(TendermintIbcClient.connectWithSigner).toHaveBeenCalledTimes(2);
      const [host, source] = vi.mocked(processMisbehaviourEvidence).mock.calls[0].slice(1, 3) as {
        disconnect: () => void
      }[];
      const [clientA, clientB] = await Promise.all(vi.mocked(TendermintIbcClient.connectWithSigner).mock.results.map(r => r.value));
      expect(host).toBe(clientA);
      expect(source).toBe(clientB);
      expect(host.disconnect).toHaveBeenCalled();
      expect(source.disconnect).toHaveBeenCalled();
    });

    it("fails evidence for a path that no longer exists", async () => {
      await relayer.init();
      vi.mocked(storage.getMisbehaviourEvidence).mockResolvedValueOnce([
        {
          ...evidence,
          relayPathId: 99,
        },
      ]);

      await relayer.processPendingMisbehaviour();

      expect(storage.updateMisbehaviourEvidence).toHaveBeenCalledWith(7, {
        status: MisbehaviourStatus.Failed,
        error: "Relay path 99 not found",
      });
      expect(processMisbehaviourEvidence).not.toHaveBeenCalled();
    });
  });

  describe("relay loop", () => {
    async function runOneIteration() {
      relayer["running"] = true;
      relayer.sleep = vi.fn(async () => {
        relayer["running"] = false;
      });
      await relayer.relayerLoop({
        poll: 1000,
        maxAgeDest: 60,
        maxAgeSrc: 60,
      });
    }

    it("relays paths whose clients are active", async () => {
      await relayer.init();
      const link = relayer["links"].get(1)!;

      await runOneIteration();

      expect(link.checkAndRelayPacketsAndAcks).toHaveBeenCalled();
    });

    it("skips paths with a frozen client", async () => {
      await relayer.init();
      const link = relayer["links"].get(1)!;
      vi.mocked(link.endB.client.getClientStatus).mockResolvedValue(ClientStatus.Frozen);

      await runOneIteration();

      expect(mockLoggerWarn).toHaveBeenCalledWith("Skipping relay path 1: client clientB on chainB is Frozen");
      expect(link.checkAndRelayPacketsAndAcks).not.toHaveBeenCalled();
      expect(link.updateClientIfStale).not.toHaveBeenCalled();
    });

    it("keeps relaying when a client status cannot be checked", async () => {
      await relayer.init();
      const link = relayer["links"].get(1)!;
      vi.mocked(link.endA.client.getClientStatus).mockRejectedValue(new Error("rpc down"));

      await runOneIteration();

      expect(mockLoggerWarn).toHaveBeenCalledWith("Could not check the status of client clientA on chainA: rpc down");
      expect(link.checkAndRelayPacketsAndAcks).toHaveBeenCalled();
    });
  });
});
