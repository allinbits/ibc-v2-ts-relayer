/**
 * Parsing of the IBC core realm's JSON renders (vm/qrender). The realm
 * answers a failure, such as an unknown client, with a JSON object
 * {"error": "..."} rather than an ABCI error, and lists as pages
 * {"items": [...], "page": n, "total": pages}. Only a well-formed list is
 * an answer: anything else throws, so that no caller takes a failed query
 * for an empty list.
 */
import {
  fromBase64,
} from "@cosmjs/encoding";

import type {
  ConsensusStateSummary,
} from "../../types/index.js";

/** The most items the realm serves on one page (jsonpage maxLimit). */
export const RENDER_PAGE_LIMIT = 100;

export interface RenderPage {
  items: unknown[]
  /** The number of pages, at least 1. */
  total: number
}

/** A list render: its first page, and any page read at the same height as it. */
export interface RenderList {
  first: RenderPage
  page: (page: number) => Promise<RenderPage>
}

/** Parses one page of a list render, asked for as page `page` by `query`. */
export function parseRenderPage(raw: string, query: string, page: number): RenderPage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  }
  catch {
    throw new Error(`query ${query}: the answer is not JSON: ${raw.slice(0, 200)}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`query ${query}: expected a page of items, got ${raw.slice(0, 200)}`);
  }
  if ("error" in data) {
    throw new Error(`query ${query}: ${String((data as {
      error: unknown
    }).error)}`);
  }
  const {
    items, page: got, total,
  } = data as Record<string, unknown>;
  // The realm counts at least one page, an empty one for an empty list.
  if (!Array.isArray(items) || !Number.isSafeInteger(total) || (total as number) < 1 || got !== page || page > (total as number)) {
    throw new Error(`query ${query}: expected page ${page} of items, got ${raw.slice(0, 200)}`);
  }
  return {
    items,
    total: total as number,
  };
}

/** The sequences of a list of receipts or commitments, each a decimal uint64 string. */
export function renderedSequences(items: readonly unknown[], query: string): Set<bigint> {
  const sequences = new Set<bigint>();
  for (const item of items) {
    const sequence = item !== null && typeof item === "object" ? (item as Record<string, unknown>).sequence : undefined;
    if (typeof sequence !== "string" || !/^\d+$/.test(sequence)) {
      throw new Error(`query ${query}: item without a decimal sequence: ${JSON.stringify(item)}`);
    }
    sequences.add(BigInt(sequence));
  }
  return sequences;
}

/** A non-negative integer the realm renders as a JSON number (or a decimal string). */
function renderedUint(v: unknown): bigint | undefined {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) {
    return BigInt(v);
  }
  if (typeof v === "string" && /^\d+$/.test(v)) {
    return BigInt(v);
  }
  return undefined;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** One item of a clients/{id}/consensus_states render, as the misbehaviour monitor reads it. */
export function renderedConsensusState(item: unknown, clientId: string): ConsensusStateSummary {
  const it = item !== null && typeof item === "object"
    ? item as Record<string, unknown>
    : {
    };
  const h = it.height !== null && typeof it.height === "object"
    ? it.height as Record<string, unknown>
    : {
    };
  const revisionNumber = renderedUint(h.revision_number);
  const revisionHeight = renderedUint(h.revision_height);
  const timestamp = renderedUint(it.timestamp);
  const {
    root, next_validators_hash: nextValidatorsHash,
  } = it;
  if (revisionNumber === undefined || revisionHeight === undefined || timestamp === undefined
    || typeof root !== "string" || !BASE64.test(root) || typeof nextValidatorsHash !== "string" || !BASE64.test(nextValidatorsHash)) {
    throw new Error(`consensus state of ${clientId}: malformed item ${JSON.stringify(item)}`);
  }
  return {
    revisionNumber,
    revisionHeight,
    timestampNanos: timestamp * 1_000_000_000n,
    timestampPrecision: "seconds",
    root: fromBase64(root),
    nextValidatorsHash: fromBase64(nextValidatorsHash),
  };
}

/** The commitment of sequence in a clients/{id}/packet_commitments list, or undefined if absent. */
export function renderedCommitment(items: readonly unknown[], sequence: bigint, query: string): Uint8Array | undefined {
  renderedSequences(items, query);
  const item = items.find(i => BigInt((i as {
    sequence: string
  }).sequence) === sequence) as Record<string, unknown> | undefined;
  if (item === undefined) {
    return undefined;
  }
  if (typeof item.data !== "string" || !BASE64.test(item.data)) {
    throw new Error(`query ${query}: commitment ${sequence} without base64 data`);
  }
  return fromBase64(item.data);
}
