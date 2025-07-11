// @vitest-environment happy-dom

import "fake-indexeddb/auto";

import {
  expect, test,
} from "vitest";

import {
  db,
} from "./dexie";

test("Dexie database should have relayPaths and relayedHeights tables", () => {
  expect(db.relayPaths).toBeDefined();
  expect(db.relayedHeights).toBeDefined();
});
