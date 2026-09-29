import {
  Header as TendermintHeader,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

import {
  BaseIbcClient,
} from "../src/clients/BaseIbcClient";
import {
  Link as LinkV2,
} from "../src/links/v2/link";
import {
  connectQueryClient,
} from "../src/misbehaviour/clients";
import {
  MisbehaviourMonitor,
} from "../src/misbehaviour/monitor";
import {
  Relayer,
} from "../src/relayer";
import {
  ChainType,
  ClientStatus,
  ClientType,
  RelayPaths,
} from "../src/types";
import {
  log,
} from "../src/utils/logging";
import {
  TENDERMINT_HEADER_TYPE_URL,
} from "../src/utils/misbehaviour";
import {
  storage,
} from "../src/utils/storage";

const MARS = "http://localhost:26657";
const VENUS = "http://localhost:36657";
const mnemonic = process.env.RELAYER_MNEMONIC || "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const relayer = new Relayer(log);
let monitor: MisbehaviourMonitor;
let path: RelayPaths;
let mars: BaseIbcClient;
let venus: BaseIbcClient;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Side B of the path is venus, whose client tracks mars.
beforeAll(async () => {
  await relayer.addMnemonic(mnemonic, "mars");
  await relayer.addMnemonic(mnemonic, "venus");
  await relayer.addGasPrice("mars", "0.025", "umars");
  await relayer.addGasPrice("venus", "0.025", "uvenus");
  // A fresh path, so freezing or inspecting its clients cannot affect the
  // paths other e2e suites use.
  await relayer.addNewRelayPath("mars", MARS, undefined, "venus", VENUS, undefined, ChainType.Cosmos, ChainType.Cosmos, 2);
  const paths = await storage.getRelayPaths();
  path = paths[paths.length - 1];

  await relayer.init();
  const link = relayer["links"].get(path.id) as LinkV2;
  // Two honest updates of venus's client, each from its own update tx.
  for (let i = 0; i < 2; i++) {
    await sleep(2000);
    await link.updateClient("A");
  }

  mars = await connectQueryClient(ChainType.Cosmos, MARS, undefined, log);
  venus = await connectQueryClient(ChainType.Cosmos, VENUS, undefined, log);
  monitor = new MisbehaviourMonitor(log, {
    pathIds: [path.id],
    maxHeightsPerCheck: 1000,
  });
}, 180000);

afterAll(async () => {
  mars?.disconnect();
  venus?.disconnect();
  await monitor?.stop();
  await relayer.stop();
});

describe("misbehaviour monitor against live chains", () => {
  test("reports both clients as active", async () => {
    expect(await mars.getClientStatus(path.clientA)).toBe(ClientStatus.Active);
    expect(await venus.getClientStatus(path.clientB)).toBe(ClientStatus.Active);
  });

  test("finds no misbehaviour on honestly updated clients", async () => {
    await monitor.checkOnce();

    const evidence = (await storage.getMisbehaviourEvidence()).filter(e => e.relayPathId === path.id);
    expect(evidence).toEqual([]);
    const venusStates = await venus.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, 0n, 1000);
    const marsStates = await mars.getConsensusStatesAfter(path.clientA, ClientType.Tendermint, 0n, 1000);
    // Every stored consensus state was verified against the source chain.
    expect(await storage.getMonitorCursor(path.id, "B")).toBe(Number(venusStates[venusStates.length - 1].revisionHeight));
    expect(await storage.getMonitorCursor(path.id, "A")).toBe(Number(marsStates[marsStates.length - 1].revisionHeight));
  });

  test("lists venus's consensus states in height order", async () => {
    const states = await venus.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, 0n, 1000);

    // Created at one height, then updated twice.
    expect(states.length).toBeGreaterThanOrEqual(3);
    const heights = states.map(s => s.revisionHeight);
    expect([...heights].sort((a, b) => Number(a - b))).toEqual(heights);
    const after = await venus.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, heights[0], 1000);
    expect(after.map(s => s.revisionHeight)).toEqual(heights.slice(1));
  });

  test("recovers the header behind a consensus state from its update tx", async () => {
    const states = await venus.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, 0n, 1000);
    const latest = states[states.length - 1];

    const header = await venus.findConflictingHeader(path.clientB, {
      revisionNumber: latest.revisionNumber,
      revisionHeight: latest.revisionHeight,
    });

    expect(header?.typeUrl).toBe(TENDERMINT_HEADER_TYPE_URL);
    const decoded = TendermintHeader.decode(header!.value).signedHeader!.header!;
    const source = await mars.getHeaderSummary(Number(latest.revisionHeight));
    expect(decoded.height).toBe(latest.revisionHeight);
    expect(decoded.appHash).toEqual(source.appHash);
    expect(decoded.nextValidatorsHash).toEqual(source.nextValidatorsHash);
  });

  test("finds no update tx for the consensus state the client was created with", async () => {
    const [created] = await venus.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, 0n, 1000);

    expect(await venus.findConflictingHeader(path.clientB, {
      revisionNumber: created.revisionNumber,
      revisionHeight: created.revisionHeight,
    })).toBeUndefined();
  });

  // Needs a header for a mars height that mars never committed but that its
  // validator signed, installed on venus's client. Supply the forging helper
  // (the validator key is at /home/tendermint/.mars/config/priv_validator_key.json
  // in the mars container), then: monitor.checkOnce() records pending
  // evidence with the offending header, relayer.processPendingMisbehaviour()
  // submits it, and venus's client reports Frozen.
  test.todo("freezes venus's client after mars's validator signs a conflicting header");
});
