export enum ChainType {
    Cosmos = "cosmos",
    Ethereum = "ethereum",
    Gno = "gno",
}
export interface RelayPaths {
    id: number;
    chainIdA: string;
    nodeA: string;
    chainIdB: string;
    nodeB: string;
    chainTypeA: ChainType;
    chainTypeB: ChainType;
    clientA: string;
    clientB: string;
    version: number;
}
export interface RelayedHeights {
    id: number;
    relayPathId: number;
    relayHeightA: bigint;
    relayHeightB: bigint;
    ackHeightA: bigint;
    ackHeightB: bigint;
}