import {
  ChainFees,
  ChainType,
  MisbehaviourEvidence,
  MisbehaviourEvidenceUpdate,
  MisbehaviourStatus,
  NewMisbehaviourEvidence,
  PathSide,
  RelayedHeights,
  RelayPaths,
} from "../types/index.js";

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
  addChainFees(chainId: string, gasPrice: number, gasDenom: string, gasAdjustment?: number): Promise<ChainFees>

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
   * @param queryNodeA - Chain A query RPC endpoint
   * @param chainIdB - Chain B identifier
   * @param nodeB - Chain B RPC endpoint
   * @param queryNodeB - Chain B query RPC endpoint
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
    queryNodeA: string | undefined,
    chainIdB: string,
    nodeB: string,
    queryNodeB: string | undefined,
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

  /**
   * Records detected misbehaviour. A record for the same host chain, client
   * and height is only stored once.
   *
   * @param evidence - The detected misbehaviour
   * @returns The stored record (the existing one if it was already recorded)
   */
  addMisbehaviourEvidence(evidence: NewMisbehaviourEvidence): Promise<MisbehaviourEvidence>

  /**
   * Retrieves misbehaviour records, oldest first.
   *
   * @param status - Only return records with this status
   * @returns Array of MisbehaviourEvidence records
   */
  getMisbehaviourEvidence(status?: MisbehaviourStatus): Promise<MisbehaviourEvidence[]>

  /**
   * Updates the submission state of a misbehaviour record.
   *
   * @param id - The record ID
   * @param update - Fields to change
   */
  updateMisbehaviourEvidence(id: number, update: MisbehaviourEvidenceUpdate): Promise<void>

  /**
   * Retrieves the highest consensus height the monitor has checked.
   *
   * @param pathId - The relay path ID
   * @param side - The path end whose client is monitored
   * @returns The height, or 0 if nothing has been checked yet
   */
  getMonitorCursor(pathId: number, side: PathSide): Promise<number>

  /**
   * Stores the highest consensus height the monitor has checked.
   *
   * @param pathId - The relay path ID
   * @param side - The path end whose client is monitored
   * @param revisionHeight - The checked height
   */
  setMonitorCursor(pathId: number, side: PathSide, revisionHeight: number): Promise<void>
}
