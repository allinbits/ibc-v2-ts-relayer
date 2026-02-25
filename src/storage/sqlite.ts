import Database from "better-sqlite3";

const baseSchema = `
CREATE TABLE IF NOT EXISTS relayPaths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chainIdA TEXT NOT NULL,
    nodeA TEXT NOT NULL,
    queryNodeA TEXT,
    chainIdB TEXT NOT NULL,
    nodeB TEXT NOT NULL,
    queryNodeB TEXT,
    chainTypeA TEXT NOT NULL,
    chainTypeB TEXT NOT NULL,
    clientA TEXT NOT NULL,
    clientB TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS relayedHeights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    relayPathId INTEGER NOT NULL,
    packetHeightA INTEGER NOT NULL,
    packetHeightB INTEGER NOT NULL,
    ackHeightA INTEGER NOT NULL,
    ackHeightB INTEGER NOT NULL,
    FOREIGN KEY (relayPathId) REFERENCES relayPaths(id)
);
CREATE TABLE IF NOT EXISTS chainFees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chainId TEXT NOT NULL,
    gasPrice DOUBLE NOT NULL,
    gasDenom TEXT NOT NULL,
    UNIQUE (chainId) ON CONFLICT REPLACE
);`;

let cachedDb: Database.Database | null = null;
let cachedDbPath: string | null = null;

export const openDB = async (dbFile: string): Promise<Database.Database> => {
  if (cachedDb && cachedDbPath === dbFile) {
    return cachedDb;
  }
  const db = new Database(dbFile);
  await db.exec(baseSchema);
  cachedDb = db;
  cachedDbPath = dbFile;
  return db;
};

export const closeDB = (): void => {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
    cachedDbPath = null;
  }
};
