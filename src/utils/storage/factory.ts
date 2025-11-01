import {
  DexieStorage,
} from "./DexieStorage";
import {
  IStorage,
} from "./IStorage";
import {
  SQLiteStorage,
} from "./SQLiteStorage";

/**
 * Creates the appropriate storage implementation based on the runtime environment.
 *
 * @param dbPath - Optional database path (only used for SQLite in Node.js)
 * @returns IStorage implementation (DexieStorage for browser, SQLiteStorage for Node.js)
 *
 * @example
 * ```typescript
 * const storage = createStorage();
 * const fees = await storage.getChainFees("cosmoshub-4");
 * ```
 */
export function createStorage(dbPath?: string): IStorage {
  if (typeof window !== "undefined") {
    return new DexieStorage();
  }
  else {
    return new SQLiteStorage(dbPath);
  }
}
