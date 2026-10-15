import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";

/**
 * Types of the Ethereum light client hosted on gno.land
 * (gno.land/p/aib/ibc/lightclient/ethereum/v0), as this relayer builds and
 * reads them. Heights of an Ethereum client are beacon slots, with revision
 * number 0.
 */

export const ETHEREUM_LC_TYPE = "ethereum";

/** A consensus fork: its version and activation epoch. */
export interface EthereumFork {
  version: Uint8Array
  epoch: bigint
}

export interface EthereumForkParameters {
  genesisForkVersion: Uint8Array
  altair: EthereumFork
  bellatrix: EthereumFork
  capella: EthereumFork
  deneb: EthereumFork
  electra: EthereumFork
  fulu: EthereumFork
  gloas: EthereumFork
}

/** A sync committee summary: the root of its pubkeys and its aggregate key. */
export interface SyncCommitteeSummary {
  pubkeysHash: Uint8Array
  aggregatePubkey: Uint8Array
}

export interface EthereumClientState {
  lcType: typeof ETHEREUM_LC_TYPE
  chainId: bigint
  genesisValidatorsRoot: Uint8Array
  minSyncCommitteeParticipants: bigint
  syncCommitteeSize: bigint
  genesisTime: bigint
  genesisSlot: bigint
  forkParameters: EthereumForkParameters
  secondsPerSlot: bigint
  slotsPerEpoch: bigint
  epochsPerSyncCommitteePeriod: bigint
  /** {0, latest finalized slot} */
  latestHeight: Height
  latestExecutionBlockNumber: bigint
  /** The ICS26 router whose storage holds the commitments. */
  ibcContractAddress: Uint8Array
  /** The storage slot of the router's commitments mapping. */
  ibcCommitmentSlot: Uint8Array
}

export interface EthereumConsensusState {
  lcType: typeof ETHEREUM_LC_TYPE
  slot: bigint
  /** The execution state root storage proofs verify against. */
  stateRoot: Uint8Array
  /** The execution block time. */
  timestamp: {
    seconds: bigint
  }
  currentSyncCommittee: SyncCommitteeSummary
  nextSyncCommittee?: SyncCommitteeSummary
}

/**
 * One update of a gno-hosted Ethereum client, encoded for
 * gno.land/r/aib/ibc/ethrelay.UpdateClient.
 */
export interface EthereumUpdate {
  message: Uint8Array
  trustedSlot: bigint
  finalizedSlot: bigint
  signatureSlot: bigint
}

/**
 * What an Ethereum chain hands a counterparty to bring its light client up
 * to date: the updates to apply in order (revealing a sync committee before
 * finality can cross a period takes more than one).
 */
export type EthereumLightClientHeader = EthereumUpdate[];

/** An Ethereum chain's own view of a finalized point, as the relayer reads it. */
export interface EthereumHeader {
  /** The finalized beacon slot. */
  height: number
  time: {
    seconds: bigint
    nanos: number
  }
}

export function isEthereumClientState(clientState: object): clientState is EthereumClientState {
  return "lcType" in clientState && clientState.lcType === ETHEREUM_LC_TYPE && "forkParameters" in clientState;
}

export function isEthereumConsensusState(consensusState: object): consensusState is EthereumConsensusState {
  return "lcType" in consensusState && consensusState.lcType === ETHEREUM_LC_TYPE && "stateRoot" in consensusState;
}

/**
 * Chain-specific settings of an Ethereum chain, stored with
 * `relayer add-ethereum-chain` (IStorage.setChainConfig).
 */
export interface EthereumChainConfig {
  /** ICS26Router address. */
  router: `0x${string}`
  /** Beacon node API with the light-client endpoints. */
  beacon: string
  /**
   * Execution RPC serving eth_getProof at the finalized block (64 to 96
   * blocks behind head); defaults to the path's node.
   */
  proofRpc?: string
}
