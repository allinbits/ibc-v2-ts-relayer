// @vitest-environment happy-dom

import "fake-indexeddb/auto";

import {
  expect, test,
} from "vitest";

import {
  ChainType,
} from "../types";
import {
  addRelayPath,
  getRelayedHeights,
  getRelayPath,
  getRelayPaths,
  updateRelayedHeights,
} from "./storage";

test("Expect addRelayPath and getRelayPath to work correctly", async () => {
  const chainIdA = "chainA";
  const chainIdB = "chainB";
  const nodeA = "nodeA";
  const nodeB = "nodeB";
  const clientIdA = "clientA";
  const clientIdB = "clientB";
  const chainTypeA = ChainType.Cosmos;
  const chainTypeB = ChainType.Gno;

  // Add a relay path
  await addRelayPath(chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientIdA, clientIdB, 1);
  await addRelayPath(chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientIdA, clientIdB, 2);

  // Get the relay path
  const relayPath = await getRelayPath(chainIdA, chainIdB, clientIdA, clientIdB);
  const relayPathV2 = await getRelayPath(chainIdA, chainIdB, clientIdA, clientIdB, 2);
  // Check if the relay path is correct
  expect(relayPath).toBeDefined();
  expect(relayPath?.chainIdA).toBe(chainIdA);
  expect(relayPath?.chainIdB).toBe(chainIdB);
  expect(relayPath?.nodeA).toBe(nodeA);
  expect(relayPath?.nodeB).toBe(nodeB);
  expect(relayPath?.clientA).toBe(clientIdA);
  expect(relayPath?.clientB).toBe(clientIdB);
  expect(relayPath?.version).toBe(1);
  expect(relayPathV2).toBeDefined();
  expect(relayPathV2?.chainIdA).toBe(chainIdA);
  expect(relayPathV2?.chainIdB).toBe(chainIdB);
  expect(relayPathV2?.nodeA).toBe(nodeA);
  expect(relayPathV2?.nodeB).toBe(nodeB);
  expect(relayPathV2?.clientA).toBe(clientIdA);
  expect(relayPathV2?.clientB).toBe(clientIdB);
  expect(relayPathV2?.version).toBe(2);
});
test("Expect getRelayPath to return undefined for non-existent relay path", async () => {
  const chainIdA = "chainC";
  const chainIdB = "chainD";
  const clientIdA = "clientA";
  const clientIdB = "clientB";

  // Attempt to get a non-existent relay path
  const relayPath = await getRelayPath(chainIdA, chainIdB, clientIdA, clientIdB);
  expect(relayPath).toBeUndefined();
});
test("Expect getRelayedHeights to initialize and fetch heights", async () => {
  // Add a relay path first
  const chainIdA = "chainE";
  const chainIdB = "chainF";
  const nodeA = "nodeA";
  const nodeB = "nodeB";
  const clientIdA = "clientA";
  const clientIdB = "clientB";
  const chainTypeA = ChainType.Cosmos;
  const chainTypeB = ChainType.Cosmos;
  const relayPath = await addRelayPath(chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientIdA, clientIdB);
  expect(relayPath).toBeDefined();
  if (!relayPath) throw new Error("relayPath is undefined");
  // Should initialize heights to 0
  const heights = await getRelayedHeights(relayPath.id);
  expect(heights).toBeDefined();
  expect(heights.packetHeightA).toBe(0);
  expect(heights.packetHeightB).toBe(0);
  expect(heights.ackHeightA).toBe(0);
  expect(heights.ackHeightB).toBe(0);
});

test("Expect updateRelayedHeights to update heights", async () => {
  // Add a relay path first
  const chainIdA = "chainG";
  const chainIdB = "chainH";
  const nodeA = "nodeA";
  const nodeB = "nodeB";
  const clientIdA = "clientA";
  const clientIdB = "clientB";
  const chainTypeA = ChainType.Cosmos;
  const chainTypeB = ChainType.Cosmos;
  const relayPath = await addRelayPath(chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientIdA, clientIdB);
  expect(relayPath).toBeDefined();
  if (!relayPath) throw new Error("relayPath is undefined");
  // Update heights
  await updateRelayedHeights(relayPath.id, 10, 20, 30, 40);
  const heights = await getRelayedHeights(relayPath.id);
  expect(heights.packetHeightA).toBe(10);
  expect(heights.packetHeightB).toBe(20);
  expect(heights.ackHeightA).toBe(30);
  expect(heights.ackHeightB).toBe(40);
});

test("Expect getRelayPaths to return all relay paths", async () => {
  // Add a couple of relay paths
  const chainIdA = "chainI";
  const chainIdB = "chainJ";
  const nodeA = "nodeA";
  const nodeB = "nodeB";
  const clientIdA = "clientA";
  const clientIdB = "clientB";
  const chainTypeA = ChainType.Cosmos;
  const chainTypeB = ChainType.Cosmos;
  await addRelayPath(chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientIdA, clientIdB, 1);
  await addRelayPath("chainK", nodeA, "chainL", nodeB, chainTypeA, chainTypeB, clientIdA, clientIdB, 1);
  const paths = await getRelayPaths();
  expect(Array.isArray(paths)).toBe(true);
  expect(paths.length).toBeGreaterThanOrEqual(2);
});
