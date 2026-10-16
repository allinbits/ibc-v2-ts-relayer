/* eslint-disable @stylistic/no-tabs */
import {
  fromBase64,
} from "@cosmjs/encoding";

import {
  ETHEREUM_LC_TYPE, EthereumClientState, EthereumConsensusState, EthereumFork, SyncCommitteeSummary,
} from "../ethereum/types.js";

/**
 * The gno.land side of Ethereum clients hosted by the IBC core realm
 * (gno.land/p/aib/ibc/lightclient/ethereum/v0).
 *
 * Creating a client is the one MsgRun: it is rare and its states are small.
 * Updates and packets go through MsgCall to ETH_RELAY_REALM, whose functions
 * take wire-encoded messages (see ../ethereum/wire.ts) as []byte arguments.
 */

export const ETH_RELAY_REALM = "gno.land/r/aib/ibc/ethrelay";

/** Client ids the core realm gives Ethereum clients. */
export const isEthereumClientId = (clientId: string): boolean => clientId.startsWith(`${ETHEREUM_LC_TYPE}-`);

/**
 * A Gno []byte literal. Decoding hex at run time costs the interpreter far
 * more gas than a quoted literal.
 */
export function gnoBytes(b: Uint8Array): string {
  return "[]byte(\"" + Array.from(b, x => "\\x" + x.toString(16).padStart(2, "0")).join("") + "\")";
}

function gnoVersion(v: Uint8Array): string {
  if (v.length !== 4) {
    throw new Error(`fork version must be 4 bytes, got ${v.length}`);
  }
  return `[4]byte{${Array.from(v, x => "0x" + x.toString(16).padStart(2, "0")).join(", ")}}`;
}

const gnoFork = (f: EthereumFork): string => `ethereum.Fork{Version: ${gnoVersion(f.version)}, Epoch: ${f.epoch}}`;

const gnoSummary = (s: SyncCommitteeSummary): string => `ethereum.SummarizedSyncCommittee{PubkeysHash: ${gnoBytes(s.pubkeysHash)}, AggregatePubkey: ${gnoBytes(s.aggregatePubkey)}}`;

export function gnoClientState(cs: EthereumClientState): string {
  const f = cs.forkParameters;
  return `ethereum.ClientState{
		ChainID: ${cs.chainId},
		GenesisValidatorsRoot: ${gnoBytes(cs.genesisValidatorsRoot)},
		MinSyncCommitteeParticipants: ${cs.minSyncCommitteeParticipants},
		SyncCommitteeSize: ${cs.syncCommitteeSize},
		GenesisTime: ${cs.genesisTime},
		GenesisSlot: ${cs.genesisSlot},
		ForkParameters: ethereum.ForkParameters{
			GenesisForkVersion: ${gnoVersion(f.genesisForkVersion)},
			GenesisSlot: ${cs.genesisSlot},
			Altair: ${gnoFork(f.altair)},
			Bellatrix: ${gnoFork(f.bellatrix)},
			Capella: ${gnoFork(f.capella)},
			Deneb: ${gnoFork(f.deneb)},
			Electra: ${gnoFork(f.electra)},
			Fulu: ${gnoFork(f.fulu)},
			Gloas: ${gnoFork(f.gloas)},
		},
		SecondsPerSlot: ${cs.secondsPerSlot},
		SlotsPerEpoch: ${cs.slotsPerEpoch},
		EpochsPerSyncCommitteePeriod: ${cs.epochsPerSyncCommitteePeriod},
		LatestSlot: ${cs.latestHeight.revisionHeight},
		LatestExecutionBlockNumber: ${cs.latestExecutionBlockNumber},
		IBCContractAddress: ${gnoBytes(cs.ibcContractAddress)},
		IBCCommitmentSlot: ${gnoBytes(cs.ibcCommitmentSlot)},
	}`;
}

export function gnoConsensusState(cons: EthereumConsensusState): string {
  const next = cons.nextSyncCommittee ? `\n\t\tNextSyncCommittee: &${gnoSummary(cons.nextSyncCommittee)},` : "";
  return `ethereum.ConsensusState{
		Slot: ${cons.slot},
		StateRoot: ${gnoBytes(cons.stateRoot)},
		Timestamp: ${cons.timestamp.seconds},
		CurrentSyncCommittee: ${gnoSummary(cons.currentSyncCommittee)},${next}
	}`;
}

/** MsgRun source creating an Ethereum client; the tx data is its client id. */
export function createEthereumClientScript(cs: EthereumClientState, cons: EthereumConsensusState): string {
  return `package main

import (
	ethereum "gno.land/p/aib/ibc/lightclient/ethereum/v0"
	"gno.land/r/aib/ibc/core"
)

func main(cur realm) {
	print(core.CreateClient(cross(cur), ${gnoClientState(cs)}, ${gnoConsensusState(cons)}))
}
`;
}

/**
 * MsgRun source registering the counterparty of an Ethereum client. Router
 * commitments sit directly in its storage, so the prefix is one empty key.
 */
export function registerEthereumCounterpartyScript(clientId: string, counterpartyClientId: string): string {
  return `package main

import "gno.land/r/aib/ibc/core"

func main(cur realm) {
	core.RegisterCounterparty(cross(cur), ${JSON.stringify(clientId)}, [][]byte{{}}, ${JSON.stringify(counterpartyClientId)})
}
`;
}

interface RenderedHeight {
  revision_number: number
  revision_height: number
}

interface RenderedSyncCommittee {
  pubkeys_hash: string
  aggregate_pubkey: string
}

interface RenderedFork {
  version: string
  epoch: string
}

/** The core realm's render of an Ethereum client state; uint64s are decimal strings. */
export interface RenderedEthereumClientState {
  chain_id: string
  genesis_validators_root: string
  min_sync_committee_participants: string
  sync_committee_size: string
  genesis_time: string
  genesis_slot: string
  seconds_per_slot: string
  slots_per_epoch: string
  epochs_per_sync_committee_period: string
  latest_height: RenderedHeight
  latest_execution_block_number: string
  is_frozen: boolean
  ibc_contract_address: string
  ibc_commitment_slot: string
  fork_parameters: {
    genesis_fork_version: string
    altair: RenderedFork
    bellatrix: RenderedFork
    capella: RenderedFork
    deneb: RenderedFork
    electra: RenderedFork
    fulu: RenderedFork
    gloas: RenderedFork
  }
}

/** The core realm's render of an Ethereum consensus state. */
export interface RenderedEthereumConsensusState {
  height: RenderedHeight
  slot: number
  timestamp: number
  state_root: string
  current_sync_committee: RenderedSyncCommittee
  next_sync_committee?: RenderedSyncCommittee
  next_sync_committee_known: boolean
}

/** The core realm's render of an Ethereum client (clients/{id}). */
export interface RenderedEthereumClient {
  client_state: RenderedEthereumClientState
  last_consensus_state?: RenderedEthereumConsensusState
}

const parseFork = (f: RenderedFork): EthereumFork => ({
  version: fromBase64(f.version),
  epoch: BigInt(f.epoch),
});

const parseSyncCommittee = (s: RenderedSyncCommittee): SyncCommitteeSummary => ({
  pubkeysHash: fromBase64(s.pubkeys_hash),
  aggregatePubkey: fromBase64(s.aggregate_pubkey),
});

export function parseEthereumClientState(r: RenderedEthereumClientState): EthereumClientState {
  const f = r.fork_parameters;
  return {
    lcType: ETHEREUM_LC_TYPE,
    chainId: BigInt(r.chain_id),
    genesisValidatorsRoot: fromBase64(r.genesis_validators_root),
    minSyncCommitteeParticipants: BigInt(r.min_sync_committee_participants),
    syncCommitteeSize: BigInt(r.sync_committee_size),
    genesisTime: BigInt(r.genesis_time),
    genesisSlot: BigInt(r.genesis_slot),
    forkParameters: {
      genesisForkVersion: fromBase64(f.genesis_fork_version),
      altair: parseFork(f.altair),
      bellatrix: parseFork(f.bellatrix),
      capella: parseFork(f.capella),
      deneb: parseFork(f.deneb),
      electra: parseFork(f.electra),
      fulu: parseFork(f.fulu),
      gloas: parseFork(f.gloas),
    },
    secondsPerSlot: BigInt(r.seconds_per_slot),
    slotsPerEpoch: BigInt(r.slots_per_epoch),
    epochsPerSyncCommitteePeriod: BigInt(r.epochs_per_sync_committee_period),
    latestHeight: {
      revisionNumber: BigInt(r.latest_height.revision_number),
      revisionHeight: BigInt(r.latest_height.revision_height),
    },
    latestExecutionBlockNumber: BigInt(r.latest_execution_block_number),
    ibcContractAddress: fromBase64(r.ibc_contract_address),
    ibcCommitmentSlot: fromBase64(r.ibc_commitment_slot),
  };
}

export function parseEthereumConsensusState(r: RenderedEthereumConsensusState): EthereumConsensusState {
  return {
    lcType: ETHEREUM_LC_TYPE,
    slot: BigInt(r.slot),
    stateRoot: fromBase64(r.state_root),
    timestamp: {
      seconds: BigInt(r.timestamp),
    },
    currentSyncCommittee: parseSyncCommittee(r.current_sync_committee),
    nextSyncCommittee: r.next_sync_committee ? parseSyncCommittee(r.next_sync_committee) : undefined,
  };
}
