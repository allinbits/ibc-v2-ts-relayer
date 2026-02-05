import {
  EventEmitter,
} from "node:events";

import {
  OfflineSigner,
} from "@cosmjs/proto-signing";
import {
  GasPrice,
} from "@cosmjs/stargate";
import {
  GnoWallet,
} from "@gnolang/gno-js-client";
import {
  Entry,
} from "@napi-rs/keyring";
import * as winston from "winston";

import {
  GnoIbcClient,
} from "./clients/gno/IbcClient.js";
import {
  TendermintIbcClient,
} from "./clients/tendermint/IbcClient.js";
import config from "./config/index.js";
import {
  Link,
} from "./links/v1/link.js";
import {
  Link as LinkV2,
} from "./links/v2/link.js";
import {
  ChainType, RelayedHeights, RelayPaths,
} from "./types/index.js";
import {
  getSigner,
} from "./utils/signers.js";
import {
  storage,
} from "./utils/storage.js";
import {
  getPrefix,
} from "./utils/utils.js";

async function getSenderAddress(signer: OfflineSigner, chainId: string): Promise<string> {
  const accounts = await signer.getAccounts();
  if (accounts.length === 0) {
    throw new Error(`No accounts found for chain ${chainId}`);
  }
  return accounts[0].address;
}

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
    return storage.getRelayPaths();
  }

  async addNewRelayPath(
    chainIdA: string,
    nodeA: string,
    queryNodeA: string | undefined,
    chainIdB: string,
    nodeB: string,
    queryNodeB: string | undefined,
    chainTypeA: ChainType,
    chainTypeB: ChainType,
    version: number = 1,
  ) {
    const prefixA = await getPrefix(chainTypeA, nodeA);
    const prefixB = await getPrefix(chainTypeB, nodeB);
    const signerA = await getSigner(chainIdA, chainTypeA, {
      prefix: prefixA,
    });
    const signerB = await getSigner(chainIdB, chainTypeB, {
      prefix: prefixB,
    });
    const feesA = await storage.getChainFees(chainIdA);
    const feesB = await storage.getChainFees(chainIdB);

    const clientA = chainTypeA === ChainType.Cosmos
      ? await TendermintIbcClient.connectWithSigner(nodeA, signerA as OfflineSigner, {
        senderAddress: await getSenderAddress(signerA as OfflineSigner, chainIdA),
        logger: this.logger,
        gasPrice: GasPrice.fromString(feesA.gasPrice + feesA.gasDenom),
        estimatedBlockTime: 6000,
      })
      : await GnoIbcClient.connectWithSigner(nodeA, queryNodeA, signerA as GnoWallet, {
        senderAddress: (await (signerA as GnoWallet).getAddress()),
        logger: this.logger,
        gasPrice: GasPrice.fromString(feesA.gasPrice + feesA.gasDenom),
        addressPrefix: prefixA,
        estimatedBlockTime: 6000,
      });
    const clientB = chainTypeB === ChainType.Cosmos
      ? await TendermintIbcClient.connectWithSigner(nodeB, signerB as OfflineSigner, {
        senderAddress: await getSenderAddress(signerB as OfflineSigner, chainIdB),
        logger: this.logger,
        gasPrice: GasPrice.fromString(feesB.gasPrice + feesB.gasDenom),
        estimatedBlockTime: 6000,
      })
      : await GnoIbcClient.connectWithSigner(nodeB, queryNodeB, signerB as GnoWallet, {
        senderAddress: (await (signerB as GnoWallet).getAddress()),
        logger: this.logger,
        gasPrice: GasPrice.fromString(feesB.gasPrice + feesB.gasDenom),
        addressPrefix: prefixB,
        estimatedBlockTime: 6000,
      });
    if (version === 1) {
      const link = await Link.createWithNewConnections(
        clientA, clientB, this.logger);

      const path = await storage.addRelayPath(
        chainIdA, nodeA, queryNodeA, chainIdB, nodeB, queryNodeB, chainTypeA, chainTypeB, link.endA.connectionID ?? link.endA.clientID, link.endB.connectionID ?? link.endB.clientID, version,
      );
      this.relayPaths = await storage.getRelayPaths();

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

      const path = await storage.addRelayPath(
        chainIdA, nodeA, queryNodeA, chainIdB, nodeB, queryNodeB, chainTypeA, chainTypeB, link.endA.connectionID ?? link.endA.clientID, link.endB.connectionID ?? link.endB.clientID, version,
      );
      this.relayPaths = await storage.getRelayPaths();

      if (path) {
        this.links.set(path.id, link);
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
    const price = parseFloat(gasPrice);
    if (Number.isNaN(price)) {
      throw new Error(`Invalid gas price: ${gasPrice}`);
    }
    await storage.addChainFees(chainId, price, gasDenom);
    this.logger.info(`Gas price added for chain ID: ${chainId}, Price: ${gasPrice}, Denom: ${gasDenom}`);
  }

  async addExistingRelayPath(
    chainIdA: string,
    nodeA: string,
    queryNodeA: string | undefined,
    chainIdB: string,
    nodeB: string,
    queryNodeB: string | undefined,
    chainTypeA: ChainType,
    chainTypeB: ChainType,
    clientIdA: string,
    clientIdB: string,
    version: number = 1,
  ) {
    await storage.addRelayPath(
      chainIdA, nodeA, queryNodeA, chainIdB, nodeB, queryNodeB, chainTypeA, chainTypeB, clientIdA, clientIdB, version,
    );
  }

  async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async init() {
    try {
      this.relayPaths = await storage.getRelayPaths();
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
          let relayedHeights = await storage.getRelayedHeights(path.id);
          if (!relayedHeights) {
            await storage.updateRelayedHeights(path.id, 0, 0, 0, 0);
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
          const signerA = await getSigner(path.chainIdA, path.chainTypeA, {
            prefix: prefixA,
          });
          const signerB = await getSigner(path.chainIdB, path.chainTypeB, {
            prefix: prefixB,
          });
          const feesA = await storage.getChainFees(path.chainIdA);
          const feesB = await storage.getChainFees(path.chainIdB);
          this.logger.info(`Using signer for chain ${path.chainIdA} with prefix ${prefixA}`);
          this.logger.info(`Using signer for chain ${path.chainIdB} with prefix ${prefixB}`);

          const clientA = path.chainTypeA === ChainType.Cosmos
            ? await TendermintIbcClient.connectWithSigner(path.nodeA, signerA as OfflineSigner, {
              senderAddress: await getSenderAddress(signerA as OfflineSigner, path.chainIdA),
              logger: this.logger,
              gasPrice: GasPrice.fromString(feesA.gasPrice + feesA.gasDenom),
            })
            : await GnoIbcClient.connectWithSigner(path.nodeA, path.queryNodeA, signerA as GnoWallet, {
              senderAddress: (await (signerA as GnoWallet).getAddress()),
              addressPrefix: prefixA,
              logger: this.logger,
              gasPrice: GasPrice.fromString(feesA.gasPrice + feesA.gasDenom),
            });
          const clientB = path.chainTypeB === ChainType.Cosmos
            ? await TendermintIbcClient.connectWithSigner(path.nodeB, signerB as OfflineSigner, {
              senderAddress: await getSenderAddress(signerB as OfflineSigner, path.chainIdB),
              logger: this.logger,
              gasPrice: GasPrice.fromString(feesB.gasPrice + feesB.gasDenom),
            })
            : await GnoIbcClient.connectWithSigner(path.nodeB, path.queryNodeB, signerB as GnoWallet, {
              senderAddress: (await (signerB as GnoWallet).getAddress()),
              addressPrefix: prefixB,
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
    this.relayerLoop();
  }

  async stop() {
    this.running = false;
    this.logger.info("Stopping relayer...");
  }

  async relayerLoop(options = {
    poll: config.relay.pollInterval,
    maxAgeDest: config.relay.maxAgeDest,
    maxAgeSrc: config.relay.maxAgeSrc,
  }) {
    while (this.running) {
      try {
        await this.init();
        for (const [id, link] of this.links.entries()) {
          this.logger.info(`Checking relay path ${id}...`);
          if (!this.relayedHeights) {
            this.relayedHeights = new Map<number, RelayedHeights>();
          }

          let relayedHeights = await storage.getRelayedHeights(id);
          if (!relayedHeights) {
            await storage.updateRelayedHeights(id, 0, 0, 0, 0);
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
                relayHeights, config.relay.timeoutBlocks, config.relay.timeoutSeconds),
            };
            this.relayedHeights.set(id, relayHeights);
            await storage.updateRelayedHeights(id, relayHeights.packetHeightA, relayHeights.packetHeightB, relayHeights.ackHeightA, relayHeights.ackHeightB);
            this.logger.info(`Updated relay heights for path ${id}:`, relayHeights);
          }
          await link.updateClientIfStale("A", options.maxAgeDest);
          await link.updateClientIfStale("B", options.maxAgeSrc);
        }
      }
      catch (e) {
        this.logger.error("Error in relayer loop", {
          error: e,
        });
      }
      await this.sleep(options.poll);
    }
  }

  relayMessage(message?: string) {
    // Placeholder for relaying a message
    this.emit("messageRelayed", message);
  }
}
