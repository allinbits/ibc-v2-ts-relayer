/**
 * Client Creation Example
 *
 * This example demonstrates how to create IBC light clients
 * on two chains, which is the first step in establishing IBC connectivity.
 *
 * Light clients allow each chain to verify the state of the other chain
 * without running a full node.
 */

import { TendermintIbcClient } from "../src/clients/tendermint/IbcClient";
import { getSigner } from "../src/utils/signers";
import { GasPrice } from "@cosmjs/stargate";
import { log } from "../src/utils/logging";

async function main() {
  // Connect to chain A with a signer
  const signerA = await getSigner("cosmoshub-4", { prefix: "cosmos" });
  const clientA = await TendermintIbcClient.connectWithSigner(
    "https://rpc.cosmos.network",
    signerA,
    {
      senderAddress: (await signerA.getAccounts())[0].address,
      logger: log,
      gasPrice: GasPrice.fromString("0.025uatom"),
    },
  );

  // Connect to chain B with a signer
  const signerB = await getSigner("osmosis-1", { prefix: "osmo" });
  const clientB = await TendermintIbcClient.connectWithSigner(
    "https://rpc.osmosis.zone",
    signerB,
    {
      senderAddress: (await signerB.getAccounts())[0].address,
      logger: log,
      gasPrice: GasPrice.fromString("0.025uosmo"),
    },
  );

  console.log("Connected to both chains!");

  // Build client creation arguments for chain A
  // This queries chain A for:
  // - Latest header
  // - Unbonding period (for trust period calculation)
  // - Chain revision number
  const clientArgsA = await clientA.buildCreateClientArgs();
  console.log("Built client args for chain A");

  // Create a light client on chain B that tracks chain A
  const resultA = await clientB.createTendermintClient(
    clientArgsA.clientState,
    clientArgsA.consensusState,
  );
  console.log(`Created client on chain B: ${resultA.clientId}`);
  console.log(`Transaction hash: ${resultA.transactionHash}`);

  // Build client creation arguments for chain B
  const clientArgsB = await clientB.buildCreateClientArgs();
  console.log("Built client args for chain B");

  // Create a light client on chain A that tracks chain B
  const resultB = await clientA.createTendermintClient(
    clientArgsB.clientState,
    clientArgsB.consensusState,
  );
  console.log(`Created client on chain A: ${resultB.clientId}`);
  console.log(`Transaction hash: ${resultB.transactionHash}`);

  console.log("\n✅ Light clients created successfully!");
  console.log(`\nClient IDs:`);
  console.log(`  Chain A → Chain B: ${resultB.clientId}`);
  console.log(`  Chain B → Chain A: ${resultA.clientId}`);

  // Update client example
  console.log("\n--- Client Update Example ---");

  // Update the client on chain B with latest state from chain A
  const updatedHeight = await clientB.updateClient(resultA.clientId, clientA);
  console.log(`Updated client ${resultA.clientId} to height ${updatedHeight.revisionHeight}`);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
