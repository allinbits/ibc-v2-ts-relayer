/**
 * Parsing of the IBC core realm's JSON renders (vm/qrender). The realm
 * answers a failure, such as an unknown client, with a JSON object
 * {"error": "..."} rather than an ABCI error, and lists as pages
 * {"items": [...], "page": n, "total": pages}. Only a well-formed list is
 * an answer: anything else throws, so that no caller takes a failed query
 * for an empty list.
 */

/** The most items the realm serves on one page (jsonpage maxLimit). */
export const RENDER_PAGE_LIMIT = 100;

export interface RenderPage {
  items: unknown[]
  /** The number of pages. */
  total: number
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
  if (!Array.isArray(items) || !Number.isSafeInteger(total) || (total as number) < 0 || got !== page) {
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
