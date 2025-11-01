import config from "../../config";
import {
  ChainFees,
  ChainType,
  RelayedHeights,
  RelayPaths,
} from "../../types";
import {
  openDB,
} from "../sqlite";
import {
  IStorage,
} from "./IStorage";

/**
 * SQLite-based storage implementation for Node.js environments.
 * Uses better-sqlite3 for synchronous database operations.
 */
export class SQLiteStorage implements IStorage {
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? config.dbFile;
  }

  async addChainFees(chainId: string, gasPrice: number, gasDenom: string): Promise<ChainFees> {
    const db = await openDB(this.dbPath);
    await db.prepare("INSERT INTO chainFees (chainId, gasPrice, gasDenom) VALUES (?, ?, ?)").run([chainId, gasPrice, gasDenom]);
    return this.getChainFees(chainId);
  }

  async getChainFees(chainId: string): Promise<ChainFees> {
    const db = await openDB(this.dbPath);
    const res = await db.prepare("SELECT * FROM chainFees WHERE chainId = ?").get([chainId]);
    if (!res) {
      throw new Error(`Chain fees not found for chain ID: ${chainId}`);
    }
    return res as ChainFees;
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
      const res = await db.prepare("SELECT * FROM relayedHeights WHERE relayPathId = ?").get([pathId]) as unknown as RelayedHeights;
      if (!res) {
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
    chainIdB: string,
    nodeB: string,
    chainTypeA: ChainType,
    chainTypeB: ChainType,
    clientIdA: string,
    clientIdB: string,
    version: number,
  ): Promise<RelayPaths | undefined> {
    const db = await openDB(this.dbPath);
    await db.prepare(
      "INSERT INTO relayPaths (chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientA, clientB, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run([chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientIdA, clientIdB, version]);
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
    return res as RelayPaths | undefined;
  }

  async getRelayPaths(): Promise<RelayPaths[]> {
    const db = await openDB(this.dbPath);
    return db.prepare("SELECT * FROM relayPaths ORDER BY id ASC").all() as unknown as RelayPaths[];
  }
}
