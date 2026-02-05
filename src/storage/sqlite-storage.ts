import config from "../config/index.js";
import {
  ChainFees,
  ChainType,
  RelayedHeights,
  RelayPaths,
} from "../types/index.js";
import {
  openDB,
} from "./sqlite.js";
import {
  IStorage,
} from "./storage-interface.js";

/**
 * Type guard for RelayedHeights database result.
 */
function isRelayedHeights(obj: unknown): obj is RelayedHeights {
  return (
    obj !== null
    && typeof obj === "object"
    && "id" in obj
    && "relayPathId" in obj
    && "packetHeightA" in obj
    && "packetHeightB" in obj
    && "ackHeightA" in obj
    && "ackHeightB" in obj
  );
}

/**
 * Type guard for RelayPaths database result.
 */
function isRelayPaths(obj: unknown): obj is RelayPaths {
  return (
    obj !== null
    && typeof obj === "object"
    && "id" in obj
    && "chainIdA" in obj
    && "chainIdB" in obj
    && "clientA" in obj
    && "clientB" in obj
    && "version" in obj
  );
}

/**
 * Type guard for ChainFees database result.
 */
function isChainFees(obj: unknown): obj is ChainFees {
  return (
    obj !== null
    && typeof obj === "object"
    && "id" in obj
    && "chainId" in obj
    && "gasPrice" in obj
    && "gasDenom" in obj
  );
}

/**
 * SQLite-based storage implementation for Node.js environments.
 * Uses better-sqlite3 for synchronous database operations.
 */
export class SQLiteStorage implements IStorage {
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? config.database.file;
  }

  async addChainFees(chainId: string, gasPrice: number, gasDenom: string): Promise<ChainFees> {
    const db = await openDB(this.dbPath);
    await db.prepare("INSERT INTO chainFees (chainId, gasPrice, gasDenom) VALUES (?, ?, ?)").run([chainId, gasPrice, gasDenom]);
    return this.getChainFees(chainId);
  }

  async getChainFees(chainId: string): Promise<ChainFees> {
    const db = await openDB(this.dbPath);
    const res = await db.prepare("SELECT * FROM chainFees WHERE chainId = ?").get([chainId]);
    if (!isChainFees(res)) {
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

    const db = await openDB(this.dbPath);
    await db.prepare(
      "UPDATE relayedHeights SET packetHeightA = ?, packetHeightB = ?, ackHeightA = ?, ackHeightB = ? WHERE id = ?",
    ).run([packetHeightA, packetHeightB, ackHeightA, ackHeightB, height.id]);
  }

  async getRelayedHeights(pathId: number): Promise<RelayedHeights> {
    try {
      const db = await openDB(this.dbPath);
      const res = await db.prepare("SELECT * FROM relayedHeights WHERE relayPathId = ?").get([pathId]);
      if (!isRelayedHeights(res)) {
        throw new Error("Heights not found");
      }
      return res;
    }
    catch (_error) {
      // Initialize if not found
      const db = await openDB(this.dbPath);
      await db.prepare(
        "INSERT INTO relayedHeights (packetHeightA, packetHeightB, ackHeightA, ackHeightB, relayPathId) VALUES (?, ?, ?, ?, ?)",
      ).run([0, 0, 0, 0, pathId]);
      return this.getRelayedHeights(pathId);
    }
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
    version: number = 1,
  ): Promise<RelayPaths | undefined> {
    const db = await openDB(this.dbPath);
    await db.prepare(
      "INSERT INTO relayPaths (chainIdA, nodeA, queryNodeA, chainIdB, nodeB, queryNodeB, chainTypeA, chainTypeB, clientA, clientB, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run([chainIdA, nodeA, queryNodeA, chainIdB, nodeB, queryNodeB, chainTypeA, chainTypeB, clientIdA, clientIdB, version]);
    return this.getRelayPath(chainIdA, chainIdB, clientIdA, clientIdB, version);
  }

  async getRelayPath(
    chainIdA: string,
    chainIdB: string,
    clientIdA: string,
    clientIdB: string,
    version: number,
  ): Promise<RelayPaths | undefined> {
    const db = await openDB(this.dbPath);
    const res = await db.prepare(
      "SELECT * FROM relayPaths WHERE chainIdA = ? AND chainIdB = ? AND clientA = ? AND clientB = ? AND version = ?",
    ).get([chainIdA, chainIdB, clientIdA, clientIdB, version]);
    if (res === undefined) {
      return undefined;
    }
    if (!isRelayPaths(res)) {
      throw new Error(`Invalid relay path data for chain ${chainIdA} <-> ${chainIdB}`);
    }
    return res;
  }

  async getRelayPaths(): Promise<RelayPaths[]> {
    const db = await openDB(this.dbPath);
    const results = await db.prepare("SELECT * FROM relayPaths ORDER BY id ASC").all();
    return results.filter(isRelayPaths);
  }
}
