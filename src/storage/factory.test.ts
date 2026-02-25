import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
    it("should create SQLiteStorage in Node.js environment", () => {
      vi.mocked(SQLiteStorage).mockImplementation(function (this) {
        return {
          type: "sqlite",
        };
      });

      const storage = createStorage();

      expect(SQLiteStorage).toHaveBeenCalled();
      expect(storage).toBeDefined();
    });

    it("should pass dbPath to SQLiteStorage", () => {
      vi.mocked(SQLiteStorage).mockImplementation(function (this) {
        return {
          type: "sqlite",
        };
      });

      createStorage("custom.db");

      expect(SQLiteStorage).toHaveBeenCalledWith("custom.db");
    });

    it("should use undefined dbPath when not provided in Node.js", () => {
      vi.mocked(SQLiteStorage).mockImplementation(function (this) {
        return {
          type: "sqlite",
        };
      });

      createStorage();

      expect(SQLiteStorage).toHaveBeenCalledWith(undefined);
    });
  });
});
