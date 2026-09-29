import {
  Header as TendermintHeader,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  toHex,
} from "@cosmjs/encoding";
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
  ConsensusStateSummary,
  MisbehaviourEvidence,
  RelayPaths,
} from "../src/types";
import {
  log,
} from "../src/utils/logging";
import {
  detectConsensusStateConflict,
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

function narrate(message: string, ...details: string[]) {
  console.log([`[misbehaviour-e2e] ${message}`, ...details.map(detail => `    ${detail}`)].join("\n"));
}

const short = (bytes: Uint8Array) => `${toHex(bytes).slice(0, 16)}…`;

function describeEvidence(evidence: MisbehaviourEvidence): string {
  return `#${evidence.id} ${evidence.kind} on client ${evidence.clientId} (${evidence.hostChainId}) at height ${evidence.revisionHeight}, `
    + `trusted height ${evidence.trustedRevisionHeight}, status ${evidence.status}, `
    + `offending header ${evidence.conflictingHeader ? "recovered" : "not recovered"}`;
}

/**
 * Independently of the monitor, compares each consensus state a client stores
 * with the source chain's header at the same height and prints the result.
 */
async function compareWithSource(host: BaseIbcClient, clientId: string, source: BaseIbcClient): Promise<{
  state: ConsensusStateSummary
  conflict: string | undefined
}[]> {
  const states = await host.getConsensusStatesAfter(clientId, ClientType.Tendermint, 0n, 1000);
  const rows = [];
  const lines = [];
  for (const state of states) {
    const header = await source.getHeaderSummary(Number(state.revisionHeight));
    const conflict = detectConsensusStateConflict(state, header);
    rows.push({
      state,
      conflict,
    });
    lines.push(`height ${state.revisionHeight}: stored root ${short(state.root)} vs ${source.chainId} app hash ${short(header.appHash)}, `
      + `next validators ${short(state.nextValidatorsHash)} vs ${short(header.nextValidatorsHash)} -> ${conflict ? `CONFLICT (${conflict})` : "match"}`);
  }
  narrate(`Client ${clientId} on ${host.chainId} (tracks ${source.chainId}) stores ${states.length} consensus states:`, ...lines);
  return rows;
}

// Side A of the path is mars, whose client tracks venus; side B is venus,
// whose client tracks mars.
beforeAll(async () => {
  narrate("Setting up: keys and gas prices for mars and venus");
  await relayer.addMnemonic(mnemonic, "mars");
  await relayer.addMnemonic(mnemonic, "venus");
  await relayer.addGasPrice("mars", "0.025", "umars");
  await relayer.addGasPrice("venus", "0.025", "uvenus");
  // A fresh path, so freezing or inspecting its clients cannot affect the
  // paths other e2e suites use.
  narrate("Creating a fresh mars <-> venus IBC v2 path (new light clients on both chains)");
  await relayer.addNewRelayPath("mars", MARS, undefined, "venus", VENUS, undefined, ChainType.Cosmos, ChainType.Cosmos, 2);
  const paths = await storage.getRelayPaths();
  path = paths[paths.length - 1];
  narrate(`Created relay path ${path.id}:`,
    `mars client ${path.clientA} tracks venus`,
    `venus client ${path.clientB} tracks mars`);

  await relayer.init();
  const link = relayer["links"].get(path.id) as LinkV2;
  // Two honest updates of venus's client, each from its own update tx.
  for (let i = 1; i <= 2; i++) {
    await sleep(2000);
    const height = await link.updateClient("A");
    narrate(`Honest update ${i}/2: updated venus client ${path.clientB} with mars's own header at height ${height.revisionHeight}`);
  }

  mars = await connectQueryClient(ChainType.Cosmos, MARS, undefined, log);
  venus = await connectQueryClient(ChainType.Cosmos, VENUS, undefined, log);
  monitor = new MisbehaviourMonitor(log, {
    pathIds: [path.id],
    maxHeightsPerCheck: 1000,
  });
  narrate(`Setup complete; the monitor is limited to path ${path.id}`);
}, 180000);

afterAll(async () => {
  mars?.disconnect();
  venus?.disconnect();
  await monitor?.stop();
  await relayer.stop();
});

describe("misbehaviour monitor against live chains", () => {
  test("reports both clients as active", async () => {
    narrate("Checking: both light clients report status Active before any monitoring");
    const marsStatus = await mars.getClientStatus(path.clientA);
    const venusStatus = await venus.getClientStatus(path.clientB);
    narrate("Client statuses:", `mars ${path.clientA}: ${marsStatus}`, `venus ${path.clientB}: ${venusStatus}`);

    expect(marsStatus).toBe(ClientStatus.Active);
    expect(venusStatus).toBe(ClientStatus.Active);
  });

  test("finds no misbehaviour on honestly updated clients", async () => {
    narrate("Checking: every consensus state on both clients matches the header its source chain committed, so the monitor must record no misbehaviour");
    const venusRows = await compareWithSource(venus, path.clientB, mars);
    const marsRows = await compareWithSource(mars, path.clientA, venus);
    expect(venusRows.filter(row => row.conflict)).toEqual([]);
    expect(marsRows.filter(row => row.conflict)).toEqual([]);

    narrate(`Running one monitor pass over path ${path.id}`);
    await monitor.checkOnce();

    const evidence = (await storage.getMisbehaviourEvidence()).filter(e => e.relayPathId === path.id);
    if (evidence.length === 0) {
      narrate("Misbehaviour recorded by the monitor: none");
    }
    else {
      narrate(`Misbehaviour recorded by the monitor: ${evidence.length}`, ...evidence.map(describeEvidence));
    }
    expect(evidence).toEqual([]);

    // Every stored consensus state was verified against the source chain.
    const cursorA = await storage.getMonitorCursor(path.id, "A");
    const cursorB = await storage.getMonitorCursor(path.id, "B");
    const latestA = Number(marsRows[marsRows.length - 1].state.revisionHeight);
    const latestB = Number(venusRows[venusRows.length - 1].state.revisionHeight);
    narrate("Monitor cursors (highest height verified) vs latest stored consensus height:",
      `mars client ${path.clientA}: cursor ${cursorA}, latest ${latestA}`,
      `venus client ${path.clientB}: cursor ${cursorB}, latest ${latestB}`);
    expect(cursorB).toBe(latestB);
    expect(cursorA).toBe(latestA);
  });

  test("lists venus's consensus states in height order", async () => {
    narrate("Checking: consensus states come back in ascending height order, and filtering by height skips already-checked states");
    const states = await venus.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, 0n, 1000);
    const heights = states.map(s => s.revisionHeight);
    narrate(`Venus client ${path.clientB} consensus heights: ${heights.join(", ")}`);

    // Created at one height, then updated twice.
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect([...heights].sort((a, b) => Number(a - b))).toEqual(heights);
    const after = await venus.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, heights[0], 1000);
    narrate(`Heights after ${heights[0]}: ${after.map(s => s.revisionHeight).join(", ")}`);
    expect(after.map(s => s.revisionHeight)).toEqual(heights.slice(1));
  });

  test("recovers the header behind a consensus state from its update tx", async () => {
    const states = await venus.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, 0n, 1000);
    const latest = states[states.length - 1];
    narrate(`Checking: the header that created venus client ${path.clientB}'s consensus state at height ${latest.revisionHeight} can be recovered from its MsgUpdateClient tx (the monitor does this to build Misbehaviour evidence)`);

    const header = await venus.findConflictingHeader(path.clientB, {
      revisionNumber: latest.revisionNumber,
      revisionHeight: latest.revisionHeight,
    });

    expect(header?.typeUrl).toBe(TENDERMINT_HEADER_TYPE_URL);
    const decoded = TendermintHeader.decode(header!.value).signedHeader!.header!;
    const source = await mars.getHeaderSummary(Number(latest.revisionHeight));
    narrate(`Recovered ${header!.typeUrl} from venus's update tx:`,
      `height ${decoded.height} (expected ${latest.revisionHeight})`,
      `app hash ${short(decoded.appHash)} (mars: ${short(source.appHash)})`,
      `next validators hash ${short(decoded.nextValidatorsHash)} (mars: ${short(source.nextValidatorsHash)})`);
    expect(decoded.height).toBe(latest.revisionHeight);
    expect(decoded.appHash).toEqual(source.appHash);
    expect(decoded.nextValidatorsHash).toEqual(source.nextValidatorsHash);
  });

  test("finds no update tx for the consensus state the client was created with", async () => {
    const [created] = await venus.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, 0n, 1000);
    narrate(`Checking: the consensus state at height ${created.revisionHeight} came from MsgCreateClient, not an update, so no header should be recovered`);

    const header = await venus.findConflictingHeader(path.clientB, {
      revisionNumber: created.revisionNumber,
      revisionHeight: created.revisionHeight,
    });
    narrate(`Header recovered for height ${created.revisionHeight}: ${header ? header.typeUrl : "none"}`);

    expect(header).toBeUndefined();
  });

  // Needs a header for a mars height that mars never committed but that its
  // validator signed, installed on venus's client. Supply the forging helper
  // (the validator key is at /home/tendermint/.mars/config/priv_validator_key.json
  // in the mars container), then: monitor.checkOnce() records pending
  // evidence with the offending header, relayer.processPendingMisbehaviour()
  // submits it, and venus's client reports Frozen.
  test.todo("freezes venus's client after mars's validator signs a conflicting header");
});
