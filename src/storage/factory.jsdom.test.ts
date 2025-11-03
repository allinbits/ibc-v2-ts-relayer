// @vitest-environment happy-dom

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DexieStorage,
} from "./dexie-storage.js";
import {
  createStorage,
} from "./factory.js";
import {
  SQLiteStorage,
} from "./sqlite-storage.js";

vi.mock("./dexie-storage.js", () => ({
  DexieStorage: vi.fn(),
}));

vi.mock("./sqlite-storage.js", () => ({
  SQLiteStorage: vi.fn(),
}));

describe("storage factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createStorage", () => {
    it("should create DexieStorage in browser environment", () => {
      vi.mocked(DexieStorage).mockImplementation(function (this) {
        return {
          type: "dexie",
        };
      });

      const storage = createStorage();

      expect(DexieStorage).toHaveBeenCalled();
      expect(storage).toBeDefined();
    });

    it("should not use dbPath in browser environment", () => {
      vi.mocked(DexieStorage).mockImplementation(function (this) {
        return {
          type: "dexie",
        };
      });

      createStorage("ignored.db");

      expect(DexieStorage).toHaveBeenCalled();
      expect(SQLiteStorage).not.toHaveBeenCalled();
    });
  });
});
