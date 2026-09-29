import {
  describe,
  expect,
  it,
} from "vitest";

import {
  ChainType,
  MisbehaviourKind,
  MisbehaviourStatus,
  NewMisbehaviourEvidence,
} from "../types/index.js";
import {
  IStorage,
} from "./storage-interface.js";

/**
 * Misbehaviour evidence and monitor cursor tests, run against every storage
 * backend so they behave the same.
 */
export function describeMisbehaviourStorage(getStorage: () => IStorage) {
  let nextHeight = 1000;

  async function newEvidence(overrides: Partial<NewMisbehaviourEvidence> = {
  }): Promise<NewMisbehaviourEvidence> {
    const path = await getStorage().addRelayPath(
      "mars", "http://mars:26657", undefined, "venus", "http://venus:26657", undefined,
      ChainType.Cosmos, ChainType.Cosmos, `07-tendermint-${nextHeight}`, `07-tendermint-${nextHeight + 1}`, 2,
    );
    nextHeight += 10;
    return {
      relayPathId: path!.id,
      side: "B",
      hostChainId: "venus",
      clientId: path!.clientB,
      revisionNumber: 0,
      revisionHeight: nextHeight,
      trustedRevisionHeight: nextHeight - 5,
      kind: MisbehaviourKind.Fork,
      conflictingHeader: "aGVhZGVy",
      conflictingHeaderTypeUrl: "/ibc.lightclients.tendermint.v1.Header",
      status: MisbehaviourStatus.Pending,
      ...overrides,
    };
  }

  describe("misbehaviour evidence", () => {
    it("stores new evidence with submission defaults", async () => {
      const evidence = await newEvidence();

      const stored = await getStorage().addMisbehaviourEvidence(evidence);

      expect(stored).toMatchObject(evidence);
      expect(stored.id).toBeDefined();
      expect(stored.attempts).toBe(0);
      expect(stored.txHash).toBeNull();
      expect(stored.error).toBeNull();
      expect(stored.createdAt).toBeGreaterThan(0);
      expect(stored.updatedAt).toBe(stored.createdAt);
    });

    it("keeps the first record when the same conflict is reported again", async () => {
      const evidence = await newEvidence();
      const first = await getStorage().addMisbehaviourEvidence(evidence);

      const second = await getStorage().addMisbehaviourEvidence({
        ...evidence,
        trustedRevisionHeight: 1,
        conflictingHeader: null,
      });

      expect(second.id).toBe(first.id);
      expect(second.trustedRevisionHeight).toBe(evidence.trustedRevisionHeight);
      expect(second.conflictingHeader).toBe(evidence.conflictingHeader);
    });

    it("stores evidence without a recovered header", async () => {
      const stored = await getStorage().addMisbehaviourEvidence(await newEvidence({
        conflictingHeader: null,
        conflictingHeaderTypeUrl: null,
      }));

      expect(stored.conflictingHeader).toBeNull();
      expect(stored.conflictingHeaderTypeUrl).toBeNull();
    });

    it("filters by status and returns records oldest first", async () => {
      const pending1 = await getStorage().addMisbehaviourEvidence(await newEvidence());
      const dryRun = await getStorage().addMisbehaviourEvidence(await newEvidence({
        status: MisbehaviourStatus.DryRun,
      }));
      const pending2 = await getStorage().addMisbehaviourEvidence(await newEvidence());

      const pending = await getStorage().getMisbehaviourEvidence(MisbehaviourStatus.Pending);
      const ids = pending.map(e => e.id);

      expect(ids).toContain(pending1.id);
      expect(ids).toContain(pending2.id);
      expect(ids).not.toContain(dryRun.id);
      expect(ids.indexOf(pending1.id)).toBeLessThan(ids.indexOf(pending2.id));
      expect((await getStorage().getMisbehaviourEvidence()).map(e => e.id)).toContain(dryRun.id);
    });

    it("updates the submission state", async () => {
      const stored = await getStorage().addMisbehaviourEvidence(await newEvidence());

      await getStorage().updateMisbehaviourEvidence(stored.id, {
        status: MisbehaviourStatus.Confirmed,
        attempts: 1,
        txHash: "ABCDEF",
      });

      const updated = (await getStorage().getMisbehaviourEvidence()).find(e => e.id === stored.id)!;
      expect(updated.status).toBe(MisbehaviourStatus.Confirmed);
      expect(updated.attempts).toBe(1);
      expect(updated.txHash).toBe("ABCDEF");
      expect(updated.error).toBeNull();
      expect(updated.updatedAt).toBeGreaterThanOrEqual(stored.updatedAt);
    });

    it("rejects updates to unknown records", async () => {
      await expect(getStorage().updateMisbehaviourEvidence(987654, {
        attempts: 1,
      })).rejects.toThrow("Misbehaviour evidence not found");
    });
  });

  describe("monitor cursors", () => {
    it("starts at zero", async () => {
      const {
        relayPathId,
      } = await newEvidence();

      expect(await getStorage().getMonitorCursor(relayPathId, "A")).toBe(0);
    });

    it("stores and overwrites a cursor per path side", async () => {
      const {
        relayPathId,
      } = await newEvidence();

      await getStorage().setMonitorCursor(relayPathId, "A", 10);
      await getStorage().setMonitorCursor(relayPathId, "B", 20);
      await getStorage().setMonitorCursor(relayPathId, "A", 15);

      expect(await getStorage().getMonitorCursor(relayPathId, "A")).toBe(15);
      expect(await getStorage().getMonitorCursor(relayPathId, "B")).toBe(20);
    });
  });
}
