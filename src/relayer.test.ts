import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import winston from "winston";

import {
  Relayer,
} from "./relayer";
import {
  ChainType,
} from "./types";

// Mocks
globalThis.setTimeout = vi.fn(fn => fn()) as unknown as typeof setTimeout;

vi.mock("winston", () => ({
  default: {
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
    })),
  },
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

vi.mock("./utils/storage", () => ({
  addRelayPath: vi.fn(async () => relayPathsMock[0]),
  getRelayPaths: vi.fn(async () => relayPathsMock),
  getRelayedHeights: vi.fn(async () => relayedHeightsMock),
  updateRelayedHeights: vi.fn(async () => undefined),
}));

describe("Relayer", () => {
  let logger: winston.Logger;
  let relayer: Relayer;

  beforeEach(() => {
    logger = winston.createLogger();
    relayer = new Relayer(logger);
  });

  it("should initialize with no relay paths", async () => {
    const getRelayPaths = require("./utils/storage").getRelayPaths;
    getRelayPaths.mockResolvedValueOnce([]);
    await relayer.init();
    expect(logger.info).toHaveBeenCalledWith(
      "No relay paths found. Please add a relay path to start relaying messages.",
    );
  });

  it("should initialize with relay paths", async () => {
    await relayer.init();
    expect(logger.info).toHaveBeenCalledWith("Found 1 relay paths.");
    expect(logger.info).toHaveBeenCalledWith(
      "Relay Path: chainA (typeA) <-> chainB (typeB)",
    );
  });

  it("should add a new relay path (v1)", async () => {
    await relayer.addNewdRelayPath(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, 1,
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Added new relay path: chainA (typeA) <-> chainB (typeB)",
    );
  });

  it("should add a new relay path (v2)", async () => {
    await relayer.addNewdRelayPath(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, 2,
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Added new relay path: chainA (typeA) <-> chainB (typeB)",
    );
  });

  it("should add an existing relay path", async () => {
    await relayer.addExistingRelayPath(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, "clientA", "clientB", 1,
    );
    const addRelayPath = require("./utils/storage").addRelayPath;
    expect(addRelayPath).toHaveBeenCalledWith(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, "clientA", "clientB", 1,
    );
  });

  it("should start and stop the relayer", async () => {
    relayer.relayerLoop = vi.fn();
    await relayer.start();
    // @ts-expect-error: testing private property
    expect(relayer["running"]).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("Starting relayer...");
    await relayer.stop();
    // @ts-expect-error: testing private property
    expect(relayer["running"]).toBe(false);
    expect(logger.info).toHaveBeenCalledWith("Stopping relayer...");
  });

  it("should emit messageRelayed event", () => {
    // @ts-expect-error: EventEmitter typing
    relayer.on("messageRelayed", (msg: string) => {
      expect(msg).toBe("test");
    });
    relayer.relayMessage("test");
  });
});
