import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as winston from "winston";

import {
  Relayer,
} from "./relayer";
import {
  ChainType,
} from "./types";
import {
  storage,
} from "./utils/storage";

// Mocks
globalThis.setTimeout = vi.fn(fn => fn()) as unknown as typeof setTimeout;

const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

vi.mock("winston", () => ({
  createLogger: vi.fn(() => ({
    info: mockLoggerInfo,
    error: mockLoggerError,
  })),
}));

vi.mock("./clients/tendermint/IbcClient", () => ({
  TendermintIbcClient: {
    connectWithSigner: vi.fn(async () => ({
      // mock client
    })),
  },
}));

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
      getChainFees: vi.fn(async () => ({
        chainId: "test",
        gasPrice: 0.025,
        gasDenom: "uatom",
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
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, 1,
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Added new relay path: chainA (cosmos) <-> chainB (cosmos)",
    );
  });

  it("should add a new relay path (v2)", async () => {
    await relayer.addNewRelayPath(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, 2,
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Added new relay path: chainA (cosmos) <-> chainB (cosmos)",
    );
  });

  it("should add an existing relay path", async () => {
    await relayer.addExistingRelayPath(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, "clientA", "clientB", 1,
    );
    expect(storage.addRelayPath).toHaveBeenCalledWith(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, "clientA", "clientB", 1,
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
});
