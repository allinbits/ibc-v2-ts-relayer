import {
  ChainFees,
  ChainType,
  RelayedHeights,
  RelayPaths,
} from "../../types";
import {
  db,
} from "../dexie";
import {
  IStorage,
} from "./IStorage";

/**
 * Dexie/IndexedDB-based storage implementation for browser environments.
 * Uses Dexie.js wrapper for IndexedDB operations.
 */
export class DexieStorage implements IStorage {
  async addChainFees(chainId: string, gasPrice: number, gasDenom: string): Promise<ChainFees> {
    await db.chainFees.add({
      chainId,
      gasPrice,
      gasDenom,
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
    try {
      const res = await db.relayedHeights.where({
        relayPathId: pathId,
      }).first();
      if (!res) {
        throw new Error("Heights not found");
      }
      return res;
    }
    catch (_error) {
      // Initialize if not found
      await db.relayedHeights.add({
        packetHeightA: 0,
        packetHeightB: 0,
        ackHeightA: 0,
        ackHeightB: 0,
        relayPathId: pathId,
      });
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
    await db.relayPaths.add({
      chainIdA,
      nodeA,
      chainIdB,
      nodeB,
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
}
