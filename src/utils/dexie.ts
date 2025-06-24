import Dexie, { type EntityTable } from 'dexie';

import { RelayedHeights, RelayPaths } from '../types';

const db = new Dexie('Relayer') as Dexie & {
    relayPaths: EntityTable<RelayPaths, 'id'>;
    relayedHeights: EntityTable<RelayedHeights, 'id'>;
};

db.version(1).stores({
    relayPaths: '++id, chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientA, clientB, version',
    relayedHeights: '++id, relayPathId, relayHeightA, relayHeightB, ackHeightA, ackHeightB'
});

export { db };