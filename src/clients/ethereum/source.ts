/**
 * Ethereum as a source for the Ethereum light client on gno.land: chain
 * time and heights (beacon slots), sync-committee updates, storage proofs at
 * finalized blocks, and the router's packet events.
 *
 * Heights on this side are beacon slots: a packet's height is the slot of
 * the block that sent it, and a proof at slot S is taken at the execution
 * block the beacon block at S commits to, whose state root the gno-side
 * client stores for S.
 */
import {
  Packet as PacketV2,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";
import {
  ReadonlyDateWithNanoseconds,
} from "@cosmjs/tendermint-rpc";
import {
  bytesToHex, Hex, hexToBytes, keccak256,
} from "viem";

import {
  AckV2WithMetadata, DataProof, HeaderSummary, PacketV2WithMetadata,
} from "../../types/index.js";
import {
  headerBlockHash, LightClientUpdate, SyncCommittee,
} from "./beacon.js";
import {
  commitmentSlot, executionHeader, packetPath, storageProof,
} from "./execution.js";
import type {
  EthereumIbcClient,
} from "./IbcClient.js";
import {
  getLogsChunked,
} from "./logs.js";
import {
  IBC_STORE_COMMITMENT_SLOT, routerSourceAbi,
} from "./sourceAbi.js";
import {
  ETHEREUM_LC_TYPE, EthereumClientState, EthereumConsensusState, EthereumFork, EthereumHeader, EthereumLightClientHeader, EthereumUpdate,
} from "./types.js";
import {
  encodeHeader, encodeMembershipProof, hex, summarize,
} from "./wire.js";

const FAR_FUTURE_EPOCH = 2n ** 64n - 1n;
const FORKS = ["ALTAIR", "BELLATRIX", "CAPELLA", "DENEB", "ELECTRA", "FULU", "GLOAS"] as const;

/** Raised when Ethereum has not finalized far enough yet: retry later. */
export class NotFinalizedError extends Error {}

/** The tracked chain's static parameters, read from its beacon node. */
export interface ChainParams {
  genesisTime: bigint
  genesisValidatorsRoot: string
  genesisForkVersion: string
  secondsPerSlot: bigint
  slotsPerEpoch: bigint
  epochsPerSyncCommitteePeriod: bigint
  syncCommitteeSize: bigint
  forks: Record<(typeof FORKS)[number], {
    version: string
    epoch: bigint
  }>
}

const paramsCache = new WeakMap<EthereumIbcClient, Promise<ChainParams>>();

export function chainParams(c: EthereumIbcClient): Promise<ChainParams> {
  let p = paramsCache.get(c);
  if (!p) {
    p = readChainParams(c);
    p.catch(() => paramsCache.delete(c));
    paramsCache.set(c, p);
  }
  return p;
}

async function readChainParams(c: EthereumIbcClient): Promise<ChainParams> {
  const [genesis, spec] = await Promise.all([c.beacon.genesis(), c.beacon.spec()]);
  const num = (key: string): bigint => {
    if (spec[key] === undefined) {
      throw new Error(`beacon spec has no ${key}`);
    }
    return BigInt(spec[key]);
  };
  const forks = Object.fromEntries(FORKS.map(f => [
    f,
    {
      version: spec[`${f}_FORK_VERSION`] ?? "0x00000000",
      epoch: spec[`${f}_FORK_EPOCH`] === undefined ? FAR_FUTURE_EPOCH : BigInt(spec[`${f}_FORK_EPOCH`]),
    },
  ])) as ChainParams["forks"];
  return {
    genesisTime: BigInt(genesis.genesis_time),
    genesisValidatorsRoot: genesis.genesis_validators_root,
    genesisForkVersion: genesis.genesis_fork_version,
    secondsPerSlot: num("SECONDS_PER_SLOT"),
    slotsPerEpoch: num("SLOTS_PER_EPOCH"),
    epochsPerSyncCommitteePeriod: num("EPOCHS_PER_SYNC_COMMITTEE_PERIOD"),
    syncCommitteeSize: num("SYNC_COMMITTEE_SIZE"),
    forks,
  };
}

const slotTime = (p: ChainParams, slot: bigint) => p.genesisTime + slot * p.secondsPerSlot;
const slotAt = (p: ChainParams, time: bigint) => (time - p.genesisTime) / p.secondsPerSlot;
const toSlot = (h: Height | number): bigint => typeof h === "number" ? BigInt(h) : h.revisionHeight;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const dateAt = (seconds: bigint): ReadonlyDateWithNanoseconds => Object.assign(new Date(Number(seconds) * 1000), {
  nanoseconds: 0,
});

// --- chain basics ---

export async function getChainId(c: EthereumIbcClient): Promise<string> {
  return (await c.publicClient.getChainId()).toString();
}

export async function currentTime(c: EthereumIbcClient): Promise<ReadonlyDateWithNanoseconds> {
  return dateAt((await c.publicClient.getBlock()).timestamp);
}

/** The slot of the latest block. */
export async function currentHeight(c: EthereumIbcClient): Promise<number> {
  const p = await chainParams(c);
  return Number(slotAt(p, (await c.publicClient.getBlock()).timestamp));
}

export async function currentRevision(c: EthereumIbcClient): Promise<Height> {
  return c.revisionHeight(await currentHeight(c));
}

export async function timeoutHeight(c: EthereumIbcClient, blocksInFuture: number): Promise<Height> {
  return c.revisionHeight(await currentHeight(c) + blocksInFuture);
}

export async function header(c: EthereumIbcClient, height: number): Promise<EthereumHeader> {
  const p = await chainParams(c);
  return {
    height,
    time: {
      seconds: slotTime(p, BigInt(height)),
      nanos: 0,
    },
  };
}

/** The latest finalized slot: what a counterparty light client can reach. */
export async function latestHeader(c: EthereumIbcClient): Promise<EthereumHeader> {
  const fin = await c.beacon.finalityUpdate();
  return header(c, Number(fin.finalized_header.beacon.slot));
}

export async function waitOneBlock(c: EthereumIbcClient): Promise<void> {
  const p = await chainParams(c);
  await sleep(Number(p.secondsPerSlot) * 1000);
}

export async function waitForIndexer(_c: EthereumIbcClient): Promise<void> {
  // Events are read straight from the node.
}

export async function getHeaderSummary(_c: EthereumIbcClient, _height: number): Promise<HeaderSummary> {
  throw new Error("misbehaviour monitoring of Ethereum is not supported: its light client is checked by sync committee signatures");
}

// --- blocks and slots ---

const timestampCache = new WeakMap<EthereumIbcClient, Map<bigint, bigint>>();

async function blockTimestamp(c: EthereumIbcClient, n: bigint): Promise<bigint> {
  let cache = timestampCache.get(c);
  if (!cache) {
    cache = new Map();
    timestampCache.set(c, cache);
  }
  let ts = cache.get(n);
  if (ts === undefined) {
    ts = (await c.publicClient.getBlock({
      blockNumber: n,
    })).timestamp;
    cache.set(n, ts);
  }
  return ts;
}

/**
 * The first block whose timestamp is at or after t, or the block after the
 * latest one. A binary search: missed slots make block numbers drift from
 * slots.
 */
async function firstBlockAtOrAfter(c: EthereumIbcClient, t: bigint): Promise<bigint> {
  const latest = await c.publicClient.getBlock();
  if (latest.timestamp < t) {
    return latest.number + 1n;
  }
  let lo = 0n;
  let hi = latest.number;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await blockTimestamp(c, mid) < t) {
      lo = mid + 1n;
    }
    else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Blocks of slots in (minSlot, maxSlot), the link's exclusive height range.
 * Without a minimum slot (a path's first check) the range starts at the
 * chain config's fromBlock, the router's deployment block (0 without one),
 * and "latest" is resolved to a number so the scan can go in chunks.
 */
async function blockRange(c: EthereumIbcClient, minSlot: number | undefined, maxSlot: number | undefined): Promise<{
  fromBlock: bigint
  toBlock: bigint
}> {
  const p = await chainParams(c);
  const floor = BigInt(c.config.fromBlock ?? "0");
  const fromBlock = minSlot === undefined ? floor : await firstBlockAtOrAfter(c, slotTime(p, BigInt(minSlot) + 1n));
  const toBlock = maxSlot === undefined
    ? await c.publicClient.getBlockNumber()
    : await firstBlockAtOrAfter(c, slotTime(p, BigInt(maxSlot))) - 1n;
  return {
    fromBlock: fromBlock < floor ? floor : fromBlock,
    toBlock,
  };
}

// --- router events and state ---

type AbiPacket = {
  sequence: bigint
  sourceClient: string
  destClient: string
  timeoutTimestamp: bigint
  payloads: readonly {
    sourcePort: string
    destPort: string
    version: string
    encoding: string
    value: Hex
  }[]
};

function toPacketV2(p: AbiPacket): PacketV2 {
  return PacketV2.fromPartial({
    sequence: p.sequence,
    sourceClient: p.sourceClient,
    destinationClient: p.destClient,
    timeoutTimestamp: p.timeoutTimestamp,
    payloads: p.payloads.map(pl => ({
      sourcePort: pl.sourcePort,
      destinationPort: pl.destPort,
      version: pl.version,
      encoding: pl.encoding,
      value: hexToBytes(pl.value),
    })),
  });
}

export async function querySentPacketsV2(
  c: EthereumIbcClient,
  clientID: string,
  minHeight: number | undefined,
  maxHeight: number | undefined,
): Promise<PacketV2WithMetadata[]> {
  const p = await chainParams(c);
  const range = await blockRange(c, minHeight, maxHeight);
  if (range.toBlock < range.fromBlock) {
    return [];
  }
  const logs = await getLogsChunked(
    (fromBlock, toBlock) => c.publicClient.getContractEvents({
      address: c.config.router,
      abi: routerSourceAbi,
      eventName: "SendPacket",
      args: {
        clientId: clientID,
      },
      fromBlock,
      toBlock,
    }),
    range.fromBlock,
    range.toBlock,
  );
  return Promise.all(logs.map(async log => ({
    packet: toPacketV2(log.args.packet as AbiPacket),
    height: Number(slotAt(p, await blockTimestamp(c, log.blockNumber))),
  })));
}

export async function queryWrittenAcksV2(
  c: EthereumIbcClient,
  clientID: string,
  minHeight: number | undefined,
  maxHeight: number | undefined,
): Promise<AckV2WithMetadata[]> {
  const p = await chainParams(c);
  const range = await blockRange(c, minHeight, maxHeight);
  if (range.toBlock < range.fromBlock) {
    return [];
  }
  const logs = await getLogsChunked(
    (fromBlock, toBlock) => c.publicClient.getContractEvents({
      address: c.config.router,
      abi: routerSourceAbi,
      eventName: "WriteAcknowledgement",
      args: {
        clientId: clientID,
      },
      fromBlock,
      toBlock,
    }),
    range.fromBlock,
    range.toBlock,
  );
  return Promise.all(logs.map(async (log) => {
    const acks = log.args.acknowledgements as readonly Hex[];
    if (acks.length !== 1) {
      throw new Error(`packet ${log.args.sequence}: ${acks.length} acknowledgements, want 1`);
    }
    return {
      // The app acknowledgement as the router stores it (no wrapper).
      acknowledgement: hexToBytes(acks[0]),
      originalPacket: toPacketV2(log.args.packet as AbiPacket),
      height: Number(slotAt(p, await blockTimestamp(c, log.blockNumber))),
      txHash: log.transactionHash.slice(2).toUpperCase(),
      txEvents: [],
    };
  }));
}

async function commitment(c: EthereumIbcClient, path: Uint8Array): Promise<Hex> {
  return c.publicClient.readContract({
    address: c.config.router,
    abi: routerSourceAbi,
    functionName: "getCommitment",
    args: [keccak256(path)],
    // Optional in viem, but required by its types without strictNullChecks.
    authorizationList: undefined,
  });
}

const ZERO = `0x${"00".repeat(32)}`;

/** Packets sent to clientId that the router has no receipt for. */
export async function queryUnreceivedPacketsV2(c: EthereumIbcClient, clientId: string, sequences: readonly number[]): Promise<number[]> {
  const receipts = await Promise.all(sequences.map(s => commitment(c, packetPath(clientId, 2, BigInt(s)))));
  return sequences.filter((_, i) => receipts[i] === ZERO);
}

/** Packets sent from clientId whose commitment is still there: not yet acknowledged. */
export async function queryUnreceivedAcksV2(c: EthereumIbcClient, clientId: string, sequences: readonly number[]): Promise<number[]> {
  const commitments = await Promise.all(sequences.map(s => commitment(c, packetPath(clientId, 1, BigInt(s)))));
  return sequences.filter((_, i) => commitments[i] !== ZERO);
}

export async function queryCommitmentsV2(c: EthereumIbcClient, clientId: string, sequence: bigint): Promise<Uint8Array> {
  const value = await commitment(c, packetPath(clientId, 1, sequence));
  if (value === ZERO) {
    throw new Error(`no packet commitment for ${clientId}/${sequence}`);
  }
  return hexToBytes(value);
}

export async function getCounterparty(c: EthereumIbcClient, clientId: string): Promise<string> {
  const info = await c.publicClient.readContract({
    address: c.config.router,
    abi: routerSourceAbi,
    functionName: "getCounterparty",
    args: [clientId],
    authorizationList: undefined,
  });
  return info.clientId;
}

// --- storage proofs ---

/**
 * Proves the router's commitment at path at finalized slot: against the
 * execution block that slot's beacon block commits to.
 */
async function proveAt(c: EthereumIbcClient, path: Uint8Array, slot: bigint): Promise<DataProof> {
  const blockHash = await c.beacon.executionBlockHash(slot.toString());
  const exec = await executionHeader(c.publicClient, blockHash);
  const proof = await storageProof(c.proofClient, c.config.router, commitmentSlot(path), exec.number);
  return {
    data: proof.value,
    proof: encodeMembershipProof(proof),
    proofHeight: c.revisionHeight(Number(slot)),
  };
}

export async function getRawReceiptProofV2(c: EthereumIbcClient, clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
  return proveAt(c, packetPath(clientId, 2, sequence), proofHeight.revisionHeight);
}

export async function getRawPacketCommitmentProofV2(c: EthereumIbcClient, clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
  return proveAt(c, packetPath(clientId, 1, sequence), proofHeight.revisionHeight);
}

export async function getRawPacketAcknowledgementProofV2(c: EthereumIbcClient, clientId: string, sequence: bigint, proofHeight: Height): Promise<DataProof> {
  return proveAt(c, packetPath(clientId, 3, sequence), proofHeight.revisionHeight);
}

export async function getPacketProofV2(c: EthereumIbcClient, packet: PacketV2, headerHeight: Height | number): Promise<DataProof> {
  return proveAt(c, packetPath(packet.sourceClient, 1, packet.sequence), toSlot(headerHeight));
}

export async function getAckProofV2(c: EthereumIbcClient, packet: PacketV2, headerHeight: Height | number): Promise<DataProof> {
  return proveAt(c, packetPath(packet.destinationClient, 3, packet.sequence), toSlot(headerHeight));
}

/** Proves the router has no receipt for packet: a proof of the zero value. */
export async function getTimeoutProofV2(c: EthereumIbcClient, packet: PacketV2, headerHeight: Height | number): Promise<DataProof> {
  return proveAt(c, packetPath(packet.destinationClient, 2, packet.sequence), toSlot(headerHeight));
}

// --- light-client data ---

function fork(p: ChainParams, name: (typeof FORKS)[number]): EthereumFork {
  return {
    version: hex(p.forks[name].version),
    epoch: p.forks[name].epoch,
  };
}

/** A client of this chain for gno.land, trusting its latest finalized checkpoint. */
export async function buildCreateClientArgs(c: EthereumIbcClient): Promise<{
  clientState: EthereumClientState
  consensusState: EthereumConsensusState
}> {
  const p = await chainParams(c);
  // Beacon nodes only serve bootstraps at recent finalized checkpoints.
  const root = await c.beacon.blockRoot("finalized");
  const boot = await c.beacon.bootstrap(root);
  const exec = await executionHeader(c.publicClient, headerBlockHash(boot.header));
  const slot = BigInt(boot.header.beacon.slot);
  return {
    clientState: {
      lcType: ETHEREUM_LC_TYPE,
      chainId: BigInt(await c.getChainId()),
      genesisValidatorsRoot: hex(p.genesisValidatorsRoot),
      // Updates need a 2/3 supermajority to move the client anyway.
      minSyncCommitteeParticipants: p.syncCommitteeSize * 2n / 3n,
      syncCommitteeSize: p.syncCommitteeSize,
      genesisTime: p.genesisTime,
      genesisSlot: 0n,
      forkParameters: {
        genesisForkVersion: hex(p.genesisForkVersion),
        altair: fork(p, "ALTAIR"),
        bellatrix: fork(p, "BELLATRIX"),
        capella: fork(p, "CAPELLA"),
        deneb: fork(p, "DENEB"),
        electra: fork(p, "ELECTRA"),
        fulu: fork(p, "FULU"),
        gloas: fork(p, "GLOAS"),
      },
      secondsPerSlot: p.secondsPerSlot,
      slotsPerEpoch: p.slotsPerEpoch,
      epochsPerSyncCommitteePeriod: p.epochsPerSyncCommitteePeriod,
      latestHeight: c.revisionHeight(Number(slot)),
      latestExecutionBlockNumber: exec.number,
      ibcContractAddress: hexToBytes(c.config.router),
      ibcCommitmentSlot: hex(IBC_STORE_COMMITMENT_SLOT),
    },
    consensusState: {
      lcType: ETHEREUM_LC_TYPE,
      slot,
      stateRoot: exec.stateRoot,
      timestamp: {
        seconds: exec.timestamp,
      },
      currentSyncCommittee: summarize(boot.current_sync_committee),
    },
  };
}

/** The sync committee of period: the next committee period - 1's best update revealed. */
async function committeeOf(c: EthereumIbcClient, period: bigint): Promise<SyncCommittee> {
  const [u] = await c.beacon.updates(period - 1n, 1);
  if (!u?.next_sync_committee) {
    throw new Error(`no sync committee for period ${period}`);
  }
  return u.next_sync_committee;
}

async function toUpdate(
  c: EthereumIbcClient,
  p: ChainParams,
  u: LightClientUpdate,
  active: SyncCommittee,
  isNext: boolean,
  trustedSlot: bigint,
): Promise<EthereumUpdate> {
  // From Gloas on, the gno-side client reads the state root from the
  // execution header the finalized beacon header commits to.
  const execHeader = u.finalized_header.execution
    ? undefined
    : (await executionHeader(c.publicClient, headerBlockHash(u.finalized_header))).rlp;
  const signatureSlot = BigInt(u.signature_slot);
  return {
    message: encodeHeader(u, active, isNext, trustedSlot, execHeader),
    trustedSlot,
    finalizedSlot: BigInt(u.finalized_header.beacon.slot),
    signatureSlot,
    signatureTime: slotTime(p, signatureSlot),
  };
}

/** One update of a catch-up plan, with the committee period that signs it. */
export interface PlannedUpdate {
  update: LightClientUpdate
  signingPeriod: bigint
  isNext: boolean
  trustedSlot: bigint
}

/**
 * Plans the updates that bring a gno-side client trusting the finalized slot
 * trusted to the finality update fin: first the update revealing the next sync
 * committee when the trusted state does not know it, then one best update per
 * period to cross, then fin itself. Any of the earlier updates may advance
 * finality on its own; once one reaches fin's finalized slot, fin is not
 * appended, since the client would refuse an update that does not advance it.
 */
export async function planUpdates(
  beacon: Pick<EthereumIbcClient["beacon"], "updates">,
  slotsPerPeriod: bigint,
  fin: LightClientUpdate,
  trustedSlot: bigint,
  nextSyncCommitteeKnown: boolean,
): Promise<PlannedUpdate[]> {
  const plan: PlannedUpdate[] = [];
  const finalized = BigInt(fin.finalized_header.beacon.slot);
  let trusted = trustedSlot;
  let nextKnown = nextSyncCommitteeKnown;
  for (;;) {
    if (finalized <= trusted) {
      return plan;
    }
    const period = trusted / slotsPerPeriod;
    if (!nextKnown) {
      const [u] = await beacon.updates(period, 1);
      if (!u?.next_sync_committee) {
        throw new Error(`no update revealing the next sync committee of period ${period}`);
      }
      plan.push({
        update: u,
        signingPeriod: period,
        isNext: false,
        trustedSlot: trusted,
      });
      nextKnown = true;
      const f = BigInt(u.finalized_header.beacon.slot);
      if (f > trusted) {
        trusted = f;
      }
      continue;
    }
    const signaturePeriod = BigInt(fin.signature_slot) / slotsPerPeriod;
    if (signaturePeriod <= period + 1n) {
      plan.push({
        update: fin,
        signingPeriod: signaturePeriod,
        isNext: signaturePeriod === period + 1n,
        trustedSlot: trusted,
      });
      return plan;
    }
    // Several periods behind: cross into the next one with its best update,
    // signed by the next committee, which also reveals the one after.
    const [u] = await beacon.updates(period + 1n, 1);
    if (!u) {
      throw new Error(`no update for period ${period + 1n}`);
    }
    plan.push({
      update: u,
      signingPeriod: period + 1n,
      isNext: true,
      trustedSlot: trusted,
    });
    trusted = BigInt(u.finalized_header.beacon.slot);
    nextKnown = u.next_sync_committee !== undefined;
  }
}

/**
 * The updates that bring a gno-side client trusting lastHeight (a finalized
 * slot) to the latest finality, at or past targetHeight (see planUpdates).
 * Throws NotFinalizedError when finality has not reached targetHeight yet.
 */
export async function buildHeader(
  c: EthereumIbcClient,
  lastHeight: number,
  targetHeight?: number,
  nextSyncCommitteeKnown = true,
): Promise<EthereumLightClientHeader> {
  const p = await chainParams(c);
  const fin = await c.beacon.finalityUpdate();
  const finalized = BigInt(fin.finalized_header.beacon.slot);
  if (targetHeight !== undefined && finalized < BigInt(targetHeight)) {
    throw new NotFinalizedError(`Ethereum has finalized slot ${finalized}, not yet ${targetHeight}`);
  }
  const plan = await planUpdates(c.beacon, p.slotsPerEpoch * p.epochsPerSyncCommitteePeriod, fin,
    BigInt(lastHeight), nextSyncCommitteeKnown);
  const updates: EthereumLightClientHeader = [];
  for (const s of plan) {
    updates.push(await toUpdate(c, p, s.update, await committeeOf(c, s.signingPeriod), s.isNext, s.trustedSlot));
  }
  return updates;
}

export const commitmentStorageSlot = (path: Uint8Array): Hex => commitmentSlot(path);
export const pathHex = (path: Uint8Array): Hex => bytesToHex(path);
