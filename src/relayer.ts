import EventEmitter from "node:events";

import winston from "winston";

import { Link } from "./links/v1/link";
import { ChainType, RelayedHeights, RelayPaths } from "./types";
import { addRelayPath, getRelayedHeights, getRelayPaths, updateRelayedHeights } from "./utils/storage";
import { Endpoint } from "./endpoints/v1/endpoint";
import { IbcClient } from "./clients/tendermint/ibcV1client";
import { SigningStargateClient } from "@cosmjs/stargate";
import { getSigner } from "./utils/signers";

export class Relayer extends EventEmitter {
    private logger: winston.Logger;
    private relayedHeights: Map<number, RelayedHeights> = new Map();
    private relayPaths: RelayPaths[] = [];
    private links = new Map<number,Link>();
    
    constructor(logger: winston.Logger) {
        super();
        this.logger = logger;
        this.on("error", (err) => {
            this.logger.error("Relayer error:", err);
        });
    }
    async addExistingRelayPath(
        chainIdA: string,
        nodeA: string,
        chainIdB: string,
        nodeB: string,
        chainTypeA: ChainType,
        chainTypeB: ChainType,
        clientIdA: string,
        clientIdB: string,
        version: number = 1
    ) {
        await addRelayPath(
            chainIdA,
            nodeA,
            chainIdB,
            nodeB,
            chainTypeA,
            chainTypeB,
            clientIdA,
            clientIdB,
            version
        );
        this.relayPaths = await getRelayPaths();
    }

    async start() {
        try {
            this.relayPaths = await getRelayPaths();
            if (this.relayPaths.length === 0) {
                this.logger.info("No relay paths found. Please add a relay path to start relaying messages.");
                return;
            }else{
                this.logger.info(`Found ${this.relayPaths.length} relay paths.`);
                for (let i =0; i < this.relayPaths.length; i++) {
                    const path = this.relayPaths[i];
                    this.logger.info(`Relay Path: ${path.chainIdA} (${path.chainTypeA}) <-> ${path.chainIdB} (${path.chainTypeB})`);
                    this.relayedHeights = new Map<number, RelayedHeights>();
                    let relayedHeights = await getRelayedHeights(path.id);
                    if (!relayedHeights) {
                        await updateRelayedHeights(path.id, 0n, 0n, 0n, 0n);
                        relayedHeights = {
                            id: 0,
                            relayPathId: path.id,
                            relayHeightA: 0n,
                            relayHeightB: 0n,
                            ackHeightA: 0n,
                            ackHeightB: 0n
                        }
                        this.logger.info(`No relayed heights found for path ${path.id}. Initializing to zero.`);
                    }
                    this.relayedHeights.set(path.id, relayedHeights);
                    const signerA = await getSigner(path.chainIdA);
                    const signerB = await getSigner(path.chainIdB);
                    const clientA = await  IbcClient.connectWithSigner(path.nodeA, signerA, (await signerA.getAccounts())[0].address, { logger: this.logger} );
                    const clientB = await  IbcClient.connectWithSigner(path.nodeB, signerB, (await signerB.getAccounts())[0].address, { logger: this.logger} );
                    this.links.set(path.id, await Link.createWithExistingConnections(clientA,clientB,path.clientA, path.clientB,this.logger));
                };
            }

        }catch (error) {
            this.logger.error("Failed to get relay paths:", error);
        }
    }

    stop() {
        // Placeholder for stopping the relayer
        console.log("Relayer stopped");
    }

    relayMessage(message?: string) {
        // Placeholder for relaying a message
        console.log("Relaying message:", message);
        this.emit("messageRelayed", message);
    }
}