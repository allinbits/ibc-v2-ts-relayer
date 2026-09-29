import {
  ChainFees,
  ChainType,
  MisbehaviourEvidence,
  MisbehaviourEvidenceUpdate,
  MisbehaviourStatus,
  NewMisbehaviourEvidence,
  PathSide,
  RelayedHeights,
  RelayPaths,
} from "../types/index.js";
import {
  db,
} from "./dexie.js";
import {
  IStorage,
} from "./storage-interface.js";

/**
 * Dexie/IndexedDB-based storage implementation for browser environments.
 * Uses Dexie.js wrapper for IndexedDB operations.
 */
export class DexieStorage implements IStorage {
  async addChainFees(chainId: string, gasPrice: number, gasDenom: string, gasAdjustment: number = 1.4): Promise<ChainFees> {
    await db.chainFees.add({
      chainId,
      gasPrice,
      gasDenom,
      gasAdjustment,
    });
    return this.getChainFees(chainId);
  }

  async getChainFees(chainId: string): Promise<ChainFees> {
    const res = await db.chainFees.where({
      chainId,
    }).first();
    if (!res) {
      throw new Error(`Chain fees not found for chain ID: ${chainId}`);
    }
    return res;
  }

  async updateRelayedHeights(
    pathId: number,
    packetHeightA: number,
    packetHeightB: number,
    ackHeightA: number,
    ackHeightB: number,
  ): Promise<void> {
    const height = await this.getRelayedHeights(pathId);
    if (!height) {
      throw new Error(`Relayed heights not found for path ID: ${pathId}`);
    }

    await db.relayedHeights.update(height.id, {
      packetHeightA,
      packetHeightB,
      ackHeightA,
      ackHeightB,
    });
  }

  async getRelayedHeights(pathId: number): Promise<RelayedHeights> {
    const res = await db.relayedHeights.where({
      relayPathId: pathId,
    }).first();
    if (res) {
      return res;
    }
    // Initialize if not found
    await db.relayedHeights.add({
      packetHeightA: 0,
      packetHeightB: 0,
      ackHeightA: 0,
      ackHeightB: 0,
      relayPathId: pathId,
    });
    const inserted = await db.relayedHeights.where({
      relayPathId: pathId,
    }).first();
    if (!inserted) {
      throw new Error(`Failed to initialize relayed heights for path ${pathId}`);
    }
    return inserted;
  }

  async addRelayPath(
    chainIdA: string,
    nodeA: string,
    queryNodeA: string | undefined,
    chainIdB: string,
    nodeB: string,
    queryNodeB: string | undefined,
    chainTypeA: ChainType,
    chainTypeB: ChainType,
    clientIdA: string,
    clientIdB: string,
    version: number,
  ): Promise<RelayPaths | undefined> {
    await db.relayPaths.add({
      chainIdA,
      nodeA,
      queryNodeA,
      chainIdB,
      nodeB,
      queryNodeB,
      chainTypeA,
      chainTypeB,
      clientA: clientIdA,
      clientB: clientIdB,
      version,
    });
    return this.getRelayPath(chainIdA, chainIdB, clientIdA, clientIdB, version);
  }

  async getRelayPath(
    chainIdA: string,
    chainIdB: string,
    clientIdA: string,
    clientIdB: string,
    version: number,
  ): Promise<RelayPaths | undefined> {
    return db.relayPaths.where({
      chainIdA,
      chainIdB,
      clientA: clientIdA,
      clientB: clientIdB,
      version,
    }).first();
  }

  async getRelayPaths(): Promise<RelayPaths[]> {
    return db.relayPaths.orderBy("id").toArray();
  }

  private findMisbehaviourEvidence(evidence: NewMisbehaviourEvidence) {
    return db.misbehaviourEvidence.where("[hostChainId+clientId+revisionNumber+revisionHeight]")
      .equals([evidence.hostChainId, evidence.clientId, evidence.revisionNumber, evidence.revisionHeight])
      .first();
  }

  async addMisbehaviourEvidence(evidence: NewMisbehaviourEvidence): Promise<MisbehaviourEvidence> {
    const existing = await this.findMisbehaviourEvidence(evidence);
    if (existing) {
      return existing;
    }
    const now = Date.now();
    await db.misbehaviourEvidence.add({
      ...evidence,
      attempts: 0,
      txHash: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const inserted = await this.findMisbehaviourEvidence(evidence);
    if (!inserted) {
      throw new Error(`Failed to store misbehaviour evidence for client ${evidence.clientId} on ${evidence.hostChainId}`);
    }
    return inserted;
  }

  async getMisbehaviourEvidence(status?: MisbehaviourStatus): Promise<MisbehaviourEvidence[]> {
    const records = status === undefined
      ? await db.misbehaviourEvidence.toArray()
      : await db.misbehaviourEvidence.where({
        status,
      }).toArray();
    return records.sort((a, b) => a.id - b.id);
  }

  async updateMisbehaviourEvidence(id: number, update: MisbehaviourEvidenceUpdate): Promise<void> {
    const changed = await db.misbehaviourEvidence.update(id, {
      ...update,
      updatedAt: Date.now(),
    });
    if (changed === 0) {
      throw new Error(`Misbehaviour evidence not found: ${id}`);
    }
  }

  async getMonitorCursor(pathId: number, side: PathSide): Promise<number> {
    const cursor = await db.monitorCursors.where("[relayPathId+side]").equals([pathId, side]).first();
    return cursor?.lastCheckedRevisionHeight ?? 0;
  }

  async setMonitorCursor(pathId: number, side: PathSide, revisionHeight: number): Promise<void> {
    const cursor = await db.monitorCursors.where("[relayPathId+side]").equals([pathId, side]).first();
    if (cursor) {
      await db.monitorCursors.update(cursor.id, {
        lastCheckedRevisionHeight: revisionHeight,
      });
    }
    else {
      await db.monitorCursors.add({
        relayPathId: pathId,
        side,
        lastCheckedRevisionHeight: revisionHeight,
      });
    }
  }
}
