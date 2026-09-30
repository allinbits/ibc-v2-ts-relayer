import {
  Header as TendermintHeader,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  toHex,
} from "@cosmjs/encoding";
import {
  ibc,
} from "@gnolang/gno-types";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

import {
  BaseIbcClient, isGno, isTendermint,
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
  MisbehaviourEvidence,
  MisbehaviourKind,
  MisbehaviourStatus,
  RelayPaths,
} from "../src/types";
import {
  log,
} from "../src/utils/logging";
import {
  GNO_HEADER_TYPE_URL,
} from "../src/utils/misbehaviour";
import {
  storage,
} from "../src/utils/storage";
import {
  atomoneValidatorKeypair,
} from "./helpers/forge-header";
import {
  setupGnoWhitelist,
} from "./setup";

const ATONE = "http://localhost:56657";
const GNO = "http://localhost:46657";
const GNO_GRAPHQL = "http://localhost:8546/graphql/query";
const mnemonic = process.env.RELAYER_MNEMONIC || "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Forge a Tendermint header for AtomOne (its validator key is readable).
type ForgeTendermintHeader = (honest: TendermintHeader, keypair: Awaited<ReturnType<typeof atomoneValidatorKeypair>>) => Promise<TendermintHeader>;
// Forge a Gno header (blocked: gnodev's validator key is not exposed).
type ForgeGnoHeader = (honest: ibc.lightclients.gno.v1.gno.Header) => Promise<ibc.lightclients.gno.v1.gno.Header>;

async function loadTendermintForge(): Promise<ForgeTendermintHeader | undefined> {
  try {
    return (await import("./helpers/forge-header.js")).default as ForgeTendermintHeader;
  }
  catch {
    return undefined;
  }
}

async function loadGnoForge(): Promise<ForgeGnoHeader | undefined> {
  try {
    return (await import("./helpers/forge-gno-header.js")).default as ForgeGnoHeader;
  }
  catch {
    return undefined;
  }
}

const relayer = new Relayer(log);
let monitor: MisbehaviourMonitor;
let path: RelayPaths;
let atone: BaseIbcClient;
let gno: BaseIbcClient;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function narrate(message: string, ...details: string[]) {
  console.log([`[misbehaviour-gno-e2e] ${message}`, ...details.map(detail => `    ${detail}`)].join("\n"));
}

const short = (bytes: Uint8Array) => `${toHex(bytes).slice(0, 16)}…`;

function describeEvidence(evidence: MisbehaviourEvidence): string {
  return `#${evidence.id} ${evidence.kind} on client ${evidence.clientId} (${evidence.hostChainId}) at height ${evidence.revisionHeight}, `
    + `trusted height ${evidence.trustedRevisionHeight}, status ${evidence.status}, `
    + `offending header ${evidence.conflictingHeader ? "recovered" : "not recovered"}`;
}

// Path side A is AtomOne (ibctest-1), hosting the 10-gno client that tracks the
// Gno chain; side B is Gno (dev), hosting the realm's Tendermint client that
// tracks AtomOne.
setupGnoWhitelist(GNO);

beforeAll(async () => {
  narrate("Setting up: keys and gas prices for ibctest-1 (AtomOne) and dev (Gno)");
  await relayer.addMnemonic(mnemonic, "ibctest-1");
  await relayer.addMnemonic(mnemonic, "dev");
  await relayer.addGasPrice("ibctest-1", "0.025", "uphoton");
  await relayer.addGasPrice("dev", "0.025", "ugnot");
  narrate("Creating a fresh AtomOne <-> Gno IBC v2 path (new light clients on both chains)");
  await relayer.addNewRelayPath("ibctest-1", ATONE, undefined, "dev", GNO, GNO_GRAPHQL, ChainType.Cosmos, ChainType.Gno, 2);
  const paths = await storage.getRelayPaths();
  path = paths[paths.length - 1];
  narrate(`Created relay path ${path.id}:`,
    `AtomOne client ${path.clientA} (10-gno) tracks Gno`,
    `Gno client ${path.clientB} (07-tendermint) tracks AtomOne`);

  await relayer.init();
  const link = relayer["links"].get(path.id) as LinkV2;
  // Two honest updates of the Gno realm's Tendermint client from AtomOne.
  for (let i = 1; i <= 2; i++) {
    await sleep(2000);
    const height = await link.updateClient("A");
    narrate(`Honest update ${i}/2: updated Gno client ${path.clientB} with AtomOne's own header at height ${height.revisionHeight}`);
  }

  atone = await connectQueryClient(ChainType.Cosmos, ATONE, undefined, log);
  gno = await connectQueryClient(ChainType.Gno, GNO, GNO_GRAPHQL, log);
  monitor = new MisbehaviourMonitor(log, {
    pathIds: [path.id],
    maxHeightsPerCheck: 1000,
  });
  narrate(`Setup complete; the monitor is limited to path ${path.id}`);
}, 300000);

afterAll(async () => {
  atone?.disconnect();
  gno?.disconnect();
  await monitor?.stop();
  await relayer.stop();
});

describe("misbehaviour monitor against AtomOne and Gno", () => {
  test("reports both clients as active", async () => {
    narrate("Checking: both light clients report status Active before any monitoring");
    const atoneStatus = await atone.getClientStatus(path.clientA);
    const gnoStatus = await gno.getClientStatus(path.clientB);
    narrate("Client statuses:", `AtomOne ${path.clientA}: ${atoneStatus}`, `Gno ${path.clientB}: ${gnoStatus}`);

    expect(atoneStatus).toBe(ClientStatus.Active);
    expect(gnoStatus).toBe(ClientStatus.Active);
  });

  test("finds no misbehaviour on honestly updated clients", async () => {
    narrate("Checking: with both clients updated honestly, one monitor pass records nothing on either side");
    await monitor.checkOnce();

    const evidence = (await storage.getMisbehaviourEvidence()).filter(e => e.relayPathId === path.id);
    if (evidence.length === 0) {
      narrate("Misbehaviour recorded by the monitor: none");
    }
    else {
      narrate(`Misbehaviour recorded by the monitor: ${evidence.length}`, ...evidence.map(describeEvidence));
    }
    expect(evidence).toEqual([]);

    const gnoStates = await gno.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, 0n, 1000);
    const atoneStates = await atone.getConsensusStatesAfter(path.clientA, ClientType.Gno, 0n, 1000);
    const cursorB = await storage.getMonitorCursor(path.id, "B");
    const cursorA = await storage.getMonitorCursor(path.id, "A");
    narrate("Monitor cursors (highest height verified) vs latest stored consensus height:",
      `AtomOne 10-gno client ${path.clientA}: cursor ${cursorA}, latest ${atoneStates[atoneStates.length - 1].revisionHeight}`,
      `Gno tendermint client ${path.clientB}: cursor ${cursorB}, latest ${gnoStates[gnoStates.length - 1].revisionHeight}`);
    expect(cursorB).toBe(Number(gnoStates[gnoStates.length - 1].revisionHeight));
    expect(cursorA).toBe(Number(atoneStates[atoneStates.length - 1].revisionHeight));
  });

  test("recovers the Gno header behind AtomOne's 10-gno consensus state from its update tx", async () => {
    const states = await atone.getConsensusStatesAfter(path.clientA, ClientType.Gno, 0n, 1000);
    const latest = states[states.length - 1];
    narrate(`Checking: the Gno header that created AtomOne client ${path.clientA}'s consensus state at height ${latest.revisionHeight} is recoverable from its MsgUpdateClient tx`);

    const header = await atone.findConflictingHeader(path.clientA, {
      revisionNumber: latest.revisionNumber,
      revisionHeight: latest.revisionHeight,
    });

    expect(header?.typeUrl).toBe(GNO_HEADER_TYPE_URL);
    const decoded = ibc.lightclients.gno.v1.gno.Header.decode(header!.value).signedHeader!.header!;
    const source = await gno.getHeaderSummary(Number(latest.revisionHeight));
    narrate(`Recovered ${header!.typeUrl} from AtomOne's update tx:`,
      `height ${decoded.height} (expected ${latest.revisionHeight})`,
      `app hash ${short(decoded.appHash)} (gno: ${short(source.appHash)})`);
    expect(decoded.height).toBe(latest.revisionHeight);
    expect(decoded.appHash).toEqual(source.appHash);
  });

  test("does not recover a header for the Gno realm's Tendermint client", async () => {
    const [created] = await gno.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, 0n, 1000);
    narrate(`Checking: the Gno realm embeds update headers in MsgRun source, so no header is recoverable for client ${path.clientB}`);

    const header = await gno.findConflictingHeader(path.clientB, {
      revisionNumber: created.revisionNumber,
      revisionHeight: created.revisionHeight,
    });
    narrate(`Header recovered for the Gno tendermint client: ${header ? header.typeUrl : "none"}`);

    expect(header).toBeUndefined();
  });

  // Freeze the Gno realm's Tendermint client with a conflicting AtomOne header.
  // Runnable: AtomOne's validator key is readable, so the Tendermint forger
  // works. The Gno host cannot recover the offending header, so the relayer
  // freezes it with AtomOne's honest header (the realm freezes on the conflict).
  test("freezes the Gno realm's Tendermint client after AtomOne's validator signs a conflicting header", async (ctx) => {
    const forgeConflictingHeader = await loadTendermintForge();
    if (!forgeConflictingHeader) {
      narrate("Skipping: no e2e/helpers/forge-header.ts helper found");
      return ctx.skip();
    }

    const link = relayer["links"].get(path.id) as LinkV2;
    const atoneFunded = link.endA.client;
    const gnoFunded = link.endB.client;
    if (!isTendermint(atoneFunded) || !isGno(gnoFunded)) {
      throw new Error("expected an AtomOne Tendermint client and a Gno client on the path");
    }

    const stored = await gno.getConsensusStatesAfter(path.clientB, ClientType.Tendermint, 0n, 1000);
    const trusted = Number(stored[stored.length - 1].revisionHeight);
    const honest = await atoneFunded.buildHeader(trusted);
    const targetHeight = Number(honest.signedHeader!.header!.height);
    narrate(`Building a conflicting AtomOne header for height ${targetHeight}, trusted from the Gno client's stored height ${trusted}`);

    let forged: TendermintHeader;
    try {
      forged = await forgeConflictingHeader(honest, await atomoneValidatorKeypair());
    }
    catch (e) {
      if (e instanceof Error && e.name === "HeaderForgeNotImplemented") {
        narrate(`Skipping: ${e.message}`);
        return ctx.skip();
      }
      throw e;
    }
    narrate("Forged header vs AtomOne's honest header at the same height:",
      `forged app hash ${short(forged.signedHeader!.header!.appHash)} vs honest ${short(honest.signedHeader!.header!.appHash)}`);
    expect(Number(forged.signedHeader?.header?.height)).toBe(targetHeight);
    expect(toHex(forged.signedHeader!.header!.appHash)).not.toBe(toHex(honest.signedHeader!.header!.appHash));

    narrate(`Installing the forged AtomOne header on Gno client ${path.clientB} via a MsgRun UpdateClient`);
    await gnoFunded.updateTendermintClient(path.clientB, forged);
    expect(await gno.getClientStatus(path.clientB)).toBe(ClientStatus.Active);

    narrate("Running the monitor: it should detect the fork and record pending evidence");
    await monitor.checkOnce();

    const forkEvidence = (await storage.getMisbehaviourEvidence())
      .find(e => e.relayPathId === path.id && e.clientId === path.clientB && e.revisionHeight === targetHeight);
    expect(forkEvidence).toBeDefined();
    narrate("Evidence recorded by the monitor:", describeEvidence(forkEvidence!));
    expect(forkEvidence!.kind).toBe(MisbehaviourKind.Fork);
    expect(forkEvidence!.status).toBe(MisbehaviourStatus.Pending);
    // The Gno realm embeds headers in MsgRun source, so the offending header is
    // not recovered; the relayer freezes with AtomOne's honest header instead.
    expect(forkEvidence!.conflictingHeader).toBeNull();

    narrate("Running the relayer's evidence submission (honest-header freeze path for a Gno host)");
    await relayer.processPendingMisbehaviour();

    const frozenStatus = await gno.getClientStatus(path.clientB);
    const confirmed = (await storage.getMisbehaviourEvidence()).find(e => e.id === forkEvidence!.id)!;
    narrate("After submission:",
      `Gno client ${path.clientB} status: ${frozenStatus}`,
      `evidence #${confirmed.id} status: ${confirmed.status}`);
    expect(frozenStatus).toBe(ClientStatus.Frozen);
    expect(confirmed.status).toBe(MisbehaviourStatus.Confirmed);
  }, 180000);

  // Freeze AtomOne's 10-gno client with a conflicting Gno header. Blocked:
  // gnodev does not expose its validator key, so the Gno header cannot be
  // signed (see e2e/helpers/forge-gno-header.ts). Skips until that changes.
  test("freezes AtomOne's 10-gno client after the Gno validator signs a conflicting header", async (ctx) => {
    const forgeConflictingGnoHeader = await loadGnoForge();
    if (!forgeConflictingGnoHeader) {
      narrate("Skipping: no e2e/helpers/forge-gno-header.ts helper found");
      return ctx.skip();
    }

    const link = relayer["links"].get(path.id) as LinkV2;
    const gnoFunded = link.endB.client;
    if (!isGno(gnoFunded)) {
      throw new Error("expected a Gno client on side B of the path");
    }
    const stored = await atone.getConsensusStatesAfter(path.clientA, ClientType.Gno, 0n, 1000);
    const trusted = Number(stored[stored.length - 1].revisionHeight);
    const honest = await gnoFunded.buildHeader(trusted);

    try {
      await forgeConflictingGnoHeader(honest);
    }
    catch (e) {
      if (e instanceof Error && e.name === "HeaderForgeNotImplemented") {
        narrate(`Skipping: ${e.message}`);
        return ctx.skip();
      }
      throw e;
    }

    throw new Error("forge-gno-header returned a header; implement the AtomOne-side freeze assertions");
  }, 180000);
});
