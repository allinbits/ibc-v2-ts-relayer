import Dexie, {
  type EntityTable,
} from "dexie";

import {
  ChainFees,
  MisbehaviourEvidence,
  MonitorCursor,
  RelayedHeights, RelayPaths,
} from "../types/index.js";

const db = new Dexie("Relayer") as Dexie & {
  relayPaths: EntityTable<RelayPaths, "id">
  relayedHeights: EntityTable<RelayedHeights, "id">
  chainFees: EntityTable<ChainFees, "id">
  misbehaviourEvidence: EntityTable<MisbehaviourEvidence, "id">
  monitorCursors: EntityTable<MonitorCursor, "id">
};

db.version(3).stores({
  relayPaths: "++id, chainIdA, nodeA, queryNodeA, chainIdB, nodeB, queryNodeB, chainTypeA, chainTypeB, clientA, clientB, version, [chainIdA+chainIdB+clientA+clientB+version]",
  relayedHeights: "++id, relayPathId, packetHeightA, packetHeightB, ackHeightA, ackHeightB",
  chainFees: "++id, chainId, gasPrice, gasDenom, gasAdjustment",
});

db.version(4).stores({
  misbehaviourEvidence: "++id, status, &[hostChainId+clientId+revisionNumber+revisionHeight]",
  monitorCursors: "++id, &[relayPathId+side]",
});

export {
  db,
};
