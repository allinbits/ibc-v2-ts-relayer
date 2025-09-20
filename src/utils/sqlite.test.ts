import {
  expect, test,
} from "vitest";

import {
  openDB,
} from "./sqlite";

test("SQLite database should have relayPaths and relayedHeights tables", async () => {
  const db = await openDB(":memory:");
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string
  }[];
  const tableNames = tables.map((table: {
    name: string
  }) => table.name);
  expect(tableNames).toContain("relayPaths");
  expect(tableNames).toContain("relayedHeights");
});
// Note: The above test uses an in-memory SQLite database for testing purposes.
