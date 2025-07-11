import config from "../config";
import {
  ChainType, RelayPaths,
} from "../types";

const updateRelayedHeights = async (pathId: number, relayHeightA: number, relayHeightB: number, ackHeightA: number, ackHeightB: number) => {
  const height = await getRelayedHeights(pathId);
  if (height) {
    if (typeof window != "undefined") {
      const dexie = await import("./dexie");
      await dexie.db.relayedHeights.update(height.id, {
        packetHeightA: relayHeightA,
        packetHeightB: relayHeightB,
        ackHeightA,
        ackHeightB,
      });
    }
    else {
      const sqlite = await import("./sqlite");
      const db = await sqlite.openDB(config.dbFile);
      await db.run("UPDATE relayedHeights SET packetHeightA = ?, packetHeightB = ?, ackHeightA = ?, ackHeightB = ? WHERE id = ?", [relayHeightA, relayHeightB, ackHeightA, ackHeightB, height.id]);
    }
  }
  else {
    throw new Error("Heights not found");
  }
};
const getRelayedHeights = async (pathId: number) => {
  try {
    if (typeof window != "undefined") {
      const dexie = await import("./dexie");
      const res = await dexie.db.relayedHeights.where({
        relayPathId: pathId,
      }).first();
      if (!res) {
        throw new Error("Heights not found");
      }
      return res;
    }
    else {
      const sqlite = await import("./sqlite");
      const db = await sqlite.openDB(config.dbFile);
      const res = await db.get("SELECT * FROM relayedHeights WHERE relayPathId = ?", [pathId]);
      if (!res) {
        throw new Error("Heights not found");
      }
      return res;
    }
  }
  catch (_e) {
    if (typeof window != "undefined") {
      const dexie = await import("./dexie");
      await dexie.db.relayedHeights.add({
        packetHeightA: 0,
        packetHeightB: 0,
        ackHeightA: 0,
        ackHeightB: 0,
        relayPathId: pathId,
      });
    }
    else {
      const sqlite = await import("./sqlite");
      const db = await sqlite.openDB(config.dbFile);
      await db.run("INSERT INTO relayedHeights (packetHeightA, packetHeightB, ackHeightA, ackHeightB, relayPathId) VALUES (?, ?, ?, ?, ?)", [0, 0, 0, 0, pathId]);
    }
    return getRelayedHeights(pathId);
  }
};
const addRelayPath = async (chainIdA: string, nodeA: string, chainIdB: string, nodeB: string, chainTypeA: ChainType, chainTypeB: ChainType, clientIdA: string, clientIdB: string, version: number = 1) => {
  if (typeof window != "undefined") {
    const dexie = await import("./dexie");
    await dexie.db.relayPaths.add({
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
  }
  else {
    const sqlite = await import("./sqlite");
    const db = await sqlite.openDB(config.dbFile);
    await db.run("INSERT INTO relayPaths (chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientA, clientB, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientIdA, clientIdB, version]);
  }
  return await getRelayPath(chainIdA, chainIdB, clientIdA, clientIdB, version);
};
const getRelayPath = async (chainIdA: string, chainIdB: string, clientIdA: string, clientIdB: string, version: number = 1) => {
  if (typeof window != "undefined") {
    const dexie = await import("./dexie");
    return dexie.db.relayPaths.where({
      chainIdA,
      chainIdB,
      clientA: clientIdA,
      clientB: clientIdB,
      version,
    }).first();
  }
  else {
    const sqlite = await import("./sqlite");
    const db = await sqlite.openDB(config.dbFile);
    return db.get("SELECT * FROM relayPaths WHERE chainIdA = ? AND chainIdB = ? AND clientA = ? AND clientB = ? AND version = ?", [chainIdA, chainIdB, clientIdA, clientIdB, version]) as Promise<RelayPaths>;
  }
};
const getRelayPaths = async () => {
  if (typeof window != "undefined") {
    const dexie = await import("./dexie");
    return dexie.db.relayPaths.toArray();
  }
  else {
    const sqlite = await import("./sqlite");
    const db = await sqlite.openDB(config.dbFile);
    return db.all("SELECT * FROM relayPaths") as Promise<RelayPaths[]>;
  }
};
export {
  addRelayPath,
  getRelayedHeights,
  getRelayPath,
  getRelayPaths,
  updateRelayedHeights,
};
