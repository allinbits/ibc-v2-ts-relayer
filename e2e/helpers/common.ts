import {
  createHash,
} from "node:crypto";

export const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(data).digest());

/**
 * Tendermint/tm2 `merkle.SimpleHashFromByteSlices`: an RFC 6962 Merkle root
 * with a 0x00 domain separator on leaves and 0x01 on inner nodes, splitting at
 * the largest power of two below the item count. Both the Tendermint and Gno
 * header hashes are this over their (differently encoded) header fields.
 */
export function merkleRoot(items: readonly Uint8Array[]): Uint8Array {
  if (items.length === 0) {
    return sha256(new Uint8Array());
  }
  if (items.length === 1) {
    return sha256(Buffer.concat([Buffer.from([0]), items[0]]));
  }
  let split = 1;
  while (split * 2 < items.length) {
    split *= 2;
  }
  return sha256(Buffer.concat([Buffer.from([1]), merkleRoot(items.slice(0, split)), merkleRoot(items.slice(split))]));
}
