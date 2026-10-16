/**
 * A client of the Ethereum beacon node API endpoints the relayer needs:
 * genesis, spec, blocks, and the light-client data.
 */

export interface BeaconBlockHeader {
  slot: string
  proposer_index: string
  parent_root: string
  state_root: string
  body_root: string
}

/** The pre-Gloas execution part of a light-client header (decimal strings). */
export interface ExecutionPayloadHeader {
  parent_hash: string
  fee_recipient: string
  state_root: string
  receipts_root: string
  logs_bloom: string
  prev_randao: string
  block_number: string
  gas_limit: string
  gas_used: string
  timestamp: string
  extra_data: string
  base_fee_per_gas: string
  block_hash: string
  transactions_root: string
  withdrawals_root: string
  blob_gas_used: string
  excess_blob_gas: string
}

/** A light-client header: `execution` before Gloas, `execution_block_hash` from it. */
export interface LightClientHeader {
  beacon: BeaconBlockHeader
  execution?: ExecutionPayloadHeader
  execution_block_hash?: string
  execution_branch: string[]
}

export interface SyncCommittee {
  pubkeys: string[]
  aggregate_pubkey: string
}

export interface LightClientUpdate {
  attested_header: LightClientHeader
  next_sync_committee?: SyncCommittee
  next_sync_committee_branch?: string[]
  finalized_header: LightClientHeader
  finality_branch: string[]
  sync_aggregate: {
    sync_committee_bits: string
    sync_committee_signature: string
  }
  signature_slot: string
}

export interface Bootstrap {
  header: LightClientHeader
  current_sync_committee: SyncCommittee
  current_sync_committee_branch: string[]
}

export interface Genesis {
  genesis_time: string
  genesis_validators_root: string
  genesis_fork_version: string
}

/** The execution block hash a light-client header commits to. */
export function headerBlockHash(h: LightClientHeader): string {
  const hash = h.execution?.block_hash ?? h.execution_block_hash;
  if (!hash) {
    throw new Error(`light-client header at slot ${h.beacon.slot} has no execution block hash`);
  }
  return hash;
}

export class BeaconClient {
  public readonly baseUrl: string;

  public constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      headers: {
        accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`beacon ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    return await res.json() as T;
  }

  public async genesis(): Promise<Genesis> {
    return (await this.get<{
      data: Genesis
    }>("/eth/v1/beacon/genesis")).data;
  }

  /** The node's chain parameters; only string values are kept. */
  public async spec(): Promise<Record<string, string>> {
    const data = (await this.get<{
      data: Record<string, unknown>
    }>("/eth/v1/config/spec")).data;
    return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }

  /** The root of the block at id (a slot, "head", "finalized" or a root). */
  public async blockRoot(id: string): Promise<string> {
    return (await this.get<{
      data: {
        root: string
      }
    }>(`/eth/v1/beacon/blocks/${id}/root`)).data.root;
  }

  public async bootstrap(blockRoot: string): Promise<Bootstrap> {
    return (await this.get<{
      data: Bootstrap
    }>(`/eth/v1/beacon/light_client/bootstrap/${blockRoot}`)).data;
  }

  /** The best update of each sync committee period from start. */
  public async updates(start: bigint, count: number): Promise<LightClientUpdate[]> {
    const res = await this.get<{
      data: LightClientUpdate
    }[]>(`/eth/v1/beacon/light_client/updates?start_period=${start}&count=${count}`);
    return res.map(r => r.data);
  }

  /**
   * The hash of the execution block the beacon block at id commits to: its
   * execution payload's before Gloas, its bid's parent block hash from Gloas
   * on — the block a light-client header for that slot carries.
   */
  public async executionBlockHash(id: string): Promise<string> {
    const body = (await this.get<{
      data: {
        message: {
          body: {
            execution_payload?: {
              block_hash: string
            }
            signed_execution_payload_bid?: {
              message: {
                parent_block_hash: string
              }
            }
          }
        }
      }
    }>(`/eth/v2/beacon/blocks/${id}`)).data.message.body;
    const hash = body.execution_payload?.block_hash ?? body.signed_execution_payload_bid?.message.parent_block_hash;
    if (!hash) {
      throw new Error(`beacon block ${id} commits to no execution block`);
    }
    return hash;
  }

  public async finalityUpdate(): Promise<LightClientUpdate> {
    return (await this.get<{
      data: LightClientUpdate
    }>("/eth/v1/beacon/light_client/finality_update")).data;
  }
}
