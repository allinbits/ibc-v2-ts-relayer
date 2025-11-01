import {
  ChainFees,
  ChainType,
  RelayedHeights,
  RelayPaths,
} from "../../types";

/**
 * Interface for storage operations used by the relayer.
 * Implementations can use different backends (SQLite, Dexie/IndexedDB, etc.)
 */
export interface IStorage {
  /**
   * Adds gas fee configuration for a chain.
   *
   * @param chainId - The chain identifier
   * @param gasPrice - The gas price value
   * @param gasDenom - The gas denomination (e.g., "uatom")
   * @returns The created ChainFees record
   */
  addChainFees(chainId: string, gasPrice: number, gasDenom: string): Promise<ChainFees>

  /**
   * Retrieves gas fee configuration for a chain.
   *
   * @param chainId - The chain identifier
   * @returns The ChainFees record
   * @throws Error if chain fees not found
   */
  getChainFees(chainId: string): Promise<ChainFees>

  /**
   * Updates the relay heights for a specific path.
   *
   * @param pathId - The relay path ID
   * @param packetHeightA - Packet height for chain A
   * @param packetHeightB - Packet height for chain B
   * @param ackHeightA - Acknowledgement height for chain A
   * @param ackHeightB - Acknowledgement height for chain B
   */
  updateRelayedHeights(
    pathId: number,
    packetHeightA: number,
    packetHeightB: number,
    ackHeightA: number,
    ackHeightB: number
  ): Promise<void>

  /**
   * Retrieves or initializes relay heights for a path.
   *
   * @param pathId - The relay path ID
   * @returns The RelayedHeights record (initializes to zero if not found)
   */
  getRelayedHeights(pathId: number): Promise<RelayedHeights>

  /**
   * Adds a new relay path configuration.
   *
   * @param chainIdA - Chain A identifier
   * @param nodeA - Chain A RPC endpoint
   * @param chainIdB - Chain B identifier
   * @param nodeB - Chain B RPC endpoint
   * @param chainTypeA - Type of chain A
   * @param chainTypeB - Type of chain B
   * @param clientIdA - Client ID on chain A
   * @param clientIdB - Client ID on chain B
   * @param version - IBC protocol version (1 or 2)
   * @returns The created or found RelayPaths record
   */
  addRelayPath(
    chainIdA: string,
    nodeA: string,
    chainIdB: string,
    nodeB: string,
    chainTypeA: ChainType,
    chainTypeB: ChainType,
    clientIdA: string,
    clientIdB: string,
    version: number
  ): Promise<RelayPaths | undefined>

  /**
   * Retrieves a specific relay path.
   *
   * @param chainIdA - Chain A identifier
   * @param chainIdB - Chain B identifier
   * @param clientIdA - Client ID on chain A
   * @param clientIdB - Client ID on chain B
   * @param version - IBC protocol version
   * @returns The RelayPaths record if found, undefined otherwise
   */
  getRelayPath(
    chainIdA: string,
    chainIdB: string,
    clientIdA: string,
    clientIdB: string,
    version: number
  ): Promise<RelayPaths | undefined>

  /**
   * Retrieves all configured relay paths.
   *
   * @returns Array of all RelayPaths records
   */
  getRelayPaths(): Promise<RelayPaths[]>
}
