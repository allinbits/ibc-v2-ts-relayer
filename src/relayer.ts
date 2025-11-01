import {
  EventEmitter,
} from "node:events";

import {
  GasPrice,
} from "@cosmjs/stargate";
import {
  Entry,
} from "@napi-rs/keyring";
import * as winston from "winston";

import config from "./config/index";
import {
  TendermintIbcClient,
} from "./clients/tendermint/IbcClient";
import {
  Link,
} from "./links/v1/link";
import {
  Link as LinkV2,
} from "./links/v2/link";
import {
  ChainType, RelayedHeights, RelayPaths,
} from "./types";
import {
  getSigner,
} from "./utils/signers";
import {
  addChainFees,
  addRelayPath, getChainFees, getRelayedHeights, getRelayPaths, updateRelayedHeights,
} from "./utils/storage";
import {
  getPrefix,
} from "./utils/utils";

export class Relayer extends EventEmitter {
  private logger: winston.Logger;
  private relayedHeights: Map<number, RelayedHeights> = new Map();
  private relayPaths: RelayPaths[] = [];
  private links = new Map<number, Link | LinkV2>();
  private running: boolean = false;

  constructor(logger: winston.Logger) {
    super();
    this.logger = logger;
    this.on("error", (err) => {
      this.logger.error("Relayer error:", err);
    });
  }

  async getRelayPaths() {
    return getRelayPaths();
  }

  async addNewRelayPath(
    chainIdA: string,
    nodeA: string,
    chainIdB: string,
    nodeB: string,
    chainTypeA: ChainType,
    chainTypeB: ChainType,
    version: number = 1,
  ) {
    const prefixA = await getPrefix(chainTypeA, nodeA);
    const prefixB = await getPrefix(chainTypeB, nodeB);
    const signerA = await getSigner(chainIdA, {
      prefix: prefixA,
    });
    const signerB = await getSigner(chainIdB, {
      prefix: prefixB,
    });
    const feesA = await getChainFees(chainIdA);
    const feesB = await getChainFees(chainIdB);
    const clientA = await TendermintIbcClient.connectWithSigner(nodeA, signerA, {
      senderAddress: (await signerA.getAccounts())[0].address,
      logger: this.logger,
      gasPrice: GasPrice.fromString(feesA.gasPrice + feesA.gasDenom),
    });
    const clientB = await TendermintIbcClient.connectWithSigner(nodeB, signerB, {
      senderAddress: (await signerB.getAccounts())[0].address,
      logger: this.logger,
      gasPrice: GasPrice.fromString(feesB.gasPrice + feesB.gasDenom),
    });
    if (version === 1) {
      const link = await Link.createWithNewConnections(
        clientA, clientB, this.logger);

      const path = await addRelayPath(
        chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, link.endA.connectionID ?? link.endA.clientID, link.endB.connectionID ?? link.endB.clientID, version,
      );
      this.relayPaths = await getRelayPaths();

      if (path) {
        this.links.set(path.id, link);
        this.logger.info(`Added new relay path: ${path.chainIdA} (${path.chainTypeA}) <-> ${path.chainIdB} (${path.chainTypeB})`);
      }
      await link.createChannel(
        "A", "transfer", "transfer", 1, "ics20-1",
      );
    }
    else {
      const link = await LinkV2.createWithNewClientsV2(
        clientA, clientB, this.logger);

      const path = await addRelayPath(
        chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, link.endA.connectionID ?? link.endA.clientID, link.endB.connectionID ?? link.endB.clientID, version,
      );
      // this.relayPaths = await getRelayPaths();

      if (path) {
        // this.links.set(path.id, link);
        this.logger.info(`Added new relay path: ${path.chainIdA} (${path.chainTypeA}) <-> ${path.chainIdB} (${path.chainTypeB})`);
      }
    }
  }

  async addMnemonic(
    mnemonic: string,
    chainId: string,
  ) {
    const entry = new Entry("mnemonic", chainId);
    entry.setPassword(mnemonic);
    this.logger.info(`Mnemonic added for chain ID: ${chainId}`);
  }

  async addGasPrice(
    chainId: string,
    gasPrice: string,
    gasDenom: string,
  ) {
    await addChainFees(chainId, parseFloat(gasPrice), gasDenom);
    this.logger.info(`Gas price added for chain ID: ${chainId}, Price: ${gasPrice}, Denom: ${gasDenom}`);
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
    version: number = 1,
  ) {
    await addRelayPath(
      chainIdA, nodeA, chainIdB, nodeB, chainTypeA, chainTypeB, clientIdA, clientIdB, version,
    );
  }

  async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async init() {
    try {
      this.relayPaths = await getRelayPaths();
      if (this.relayPaths.length === 0) {
        this.logger.info("No relay paths found. Please add a relay path to start relaying messages.");
        return;
      }
      else {
        this.logger.info(`Found ${this.relayPaths.length} relay paths.`);
        for (let i = 0; i < this.relayPaths.length; i++) {
          if (this.links.has(this.relayPaths[i].id)) {
            continue;
          }
          const path = this.relayPaths[i];
          this.logger.info(`Relay Path: ${path.chainIdA} (${path.chainTypeA}) <-> ${path.chainIdB} (${path.chainTypeB})`);
          this.relayedHeights = new Map<number, RelayedHeights>();
          let relayedHeights = await getRelayedHeights(path.id);
          if (!relayedHeights) {
            await updateRelayedHeights(path.id, 0, 0, 0, 0);
            relayedHeights = {
              id: 0,
              relayPathId: path.id,
              packetHeightA: 0,
              packetHeightB: 0,
              ackHeightA: 0,
              ackHeightB: 0,
            };
            this.logger.info(`No relayed heights found for path ${path.id}. Initializing to zero.`);
          }
          this.relayedHeights.set(path.id, relayedHeights);
          const prefixA = await getPrefix(path.chainTypeA, path.nodeA);
          const prefixB = await getPrefix(path.chainTypeB, path.nodeB);
          const signerA = await getSigner(path.chainIdA, {
            prefix: prefixA,
          });
          const signerB = await getSigner(path.chainIdB, {
            prefix: prefixB,
          });
          const feesA = await getChainFees(path.chainIdA);
          const feesB = await getChainFees(path.chainIdB);
          const clientA = await TendermintIbcClient.connectWithSigner(path.nodeA, signerA, {
            senderAddress: (await signerA.getAccounts())[0].address,
            logger: this.logger,
            gasPrice: GasPrice.fromString(feesA.gasPrice + feesA.gasDenom),
          });
          const clientB = await TendermintIbcClient.connectWithSigner(path.nodeB, signerB, {
            senderAddress: (await signerB.getAccounts())[0].address,
            logger: this.logger,
            gasPrice: GasPrice.fromString(feesB.gasPrice + feesB.gasDenom),
          });
          if (path.version === 1) {
            this.links.set(path.id, await Link.createWithExistingConnections(clientA, clientB, path.clientA, path.clientB, this.logger));
          }
          else {
            this.links.set(path.id, await LinkV2.createWithExistingClients(clientA, clientB, path.clientA, path.clientB, this.logger));
          }
        };
      }
    }
    catch (error) {
      this.logger.error("Failed to get relay paths:", error);
    }
  }

  async start() {
    this.running = true;
    this.logger.info("Starting relayer...");
    await this.init();
    this.relayerLoop();
  }

  async stop() {
    this.running = false;
    this.logger.info("Stopping relayer...");

    // Clean up resources
    for (const [id, link] of this.links.entries()) {
      try {
        // Disconnect Tendermint clients if they have tm property
        const clientA = link.endA.client as any;
        const clientB = link.endB.client as any;

        if (clientA.tm && typeof clientA.tm.disconnect === "function") {
          clientA.tm.disconnect();
        }
        if (clientB.tm && typeof clientB.tm.disconnect === "function") {
          clientB.tm.disconnect();
        }
        this.logger.debug(`Cleaned up resources for relay path ${id}`);
      }
      catch (error) {
        this.logger.warn(`Error cleaning up relay path ${id}:`, error);
      }
    }

    // Clear the links map
    this.links.clear();
    this.relayedHeights.clear();

    this.logger.info("Relayer stopped and resources cleaned up");
  }

  async relayerLoop(options = {
    poll: config.relay.pollInterval,
    maxAgeDest: config.relay.maxAgeDest,
    maxAgeSrc: config.relay.maxAgeSrc,
  }) {
    while (this.running) {
      try {
        for (const [id, link] of this.links.entries()) {
          this.logger.info(`Checking relay path ${id}...`);
          if (!this.relayedHeights) {
            this.relayedHeights = new Map<number, RelayedHeights>();
          }

          let relayedHeights = await getRelayedHeights(id);
          if (!relayedHeights) {
            await updateRelayedHeights(id, 0, 0, 0, 0);
            relayedHeights = {
              id: 0,
              relayPathId: id,
              packetHeightA: 0,
              packetHeightB: 0,
              ackHeightA: 0,
              ackHeightB: 0,
            };
            this.logger.info(`No relayed heights found for path ${id}. Initializing to zero.`);
          }
          this.relayedHeights.set(id, relayedHeights);
          let relayHeights = this.relayedHeights.get(id);
          if (relayHeights) {
            relayHeights = {
              ...relayHeights,
              ...await link.checkAndRelayPacketsAndAcks(
                relayHeights,
                config.relay.timeoutBlocks,
                config.relay.timeoutSeconds,
              ),
            };
            this.relayedHeights.set(id, relayHeights);
            updateRelayedHeights(id, relayHeights.packetHeightA, relayHeights.packetHeightB, relayHeights.ackHeightA, relayHeights.ackHeightB);
            this.logger.info(`Updated relay heights for path ${id}:`, relayHeights);
          }
          await link.updateClientIfStale("A", options.maxAgeDest);
          await link.updateClientIfStale("B", options.maxAgeSrc);
        }
      }
      catch (error) {
        this.logger.error("Relayer loop error:", error);
        this.emit("error", error);
      }
      await this.sleep(options.poll);
    }
  }

  relayMessage(message?: string) {
    // Placeholder for relaying a message
    this.emit("messageRelayed", message);
  }
}
