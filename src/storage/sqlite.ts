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
    gasAdjustment DOUBLE NOT NULL DEFAULT 1.4,
    UNIQUE (chainId) ON CONFLICT REPLACE
);
CREATE TABLE IF NOT EXISTS misbehaviourEvidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    relayPathId INTEGER NOT NULL,
    side TEXT NOT NULL,
    hostChainId TEXT NOT NULL,
    clientId TEXT NOT NULL,
    revisionNumber INTEGER NOT NULL,
    revisionHeight INTEGER NOT NULL,
    trustedRevisionHeight INTEGER NOT NULL,
    kind TEXT NOT NULL,
    conflictingHeader TEXT,
    conflictingHeaderTypeUrl TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    txHash TEXT,
    error TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (relayPathId) REFERENCES relayPaths(id),
    UNIQUE (hostChainId, clientId, revisionNumber, revisionHeight)
);
CREATE TABLE IF NOT EXISTS monitorCursors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    relayPathId INTEGER NOT NULL,
    side TEXT NOT NULL,
    lastCheckedRevisionHeight INTEGER NOT NULL,
    FOREIGN KEY (relayPathId) REFERENCES relayPaths(id),
    UNIQUE (relayPathId, side)
);`;

// The relayer and the misbehaviour monitor run as separate processes sharing
// this database: WAL lets the monitor write while the relayer reads, and the
// busy timeout makes a writer wait for the other's lock instead of failing.
const BUSY_TIMEOUT_MS = 10_000;

let cachedDb: Database.Database | null = null;
let cachedDbPath: string | null = null;

export const openDB = async (dbFile: string): Promise<Database.Database> => {
  if (cachedDb && cachedDbPath === dbFile) {
    return cachedDb;
  }
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
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
