/**
 * Ethereum as a host of gno.land light clients: GnoLightClient contracts
 * (github.com/gnolang/gno-eth-ibc) behind the solidity-ibc-eureka v3.0.2
 * ICS26 router.
 *
 * Client ids: the router assigns `client-<n>` when a client is added, and
 * the Link registers the counterparty only after both clients exist. So
 * createGnoClient deploys the contract and returns the id the router will
 * assign next; registerCounterParty adds it with
 * `ICS26Router.addClient(CounterpartyInfo, address)` — the permissionless
 * overload in v3.0.2 (the `addClient(string clientId, …)` overload that picks
 * a custom id needs the AccessManager's ID_CUSTOMIZER_ROLE) — and fails if
 * the router assigned another id meanwhile.
 *
 * Reads that follow a write are made at the write's block: behind a load
 * balancer the next request may reach a node that has not seen it yet.
 */
import {
  Any,
} from "@atomone/atomone-types/google/protobuf/any.js";
import {
  Acknowledgement, Packet as PacketV2,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  Height,
} from "@atomone/atomone-types/ibc/core/client/v1/client.js";
import {
  Event,
} from "@cosmjs/stargate";
import {
  ibc,
} from "@gnolang/gno-types";
import {
  Abi, BaseError, ContractFunctionRevertedError, decodeAbiParameters, decodeEventLog, encodeFunctionData, Hex, toHex, TransactionReceipt,
} from "viem";

import {
  AckV2, AnyClientState, AnyConsensusState, ClientStatus, ClientType, ConsensusStateSummary, CreateClientResult, MsgResult,
} from "../../types/index.js";
import {
  BaseIbcClient, isGno,
} from "../BaseIbcClient.js";
import {
  gnoLightClientAbi, gnoLightClientBytecode,
} from "./artifacts/GnoLightClient.js";
import {
  iCS26RouterAbi,
} from "./artifacts/ICS26Router.js";
import {
  encodeHeader, encodeMembershipProof, encodeMisbehaviour, encodeNonMembershipProof, toValidators, validatorSetHash,
} from "./gnoibc.js";
import type {
  EthereumIbcClient,
} from "./IbcClient.js";
import {
  getLogsChunked,
} from "./logs.js";

const GNO_LC_TYPE = "10-gno";
const NANOS = 1_000_000_000n;

/** The router's ABI with GnoLightClient's errors and events, so reverts and logs from either decode. */
const ROUTER_ABI = [...iCS26RouterAbi, ...gnoLightClientAbi.filter(x => x.type === "error" || x.type === "event")] as Abi;
const LC_ABI = gnoLightClientAbi as Abi;

const CLIENT_STATE_PARAMS = [
  {
    type: "tuple",
    components: [
      {
        name: "chainId",
        type: "string",
      },
      {
        name: "revisionNumber",
        type: "uint64",
      },
      {
        name: "latestHeight",
        type: "uint64",
      },
      {
        name: "trustLevel",
        type: "tuple",
        components: [
          {
            name: "numerator",
            type: "uint64",
          },
          {
            name: "denominator",
            type: "uint64",
          },
        ],
      },
      {
        name: "trustingPeriod",
        type: "uint64",
      },
      {
        name: "maxClockDrift",
        type: "uint64",
      },
      {
        name: "isFrozen",
        type: "bool",
      },
    ],
  },
] as const;

/** GnoLightClient.ClientState. */
export interface LcClientState {
  chainId: string
  revisionNumber: bigint
  latestHeight: bigint
  trustLevel: {
    numerator: bigint
    denominator: bigint
  }
  trustingPeriod: bigint
  maxClockDrift: bigint
  isFrozen: boolean
}

/** GnoLightClient.ConsensusState. */
export interface LcConsensusState {
  timestamp: bigint
  appHash: Hex
  nextValidatorsHash: Hex
}

// ------------------------------------------------------------------ chain access

/** The fields of a log decodeEventLog needs (viem's Log type is unusable without strictNullChecks). */
interface RawLog {
  address: Hex
  data: Hex
  topics: readonly Hex[]
}

function rawLogs(receipt: TransactionReceipt): RawLog[] {
  return receipt.logs as unknown as RawLog[];
}

interface BlockTag {
  blockNumber?: bigint
}

function hexToBytes(h: Hex): Uint8Array {
  return Uint8Array.from(Buffer.from(h.slice(2), "hex"));
}

function result(receipt: TransactionReceipt, events: Event[] = []): MsgResult {
  return {
    events,
    transactionHash: receipt.transactionHash.slice(2).toUpperCase(),
    height: Number(receipt.blockNumber),
  };
}

/** Explains a revert with the router's and GnoLightClient's errors. */
function explain(err: unknown, what: string): Error {
  if (err instanceof BaseError) {
    const revert = err.walk(e => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data) {
      return new Error(`${what}: ${revert.data.errorName}(${(revert.data.args ?? []).map(String).join(", ")})`);
    }
    return new Error(`${what}: ${err.shortMessage}`);
  }
  return err instanceof Error ? err : new Error(`${what}: ${String(err)}`);
}

/** Simulates (to fail early with a decoded error), sends and waits for a successful receipt. */
async function write(
  c: EthereumIbcClient, address: Hex, abi: Abi, functionName: string, args: readonly unknown[], what: string,
): Promise<{
  receipt: TransactionReceipt
  returned: unknown
}> {
  let returned: unknown;
  let hash: Hex;
  try {
    const sim = await c.publicClient.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: c.account,
    });
    returned = sim.result;
    hash = await c.walletClient.writeContract({
      address,
      abi,
      functionName,
      args,
      account: c.account,
      chain: null,
    });
  }
  catch (err) {
    throw explain(err, what);
  }
  const receipt = await c.publicClient.waitForTransactionReceipt({
    hash,
  });
  if (receipt.status !== "success") {
    throw new Error(`${what}: transaction ${hash} reverted`);
  }
  c.logger.verbose(`${what}: tx ${hash} in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
  return {
    receipt,
    returned,
  };
}

async function read<T>(c: EthereumIbcClient, address: Hex, abi: Abi, functionName: string, args: readonly unknown[], at?: BlockTag): Promise<T> {
  return await c.publicClient.readContract({
    address,
    abi,
    functionName,
    args,
    blockNumber: at?.blockNumber,
  } as never) as T;
}

/** The GnoLightClient behind a client id: deployed but not yet added, or registered on the router. */
export async function lightClientAddress(c: EthereumIbcClient, clientId: string, at?: BlockTag): Promise<Hex> {
  const pending = c.pendingClients.get(clientId);
  if (pending) {
    return pending;
  }
  return read<Hex>(c, c.config.router, ROUTER_ABI, "getClient", [clientId], at);
}

export async function readClientState(c: EthereumIbcClient, clientId: string, at?: BlockTag): Promise<LcClientState> {
  const lc = await lightClientAddress(c, clientId, at);
  const bz = await read<Hex>(c, lc, LC_ABI, "getClientState", [], at);
  const [cs] = decodeAbiParameters(CLIENT_STATE_PARAMS, bz);
  return cs;
}

export async function readConsensusState(c: EthereumIbcClient, clientId: string, height: bigint, at?: BlockTag): Promise<LcConsensusState> {
  const lc = await lightClientAddress(c, clientId, at);
  const cs = await read<LcConsensusState>(c, lc, LC_ABI, "getConsensusState", [height], at);
  if (cs.timestamp === 0n) {
    throw new Error(`no consensus state at height ${height} on ${clientId}`);
  }
  return cs;
}

async function isValidatorSetCached(c: EthereumIbcClient, lc: Hex, hash: Uint8Array | Hex): Promise<boolean> {
  return read<boolean>(c, lc, LC_ABI, "isValidatorSetCached", [typeof hash === "string" ? hash : toHex(hash)]);
}

function requireGno(type: ClientType) {
  if (type !== ClientType.Gno) {
    throw new Error(`Ethereum hosts only gno.land light clients, asked for a ${type} client`);
  }
}

// ------------------------------------------------------------------ clients

/**
 * GnoLightClient has no unbonding period of its own: report the one its
 * trusting period was derived from (the gno client takes 2/3 of it).
 */
export async function getUnbondingPeriod(c: EthereumIbcClient, clientId: string): Promise<number> {
  const cs = await readClientState(c, clientId);
  return Number(cs.trustingPeriod * 3n / 2n);
}

export async function createGnoClient(
  c: EthereumIbcClient,
  clientState: ibc.lightclients.gno.v1.gno.ClientState,
  consensusState: ibc.lightclients.gno.v1.gno.ConsensusState,
): Promise<CreateClientResult> {
  const latest = clientState.latestHeight;
  if (!latest || !consensusState.timestamp || !consensusState.root?.hash) {
    throw new Error("gno client state needs a latest height, and its consensus state a timestamp and root");
  }
  const cs = {
    chainId: clientState.chainId,
    revisionNumber: latest.revisionNumber,
    latestHeight: latest.revisionHeight,
    trustLevel: {
      numerator: clientState.trustLevel?.numerator ?? 1n,
      denominator: clientState.trustLevel?.denominator ?? 3n,
    },
    trustingPeriod: clientState.trustingPeriod?.seconds ?? 0n,
    maxClockDrift: clientState.maxClockDrift?.seconds ?? 0n,
    isFrozen: false,
  };
  const cons = {
    timestamp: consensusState.timestamp.seconds * NANOS + BigInt(consensusState.timestamp.nanos),
    appHash: toHex(consensusState.root.hash),
    nextValidatorsHash: toHex(consensusState.nextValidatorsHash),
  };
  let hash: Hex;
  try {
    hash = await c.walletClient.deployContract({
      abi: gnoLightClientAbi,
      bytecode: gnoLightClientBytecode,
      args: [cs, cons],
      account: c.account,
      chain: null,
    });
  }
  catch (err) {
    throw explain(err, "deploy GnoLightClient");
  }
  const receipt = await c.publicClient.waitForTransactionReceipt({
    hash,
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`deploy GnoLightClient: transaction ${hash} failed`);
  }
  const seq = await read<bigint>(c, c.config.router, ROUTER_ABI, "getNextClientSeq", [], {
    blockNumber: receipt.blockNumber,
  });
  const clientId = `client-${seq}`;
  c.pendingClients.set(clientId, receipt.contractAddress);
  c.logger.info(`Deployed GnoLightClient for ${clientState.chainId} at ${receipt.contractAddress}; the router will add it as ${clientId}`);
  return {
    ...result(receipt),
    clientId,
  };
}

export async function registerCounterParty(
  c: EthereumIbcClient,
  clientId: string,
  counterpartyClientId: string,
  merklePrefix: Uint8Array,
  merklePathPrefix?: Uint8Array,
): Promise<MsgResult> {
  const lc = c.pendingClients.get(clientId);
  if (!lc) {
    throw new Error(`no GnoLightClient waiting to be added as ${clientId}: create it with createGnoClient first`);
  }
  const prefix = [toHex(merklePrefix)];
  if (merklePathPrefix?.length) {
    prefix.push(toHex(merklePathPrefix));
  }
  const {
    receipt, returned,
  } = await write(c, c.config.router, ROUTER_ABI, "addClient", [
    {
      clientId: counterpartyClientId,
      merklePrefix: prefix,
    },
    lc,
  ], `add ${clientId}`);
  // Trust the id the router logged over the one the simulation returned.
  let assigned = returned as string;
  for (const log of rawLogs(receipt)) {
    try {
      const ev = decodeEventLog({
        abi: ROUTER_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (ev.eventName === "ICS02ClientAdded") {
        assigned = (ev.args as unknown as {
          clientId: string
        }).clientId;
      }
    }
    catch {
      // another contract's event
    }
  }
  c.pendingClients.delete(clientId);
  if (assigned !== clientId) {
    throw new Error(`router added GnoLightClient ${lc} as ${assigned}, not ${clientId} (another client was added meanwhile): use ${assigned}`);
  }
  return result(receipt);
}

// ------------------------------------------------------------------ updates

function isTrustLevelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /trusted signers hold|InsufficientTrustedVotingPower/.test(msg);
}

/**
 * Updates the client to the source's latest header. If the trust level over
 * the trusted set cannot be met (too much validator churn), bisects like the
 * gno and tendermint clients do.
 */
export async function updateClient(c: EthereumIbcClient, clientId: string, src: BaseIbcClient): Promise<Height> {
  if (!isGno(src)) {
    throw new Error(`Ethereum hosts only gno.land light clients, got a ${src.clientType} source`);
  }
  const cs = await readClientState(c, clientId);
  const final = await updateClientBisect(c, clientId, src, Number(cs.latestHeight));
  return src.revisionHeight(final);
}

async function updateClientBisect(
  c: EthereumIbcClient, clientId: string, src: BaseIbcClient, trustedHeight: number, targetHeight?: number,
): Promise<number> {
  if (!isGno(src)) {
    throw new Error(`Ethereum hosts only gno.land light clients, got a ${src.clientType} source`);
  }
  const header = await src.buildHeader(trustedHeight, targetHeight);
  const attempted = Number(header.signedHeader?.header?.height ?? 0);
  try {
    await updateGnoClient(c, clientId, header);
    return attempted;
  }
  catch (err) {
    if (!isTrustLevelError(err)) {
      throw err;
    }
    if (attempted - trustedHeight <= 1) {
      throw new Error(`updateClient bisection exhausted at gap=1, height ${attempted} from trusted ${trustedHeight}: ${(err as Error).message}`);
    }
    const mid = Math.floor((trustedHeight + attempted) / 2);
    c.logger.info(`updateClient ${clientId}: trust level not met at ${attempted} from ${trustedHeight}; bisecting at ${mid}`);
    const intermediate = await updateClientBisect(c, clientId, src, trustedHeight, mid);
    return updateClientBisect(c, clientId, src, intermediate, attempted);
  }
}

/**
 * Encodes a gno header for GnoLightClient: the fewest signatures that clear
 * its thresholds, and no keys for the validator sets it has cached.
 */
async function encodeForClient(c: EthereumIbcClient, lc: Hex, clientId: string, header: ibc.lightclients.gno.v1.gno.Header) {
  const h = header.signedHeader?.header;
  const trustedHeight = header.trustedHeight?.revisionHeight;
  if (!h || trustedHeight === undefined) {
    throw new Error("gno header without a signed header or trusted height");
  }
  const trusted = await readConsensusState(c, clientId, trustedHeight);
  const hasTrustedVals = (header.trustedValidators?.validators?.length ?? 0) > 0;
  if (hasTrustedVals) {
    const tvHash = toHex(validatorSetHash(toValidators(header.trustedValidators)));
    if (tvHash !== trusted.nextValidatorsHash) {
      throw new Error(`trusted validators hash ${tvHash}, but the consensus state at ${trustedHeight} expects ${trusted.nextValidatorsHash}`);
    }
  }
  const [omitValidators, omitTrusted] = await Promise.all([isValidatorSetCached(c, lc, h.validatorsHash), isValidatorSetCached(c, lc, trusted.nextValidatorsHash)]);
  return encodeHeader(header, {
    trustedHeight,
    trustedValidators: hasTrustedVals ? header.trustedValidators : undefined,
    omitValidators,
    omitTrusted,
  });
}

export async function updateGnoClient(
  c: EthereumIbcClient,
  clientId: string,
  header: ibc.lightclients.gno.v1.gno.Header,
): Promise<MsgResult> {
  const lc = await lightClientAddress(c, clientId);
  const enc = await encodeForClient(c, lc, clientId, header);
  const {
    receipt,
  } = await write(c, c.config.router, ROUTER_ABI, "updateClient", [clientId, enc.message], `update ${clientId} to ${enc.height}`);
  c.logger.info(`Updated ${clientId} to gno height ${enc.height}: ${enc.signatures} signatures, ${enc.keysSent} keys, gas ${receipt.gasUsed}`);
  // A valid header that conflicts with a stored one freezes the client
  // instead of reverting.
  const cs = await readClientState(c, clientId, {
    blockNumber: receipt.blockNumber,
  });
  if (cs.isFrozen) {
    throw new Error(`${clientId} is frozen: the header at ${enc.height} conflicts with a trusted one (tx ${receipt.transactionHash})`);
  }
  return result(receipt);
}

export async function getClientStatus(c: EthereumIbcClient, clientId: string): Promise<ClientStatus> {
  const block = await c.publicClient.getBlock();
  const at = {
    blockNumber: block.number,
  };
  const cs = await readClientState(c, clientId, at);
  if (cs.isFrozen) {
    return ClientStatus.Frozen;
  }
  const latest = await readConsensusState(c, clientId, cs.latestHeight, at);
  if (latest.timestamp + cs.trustingPeriod * NANOS <= block.timestamp * NANOS) {
    return ClientStatus.Expired;
  }
  return ClientStatus.Active;
}

/**
 * Consensus states stored after a height, from GnoLightClient's ClientUpdated
 * logs: eth_getLogs from the chain config's fromBlock (the router's
 * deployment block; 0 without one) to the tip, in chunks a public RPC accepts.
 */
export async function getConsensusStatesAfter(
  c: EthereumIbcClient,
  clientId: string,
  type: ClientType,
  afterRevisionHeight: bigint,
  limit: number,
): Promise<ConsensusStateSummary[]> {
  requireGno(type);
  const tip = await c.publicClient.getBlockNumber();
  const at = {
    blockNumber: tip,
  };
  const lc = await lightClientAddress(c, clientId, at);
  const cs = await readClientState(c, clientId, at);
  let logs: RawLog[];
  const start = BigInt(c.config.fromBlock ?? "0");
  try {
    logs = await getLogsChunked(
      (fromBlock, toBlock) => c.publicClient.request({
        method: "eth_getLogs",
        params: [
          {
            address: lc,
            fromBlock: toHex(fromBlock),
            toBlock: toHex(toBlock),
          },
        ],
      }) as Promise<RawLog[]>,
      start,
      tip,
    );
  }
  catch (err) {
    throw new Error(`getConsensusStatesAfter: the node refused eth_getLogs over the client's lifetime (from block ${start}): ${(err as Error).message}`);
  }
  const heights = new Set<bigint>();
  for (const log of logs) {
    try {
      const ev = decodeEventLog({
        abi: LC_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (ev.eventName === "ClientUpdated") {
        heights.add((ev.args as unknown as {
          height: bigint
        }).height);
      }
    }
    catch {
      // another event
    }
  }
  const after = [...heights]
    .filter(h => h > afterRevisionHeight)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit);
  return Promise.all(after.map(async (h) => {
    const s = await readConsensusState(c, clientId, h, at);
    return {
      revisionNumber: cs.revisionNumber,
      revisionHeight: h,
      timestampNanos: s.timestamp,
      timestampPrecision: "nanoseconds" as const,
      root: hexToBytes(s.appHash),
      nextValidatorsHash: hexToBytes(s.nextValidatorsHash),
    };
  }));
}

export async function findConflictingHeader(_c: EthereumIbcClient, _clientId: string, _height: Height): Promise<Any | undefined> {
  throw new Error("findConflictingHeader on Ethereum: not supported yet (it needs the update calldata behind each ClientUpdated log)");
}

/** Submits an ibc.lightclients.gno.v1.Misbehaviour through ICS26Router.submitMisbehaviour. */
export async function submitMisbehaviour(c: EthereumIbcClient, clientId: string, misbehaviour: Any): Promise<MsgResult> {
  if (misbehaviour.typeUrl !== "/ibc.lightclients.gno.v1.Misbehaviour") {
    throw new Error(`GnoLightClient takes /ibc.lightclients.gno.v1.Misbehaviour, got ${misbehaviour.typeUrl}`);
  }
  const m = ibc.lightclients.gno.v1.gno.Misbehaviour.decode(misbehaviour.value);
  if (!m.header1 || !m.header2) {
    throw new Error("misbehaviour needs two headers");
  }
  const lc = await lightClientAddress(c, clientId);
  const [h1, h2] = await Promise.all([encodeForClient(c, lc, clientId, m.header1), encodeForClient(c, lc, clientId, m.header2)]);
  const {
    receipt,
  } = await write(c, c.config.router, ROUTER_ABI, "submitMisbehaviour", [clientId, encodeMisbehaviour(h1.struct, h2.struct)], `misbehaviour on ${clientId}`);
  return result(receipt);
}

/**
 * Submits the source's header at targetHeight as an update. If the client
 * holds a different header at that height, GnoLightClient freezes.
 */
export async function submitConflictingHeader(
  c: EthereumIbcClient,
  clientId: string,
  src: BaseIbcClient,
  trustedHeight: number,
  targetHeight: number,
): Promise<number> {
  if (!isGno(src)) {
    throw new Error(`Ethereum hosts only gno.land light clients, got a ${src.clientType} source`);
  }
  const header = await src.buildHeader(trustedHeight, targetHeight);
  try {
    await updateGnoClient(c, clientId, header);
  }
  catch (err) {
    if (!/is frozen/.test((err as Error).message)) {
      throw err;
    }
  }
  return targetHeight;
}

// ------------------------------------------------------------------ packets

interface AbiPacket {
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
}

export function toAbiPacket(p: PacketV2): AbiPacket {
  return {
    sequence: p.sequence,
    sourceClient: p.sourceClient,
    destClient: p.destinationClient,
    timeoutTimestamp: p.timeoutTimestamp,
    payloads: p.payloads.map(pl => ({
      sourcePort: pl.sourcePort,
      destPort: pl.destinationPort,
      version: pl.version,
      encoding: pl.encoding,
      value: toHex(pl.value),
    })),
  };
}

function fromAbiPacket(p: AbiPacket): PacketV2 {
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

function abiHeight(h: Height) {
  return {
    revisionNumber: h.revisionNumber,
    revisionHeight: h.revisionHeight,
  };
}

/**
 * Sends one router call per item, batched with the router's multicall when
 * there are several (all or nothing).
 */
async function sendBatch(c: EthereumIbcClient, functionName: string, calls: unknown[][], what: string): Promise<TransactionReceipt> {
  if (calls.length === 0) {
    throw new Error(`${what}: nothing to send`);
  }
  if (calls.length === 1) {
    return (await write(c, c.config.router, ROUTER_ABI, functionName, calls[0], what)).receipt;
  }
  const data = calls.map(args => encodeFunctionData({
    abi: ROUTER_ABI,
    functionName,
    args,
  }));
  return (await write(c, c.config.router, ROUTER_ABI, "multicall", [data], what)).receipt;
}

/**
 * The router's WriteAcknowledgement logs as the write_acknowledgement events
 * link.ts parses (parseAcksFromTxEventsV2), the acknowledgement encoded as
 * the gno core encodes it: protobuf ibc.core.channel.v2.Acknowledgement.
 */
export function writeAckEvents(logs: readonly RawLog[], router: Hex): Event[] {
  const events: Event[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== router.toLowerCase()) {
      continue;
    }
    let ev;
    try {
      ev = decodeEventLog({
        abi: ROUTER_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    }
    catch {
      continue;
    }
    if (ev.eventName !== "WriteAcknowledgement") {
      continue;
    }
    const args = ev.args as unknown as {
      packet: AbiPacket
      acknowledgements: readonly Hex[]
    };
    const ack = Acknowledgement.fromPartial({
      appAcknowledgements: args.acknowledgements.map(hexToBytes),
    });
    events.push({
      type: "write_acknowledgement",
      attributes: [
        {
          key: "encoded_packet_hex",
          value: Buffer.from(PacketV2.encode(fromAbiPacket(args.packet)).finish()).toString("hex"),
        },
        {
          key: "encoded_acknowledgement_hex",
          value: Buffer.from(Acknowledgement.encode(ack).finish()).toString("hex"),
        },
      ],
    });
  }
  return events;
}

function requireProofHeight(h: Height | undefined, what: string): Height {
  if (!h) {
    throw new Error(`${what}: a proof height (the gno header height the client was updated to) is required`);
  }
  return h;
}

/**
 * Proofs are what GnoIbcClient.getPacketProofV2 returns: MerkleProof bytes
 * for the state at proofHeight - 1, which the AppHash of the header at
 * proofHeight commits to — GnoLightClient's convention too.
 */
export async function receivePacketsV2(
  c: EthereumIbcClient,
  packets: readonly PacketV2[],
  proofCommitments: readonly Uint8Array[],
  proofHeight?: Height,
): Promise<MsgResult> {
  if (packets.length !== proofCommitments.length) {
    throw new Error(`Have ${packets.length} packets, but ${proofCommitments.length} proofs`);
  }
  const h = abiHeight(requireProofHeight(proofHeight, "receivePacketsV2"));
  const calls = packets.map((p, i) => [
    {
      packet: toAbiPacket(p),
      proofCommitment: encodeMembershipProof(proofCommitments[i]),
      proofHeight: h,
    },
  ]);
  const receipt = await sendBatch(c, "recvPacket", calls, `recvPacket x${packets.length}`);
  return result(receipt, writeAckEvents(rawLogs(receipt), c.config.router));
}

/**
 * The app acknowledgement of a single-payload packet. Acks written on gno
 * arrive as the core's protobuf Acknowledgement{app_acknowledgements}; bytes
 * that do not round-trip as one (a raw app ack) are passed through.
 */
export function appAcknowledgement(ack: Uint8Array): Uint8Array {
  let decoded: Acknowledgement;
  try {
    decoded = Acknowledgement.decode(ack);
  }
  catch {
    return ack;
  }
  const reencoded = Acknowledgement.encode(decoded).finish();
  if (decoded.appAcknowledgements.length === 0 || !Buffer.from(reencoded).equals(Buffer.from(ack))) {
    return ack;
  }
  if (decoded.appAcknowledgements.length !== 1) {
    throw new Error(`ICS26Router acknowledges one payload per packet, got ${decoded.appAcknowledgements.length} acknowledgements`);
  }
  return decoded.appAcknowledgements[0];
}

export async function acknowledgePacketsV2(
  c: EthereumIbcClient,
  acks: readonly AckV2[],
  proofAckeds: readonly Uint8Array[],
  proofHeight?: Height,
): Promise<MsgResult> {
  if (acks.length !== proofAckeds.length) {
    throw new Error(`Have ${acks.length} acks, but ${proofAckeds.length} proofs`);
  }
  const h = abiHeight(requireProofHeight(proofHeight, "acknowledgePacketsV2"));
  const calls = acks.map((a, i) => [
    {
      packet: toAbiPacket(a.originalPacket),
      acknowledgement: toHex(appAcknowledgement(a.acknowledgement)),
      proofAcked: encodeMembershipProof(proofAckeds[i]),
      proofHeight: h,
    },
  ]);
  return result(await sendBatch(c, "ackPacket", calls, `ackPacket x${acks.length}`));
}

export async function timeoutPacketsV2(
  c: EthereumIbcClient,
  packets: PacketV2[],
  proofsUnreceived: Uint8Array[],
  proofHeight: Height,
): Promise<MsgResult> {
  if (packets.length !== proofsUnreceived.length) {
    throw new Error(`Have ${packets.length} packets, but ${proofsUnreceived.length} proofs`);
  }
  const h = abiHeight(requireProofHeight(proofHeight, "timeoutPacketsV2"));
  const calls = packets.map((p, i) => [
    {
      packet: toAbiPacket(p),
      proofTimeout: encodeNonMembershipProof(proofsUnreceived[i]),
      proofHeight: h,
    },
  ]);
  return result(await sendBatch(c, "timeoutPacket", calls, `timeoutPacket x${packets.length}`));
}

// ------------------------------------------------------------------ client state views

export async function getLatestClientState(c: EthereumIbcClient, clientId: string, type: ClientType): Promise<AnyClientState> {
  requireGno(type);
  return toGnoClientState(await readClientState(c, clientId));
}

/** GnoLightClient's state in the shape the Link reads for gno clients (lcType "10-gno"). */
export function toGnoClientState(cs: LcClientState): ibc.lightclients.gno.v1.gno.ClientState {
  return ibc.lightclients.gno.v1.gno.ClientState.fromPartial({
    chainId: cs.chainId,
    trustLevel: cs.trustLevel,
    trustingPeriod: {
      seconds: cs.trustingPeriod,
    },
    unbondingPeriod: {
      seconds: cs.trustingPeriod * 3n / 2n,
    },
    maxClockDrift: {
      seconds: cs.maxClockDrift,
    },
    frozenHeight: cs.isFrozen
      ? {
        revisionNumber: 0n,
        revisionHeight: 1n,
      }
      : undefined,
    latestHeight: {
      revisionNumber: cs.revisionNumber,
      revisionHeight: cs.latestHeight,
    },
    lcType: GNO_LC_TYPE,
  });
}

export function toGnoConsensusState(cons: LcConsensusState): ibc.lightclients.gno.v1.gno.ConsensusState {
  return ibc.lightclients.gno.v1.gno.ConsensusState.fromPartial({
    timestamp: {
      seconds: cons.timestamp / NANOS,
      nanos: Number(cons.timestamp % NANOS),
    },
    root: {
      hash: hexToBytes(cons.appHash),
    },
    nextValidatorsHash: hexToBytes(cons.nextValidatorsHash),
    lcType: GNO_LC_TYPE,
  });
}

export async function getConsensusStateAtHeight(
  c: EthereumIbcClient,
  clientId: string,
  type: ClientType,
  consensusHeight?: Height,
): Promise<AnyConsensusState> {
  requireGno(type);
  const height = consensusHeight?.revisionHeight ?? (await readClientState(c, clientId)).latestHeight;
  return toGnoConsensusState(await readConsensusState(c, clientId, height));
}
