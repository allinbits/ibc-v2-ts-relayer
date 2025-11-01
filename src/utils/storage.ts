import {
  ChainType,
} from "../types";
import {
  createStorage,
} from "./storage/factory";

// Create a singleton storage instance
const storage = createStorage();

/**
 * Adds gas fee configuration for a chain.
 * @deprecated Use storage.addChainFees() directly for better testability
 */
const addChainFees = async (chainId: string, gasPrice: number, gasDenom: string) => {
  return storage.addChainFees(chainId, gasPrice, gasDenom);
};

/**
 * Retrieves gas fee configuration for a chain.
 * @deprecated Use storage.getChainFees() directly for better testability
 */
const getChainFees = async (chainId: string) => {
  return storage.getChainFees(chainId);
};

/**
 * Updates the relay heights for a specific path.
 * @deprecated Use storage.updateRelayedHeights() directly for better testability
 */
const updateRelayedHeights = async (
  pathId: number,
  relayHeightA: number,
  relayHeightB: number,
  ackHeightA: number,
  ackHeightB: number,
) => {
  return storage.updateRelayedHeights(pathId, relayHeightA, relayHeightB, ackHeightA, ackHeightB);
};

/**
 * Retrieves or initializes relay heights for a path.
 * @deprecated Use storage.getRelayedHeights() directly for better testability
 */
const getRelayedHeights = async (pathId: number) => {
  return storage.getRelayedHeights(pathId);
};

/**
 * Adds a new relay path configuration.
 * @deprecated Use storage.addRelayPath() directly for better testability
 */
const addRelayPath = async (
  chainIdA: string,
  nodeA: string,
  chainIdB: string,
  nodeB: string,
  chainTypeA: ChainType,
  chainTypeB: ChainType,
  clientIdA: string,
  clientIdB: string,
  version: number = 1,
) => {
  return storage.addRelayPath(
    chainIdA,
    nodeA,
    chainIdB,
    nodeB,
    chainTypeA,
    chainTypeB,
    clientIdA,
    clientIdB,
    version,
  );
};

/**
 * Retrieves a specific relay path.
 * @deprecated Use storage.getRelayPath() directly for better testability
 */
const getRelayPath = async (
  chainIdA: string,
  chainIdB: string,
  clientIdA: string,
  clientIdB: string,
  version: number = 1,
) => {
  return storage.getRelayPath(chainIdA, chainIdB, clientIdA, clientIdB, version);
};

/**
 * Retrieves all configured relay paths.
 * @deprecated Use storage.getRelayPaths() directly for better testability
 */
const getRelayPaths = async () => {
  return storage.getRelayPaths();
};

export {
  addChainFees,
  addRelayPath,
  getChainFees,
  getRelayedHeights,
  getRelayPath,
  getRelayPaths,
  storage,
  updateRelayedHeights,
};
