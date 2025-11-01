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
  addRelayPath, getRelayPaths,
} from "./utils/storage";

// Mocks
globalThis.setTimeout = vi.fn(fn => fn()) as unknown as typeof setTimeout;

vi.mock("winston", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  })),
}));

// Mock @cosmjs/tendermint-rpc to avoid WebSocket connections
vi.mock("@cosmjs/tendermint-rpc", () => ({
  connectComet: vi.fn().mockResolvedValue({
    disconnect: vi.fn(),
    abciInfo: vi.fn(),
    abciQuery: vi.fn().mockResolvedValue({
      value: new Uint8Array(),
    }),
    block: vi.fn(),
    blockchain: vi.fn(),
    commit: vi.fn(),
    validators: vi.fn(),
    status: vi.fn(),
  }),
}));

// Mock @cosmjs/stargate QueryClient
vi.mock("@cosmjs/stargate", async () => {
  const actual = await vi.importActual<typeof import("@cosmjs/stargate")>("@cosmjs/stargate");
  return {
    ...actual,
    QueryClient: {
      withExtensions: vi.fn(() => ({
        queryAbci: vi.fn().mockResolvedValue({
          value: new Uint8Array([10, 6, 99, 111, 115, 109, 111, 115]), // "cosmos" prefix encoded
        }),
      })),
    },
  };
});

// Mock @napi-rs/keyring
vi.mock("@napi-rs/keyring", () => ({
  Entry: vi.fn().mockImplementation(() => ({
    setPassword: vi.fn(),
    getPassword: vi.fn().mockReturnValue("test mnemonic"),
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
        client: {
          tm: {
            disconnect: vi.fn(),
          },
        },
      },
      endB: {
        connectionID: "connB",
        clientID: "clientB",
        client: {
          tm: {
            disconnect: vi.fn(),
          },
        },
      },
      createChannel: vi.fn(),
      checkAndRelayPacketsAndAcks: vi.fn(async heights => heights),
      updateClientIfStale: vi.fn(),
    })),
    createWithExistingConnections: vi.fn(async () => ({
      endA: {
        client: {
          tm: {
            disconnect: vi.fn(),
          },
        },
      },
      endB: {
        client: {
          tm: {
            disconnect: vi.fn(),
          },
        },
      },
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
        client: {
          tm: {
            disconnect: vi.fn(),
          },
        },
      },
      endB: {
        connectionID: "connB",
        clientID: "clientB",
        client: {
          tm: {
            disconnect: vi.fn(),
          },
        },
      },
      checkAndRelayPacketsAndAcks: vi.fn(async heights => heights),
      updateClientIfStale: vi.fn(),
    })),
    createWithExistingClients: vi.fn(async () => ({
      endA: {
        client: {
          tm: {
            disconnect: vi.fn(),
          },
        },
      },
      endB: {
        client: {
          tm: {
            disconnect: vi.fn(),
          },
        },
      },
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
  getChainFees: vi.fn(async () => ({
    gasPrice: "0.025",
    gasDenom: "uatom",
  })),
  addChainFees: vi.fn(async () => undefined),
}));

// Mock utils functions
vi.mock("./utils/utils", async () => {
  const actual = await vi.importActual<typeof import("./utils/utils")>("./utils/utils");
  return {
    ...actual,
    getPrefix: vi.fn(async () => "cosmos"),
  };
});

describe("Relayer", () => {
  let logger: winston.Logger;
  let relayer: Relayer;

  beforeEach(() => {
    logger = winston.createLogger();
    relayer = new Relayer(logger);
  });

  it("should initialize with no relay paths", async () => {
    vi.mocked(getRelayPaths).mockResolvedValueOnce([]);
    await relayer.init();
    expect(logger.info).toHaveBeenCalledWith(
      "No relay paths found. Please add a relay path to start relaying messages.",
    );
  });

  it("should initialize with relay paths", async () => {
    await relayer.init();
    expect(logger.info).toHaveBeenCalledWith("Found 1 relay paths.");
    expect(logger.info).toHaveBeenCalledWith(
      "Relay Path: chainA (cosmos) <-> chainB (cosmos)",
    );
  });

  it("should add a new relay path (v1)", async () => {
    await relayer.addNewRelayPath(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, 1,
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Added new relay path: chainA (cosmos) <-> chainB (cosmos)",
    );
  });

  it("should add a new relay path (v2)", async () => {
    await relayer.addNewRelayPath(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, 2,
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Added new relay path: chainA (cosmos) <-> chainB (cosmos)",
    );
  });

  it("should add an existing relay path", async () => {
    await relayer.addExistingRelayPath(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, "clientA", "clientB", 1,
    );
    expect(addRelayPath).toHaveBeenCalledWith(
      "chainA", "nodeA", "chainB", "nodeB", ChainType.Cosmos, ChainType.Cosmos, "clientA", "clientB", 1,
    );
  });

  it("should start and stop the relayer", async () => {
    relayer.relayerLoop = vi.fn();
    await relayer.start();
    expect(relayer["running"]).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("Starting relayer...");
    await relayer.stop();
    expect(relayer["running"]).toBe(false);
    expect(logger.info).toHaveBeenCalledWith("Stopping relayer...");
  });

  it("should emit messageRelayed event", () => {
    relayer.on("messageRelayed", (msg: string) => {
      expect(msg).toBe("test");
    });
    relayer.relayMessage("test");
  });
});
