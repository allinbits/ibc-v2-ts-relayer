import {
  open,
} from "sqlite";
import sqlite3 from "sqlite3";

// this is a top-level await
export const openDB = async (dbFile: string) => {
  // open the database
  const db = await open({
    filename: dbFile,
    driver: sqlite3.Database,
  });

  const baseSchema = `
CREATE TABLE IF NOT EXISTS relayPaths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chainIdA TEXT NOT NULL,
    nodeA TEXT NOT NULL,
    chainIdB TEXT NOT NULL,
    nodeB TEXT NOT NULL,
    chainTypeA TEXT NOT NULL,
    chainTypeB TEXT NOT NULL,
    clientA TEXT NOT NULL,
    clientB TEXT NOT NULL,
    version INTEHER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS relayedHeights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    relayPathId INTEGER NOT NULL,
    packetHeightA INTEGER NOT NULL,
    packetHeightB INTEGER NOT NULL,
    ackHeightA INTEGER NOT NULL,
    ackHeightB INTEGER NOT NULL,
    FOREIGN KEY (relayPathId) REFERENCES relayPaths(id)
);`;
  await db.exec(baseSchema);
  return db;
};
