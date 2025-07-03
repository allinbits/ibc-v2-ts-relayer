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
    private running: boolean = false;
    
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

    async sleep(ms:number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async init() {
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
                        await updateRelayedHeights(path.id, 0, 0, 0, 0);
                        relayedHeights = {
                            id: 0,
                            relayPathId: path.id,
                            relayHeightA: 0,
                            relayHeightB: 0,
                            ackHeightA: 0,
                            ackHeightB: 0
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
    async start() {
        this.running = true;
        this.logger.info("Starting relayer...");
        this.relayerLoop();
    }
    async stop() {
        this.running = false;
        this.logger.info("Stopping relayer...");
    }
    async relayerLoop(options = { poll: 5000, maxAgeDest: 86400, maxAgeSrc: 86400 }) {
        while (this.running) {
            try {
                for (const [id, link] of this.links.entries()) {
                    this.logger.info(`Checking relay path ${id}...`);
                    let relayHeights = this.relayedHeights.get(id);
                    if (relayHeights) {
                        relayHeights = { ...relayHeights, ...await link.checkAndRelayPacketsAndAcks(
                            relayHeights,
                        2,
                        6)};
                        this.relayedHeights.set(id, relayHeights);
                        updateRelayedHeights(id, relayHeights.relayHeightA, relayHeights.relayHeightB, relayHeights.ackHeightA, relayHeights.ackHeightB);
                        this.logger.info(`Updated relay heights for path ${id}:`, relayHeights);
                    }
                    await link.updateClientIfStale("A", options.maxAgeDest);
                    await link.updateClientIfStale("B", options.maxAgeSrc);
                }
            } catch (e) {
                console.error(`Caught error: `, e);
            }
            await this.sleep(options.poll);
        }
    }

    relayMessage(message?: string) {
        // Placeholder for relaying a message
        console.log("Relaying message:", message);
        this.emit("messageRelayed", message);
    }
}