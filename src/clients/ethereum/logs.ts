/** Chunked eth_getLogs scans, shared by the gno-client host and the Ethereum source. */

/** The first chunk of an eth_getLogs scan, in blocks; a node refusing it gets half, down to MIN_LOG_CHUNK. */
export const LOG_CHUNK = 50_000n;
export const MIN_LOG_CHUNK = 1_000n;

/**
 * Collects the logs of [fromBlock, toBlock] through `request`, one block
 * range at a time: public RPCs cap the range of one eth_getLogs ("exceeded
 * max allowed range"), so a refused range is split in two until the node
 * accepts it, down to MIN_LOG_CHUNK; a refusal there is the node's last word.
 */
export async function getLogsChunked<T>(
  request: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  chunk: bigint = LOG_CHUNK,
): Promise<T[]> {
  const out: T[] = [];
  let from = fromBlock;
  let size = chunk;
  while (from <= toBlock) {
    const to = from + size - 1n > toBlock ? toBlock : from + size - 1n;
    try {
      out.push(...await request(from, to));
      from = to + 1n;
    }
    catch (err) {
      if (size <= MIN_LOG_CHUNK) {
        throw err;
      }
      size = size / 2n < MIN_LOG_CHUNK ? MIN_LOG_CHUNK : size / 2n;
    }
  }
  return out;
}
