import {
  Bip39,
  Random,
} from "@cosmjs/crypto";
import {
  DirectSecp256k1HdWallet,
} from "@cosmjs/proto-signing";
import {
  GasPrice,
} from "@cosmjs/stargate";
import {
  GnoWallet,
} from "@gnolang/gno-js-client";
import * as winston from "winston";

import {
  BaseIbcClient, isTendermint,
} from "../clients/BaseIbcClient.js";
import {
  GnoIbcClient,
} from "../clients/gno/IbcClient.js";
import {
  TendermintIbcClient,
} from "../clients/tendermint/IbcClient.js";
import {
  ChainType,
} from "../types/index.js";
import {
  getPrefix,
} from "../utils/utils.js";

// Never used to pay for anything: query clients do not sign.
const QUERY_ONLY_GAS_PRICE = GasPrice.fromString("0uquery");

/**
 * Connects a client for queries only. The chain clients require a signer, so
 * this uses a random in-memory wallet that is never funded or used to sign.
 */
export async function connectQueryClient(
  chainType: ChainType,
  node: string,
  queryNode: string | undefined,
  logger: winston.Logger,
): Promise<BaseIbcClient> {
  const mnemonic = Bip39.encode(Random.getBytes(16)).toString();
  if (chainType === ChainType.Cosmos) {
    const signer = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: await getPrefix(chainType, node),
    });
    const [account] = await signer.getAccounts();
    return TendermintIbcClient.connectWithSigner(node, signer, {
      senderAddress: account.address,
      logger,
      gasPrice: QUERY_ONLY_GAS_PRICE,
    });
  }
  if (chainType === ChainType.Gno) {
    if (!queryNode) {
      throw new Error(`Gno chain at ${node} needs a query node (tx-indexer) URL`);
    }
    const signer = await GnoWallet.fromMnemonic(mnemonic, {
      addressPrefix: "g",
    });
    return GnoIbcClient.connectWithSigner(node, queryNode, signer, {
      senderAddress: await signer.getAddress(),
      addressPrefix: "g",
      logger,
      gasPrice: QUERY_ONLY_GAS_PRICE,
    });
  }
  throw new Error(`Unsupported chain type: ${chainType}`);
}

/**
 * Relay paths store connection IDs for IBC v1 and client IDs for IBC v2.
 *
 * @param host - The chain the client or connection lives on
 * @param storedId - The ID stored in the relay path
 * @param version - The relay path's IBC version
 * @returns The light client ID on `host`
 */
export async function resolveClientId(host: BaseIbcClient, storedId: string, version: number): Promise<string> {
  if (version !== 1) {
    return storedId;
  }
  if (!isTendermint(host)) {
    throw new Error(`IBC v1 paths are only supported on Cosmos chains (${host.chainId})`);
  }
  const {
    connection,
  } = await host.query.ibc.connection.connection(storedId);
  if (!connection) {
    throw new Error(`Connection ${storedId} not found on ${host.chainId}`);
  }
  return connection.clientId;
}
