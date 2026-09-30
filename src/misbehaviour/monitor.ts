import {
  toBase64,
} from "@cosmjs/encoding";
import * as winston from "winston";

import {
  BaseIbcClient,
} from "../clients/BaseIbcClient.js";
import config from "../config/index.js";
import {
  closeDB,
} from "../storage/sqlite.js";
import {
  ClientStatus,
  MisbehaviourStatus,
  PathSide,
  RelayPaths,
} from "../types/index.js";
import {
  detectConsensusStateConflict,
} from "../utils/misbehaviour.js";
import {
  storage,
} from "../utils/storage.js";
import {
  getErrorMessage,
} from "../utils/utils.js";
import {
  connectQueryClient, resolveClientId,
} from "./clients.js";

export interface MonitorOptions {
  /** Poll interval in milliseconds */
  poll: number
  /** Maximum consensus states checked per client per poll */
  maxHeightsPerCheck: number
  /** Record detected misbehaviour without asking the relayer to submit it */
  dryRun: boolean
  /** Only monitor these relay path IDs (all paths if unset) */
  pathIds?: number[]
}

interface MonitoredPath {
  path: RelayPaths
  chainA: BaseIbcClient
  chainB: BaseIbcClient
  /** Light client on chain A that tracks chain B */
  clientIdA: string
  /** Light client on chain B that tracks chain A */
  clientIdB: string
}

/**
 * Watches the light clients of every relay path for misbehaviour: consensus
 * states that the chain they track never committed. Detected misbehaviour is
 * recorded in the shared database, where the relayer picks it up and submits
 * the evidence. The monitor only queries chains and never signs.
 */
export class MisbehaviourMonitor {
  private readonly logger: winston.Logger;
  private readonly options: MonitorOptions;
  private paths = new Map<number, MonitoredPath>();
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(logger: winston.Logger, options: Partial<MonitorOptions> = {
  }) {
    this.logger = logger;
    this.options = {
      poll: config.monitor.pollInterval,
      maxHeightsPerCheck: config.monitor.maxHeightsPerCheck,
      dryRun: false,
      ...options,
    };
  }

  async start() {
    this.running = true;
    this.logger.info(`Starting misbehaviour monitor${this.options.dryRun ? " (dry run)" : ""}...`);
    this.loopPromise = this.monitorLoop();
  }

  async stop() {
    this.running = false;
    this.logger.info("Stopping misbehaviour monitor...");
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    for (const monitored of this.paths.values()) {
      this.disconnect(monitored);
    }
    this.paths.clear();
    closeDB();
  }

  private disconnect(monitored: MonitoredPath) {
    for (const client of [monitored.chainA, monitored.chainB]) {
      try {
        client.disconnect();
      }
      catch { /* ignore */ }
    }
  }

  // Picks up paths added to or removed from the database since the last poll,
  // like Relayer.init().
  async init() {
    const wanted = this.options.pathIds;
    const paths = (await storage.getRelayPaths()).filter(path => !wanted || wanted.includes(path.id));
    for (const path of paths) {
      if (this.paths.has(path.id)) {
        continue;
      }
      try {
        const chainA = await connectQueryClient(path.chainTypeA, path.nodeA, path.queryNodeA, this.logger);
        const chainB = await connectQueryClient(path.chainTypeB, path.nodeB, path.queryNodeB, this.logger);
        this.paths.set(path.id, {
          path,
          chainA,
          chainB,
          clientIdA: await resolveClientId(chainA, path.clientA, path.version),
          clientIdB: await resolveClientId(chainB, path.clientB, path.version),
        });
        this.logger.info(`Monitoring path ${path.id}: ${path.chainIdA} <-> ${path.chainIdB}`);
      }
      catch (e) {
        this.logger.error(`Failed to set up monitoring for path ${path.id}: ${getErrorMessage(e)}`);
      }
    }
    const activeIds = new Set(paths.map(path => path.id));
    for (const [id, monitored] of this.paths.entries()) {
      if (!activeIds.has(id)) {
        this.logger.info(`No longer monitoring path ${id}`);
        this.disconnect(monitored);
        this.paths.delete(id);
      }
    }
  }

  /** Checks every monitored client once. */
  async checkOnce() {
    await this.init();
    for (const monitored of this.paths.values()) {
      for (const side of ["A", "B"] as const) {
        try {
          await this.checkClient(monitored, side);
        }
        catch (e) {
          this.logger.error(`Failed to check side ${side} of path ${monitored.path.id}: ${getErrorMessage(e)}`);
        }
      }
    }
  }

  /**
   * Compares the consensus states stored since the last check on one side's
   * client with the headers of the chain that client tracks.
   */
  async checkClient(monitored: MonitoredPath, side: PathSide) {
    const {
      path,
    } = monitored;
    const host = side === "A" ? monitored.chainA : monitored.chainB;
    const source = side === "A" ? monitored.chainB : monitored.chainA;
    const clientId = side === "A" ? monitored.clientIdA : monitored.clientIdB;

    const status = await host.getClientStatus(clientId);
    if (status !== ClientStatus.Active) {
      this.logger.debug(`Skipping client ${clientId} on ${host.chainId}: ${status}`);
      return;
    }

    const cursor = await storage.getMonitorCursor(path.id, side);
    const consensusStates = await host.getConsensusStatesAfter(clientId, source.clientType, BigInt(cursor), this.options.maxHeightsPerCheck);
    if (consensusStates.length === 0) {
      return;
    }
    const sourceHeight = await source.currentHeight();
    let checked = cursor;
    let trusted = cursor;
    for (const consensusState of consensusStates) {
      const height = Number(consensusState.revisionHeight);
      if (height > sourceHeight) {
        // The source chain has not produced this block yet (or the node lags);
        // it can only be compared once it has.
        this.logger.warn(`Client ${clientId} on ${host.chainId} has a consensus state at height ${height}, above ${source.chainId}'s current height ${sourceHeight}`);
        break;
      }
      let header;
      try {
        header = await source.getHeaderSummary(height);
      }
      catch (e) {
        // Most likely pruned by the source node; unverifiable, so it cannot
        // serve as the trusted height for evidence either.
        this.logger.warn(`Cannot verify consensus state at height ${height} of client ${clientId} on ${host.chainId}: ${getErrorMessage(e)}`);
        checked = height;
        continue;
      }
      const kind = detectConsensusStateConflict(consensusState, header);
      if (kind) {
        await this.recordMisbehaviour(monitored, side, host, clientId, consensusState.revisionNumber, height, trusted, kind);
        // The relayer will freeze the client; nothing after this height matters.
        checked = height;
        break;
      }
      checked = height;
      trusted = height;
    }
    if (checked > cursor) {
      await storage.setMonitorCursor(path.id, side, checked);
    }
  }

  private async recordMisbehaviour(
    monitored: MonitoredPath,
    side: PathSide,
    host: BaseIbcClient,
    clientId: string,
    revisionNumber: bigint,
    height: number,
    trusted: number,
    kind: ReturnType<typeof detectConsensusStateConflict>,
  ) {
    let conflictingHeader;
    try {
      conflictingHeader = await host.findConflictingHeader(clientId, {
        revisionNumber,
        revisionHeight: BigInt(height),
      });
    }
    catch (e) {
      this.logger.warn(`Could not recover the header behind client ${clientId}'s consensus state at height ${height}: ${getErrorMessage(e)}`);
    }
    const evidence = await storage.addMisbehaviourEvidence({
      relayPathId: monitored.path.id,
      side,
      hostChainId: host.chainId,
      clientId,
      revisionNumber: Number(revisionNumber),
      revisionHeight: height,
      trustedRevisionHeight: trusted,
      kind: kind!,
      conflictingHeader: conflictingHeader ? toBase64(conflictingHeader.value) : null,
      conflictingHeaderTypeUrl: conflictingHeader?.typeUrl ?? null,
      status: this.options.dryRun ? MisbehaviourStatus.DryRun : MisbehaviourStatus.Pending,
    });
    this.logger.error(`MISBEHAVIOUR (${kind}) detected on client ${clientId} on ${host.chainId} at height ${height}${this.options.dryRun ? " (dry run: not submitting)" : ""}`, {
      evidenceId: evidence.id,
      relayPathId: monitored.path.id,
      trustedHeight: trusted,
      offendingHeaderRecovered: conflictingHeader !== undefined,
    });
  }

  private async monitorLoop() {
    while (this.running) {
      try {
        await this.checkOnce();
      }
      catch (e) {
        this.logger.error(`Error in monitor loop: ${getErrorMessage(e)}`);
      }
      await new Promise(resolve => setTimeout(resolve, this.options.poll));
    }
  }
}
