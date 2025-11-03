/**
 * Basic Relayer Setup Example
 *
 * This example demonstrates how to set up a basic IBC relayer
 * that monitors and relays packets between two Cosmos chains.
 *
 * Prerequisites:
 * - Two running Cosmos chains with RPC endpoints
 * - Mnemonics stored in system keyring for both chains
 * - Gas prices configured for both chains
 */

import { Relayer } from "../src/relayer";
import { log } from "../src/utils/logging";
import { ChainType } from "../src/types";

async function main() {
  // Initialize relayer with logger
  const relayer = new Relayer(log);

  // Add mnemonic for chain A (stored securely in system keyring)
  await relayer.addMnemonic(
    "your mnemonic words here...",
    "cosmoshub-4",
  );

  // Add mnemonic for chain B
  await relayer.addMnemonic(
    "your mnemonic words here...",
    "osmosis-1",
  );

  // Configure gas prices for chain A
  await relayer.addGasPrice(
    "cosmoshub-4",
    "0.025",  // Gas price
    "uatom",  // Gas denom
  );

  // Configure gas prices for chain B
  await relayer.addGasPrice(
    "osmosis-1",
    "0.025",
    "uosmo",
  );

  // Add a new relay path (IBC v1) between two chains
  // This will:
  // 1. Create clients on both sides
  // 2. Perform connection handshake
  // 3. Create transfer channels
  await relayer.addNewRelayPath(
    "cosmoshub-4",                    // Chain A ID
    "https://rpc.cosmos.network",     // Chain A RPC
    "osmosis-1",                      // Chain B ID
    "https://rpc.osmosis.zone",       // Chain B RPC
    ChainType.Cosmos,                 // Chain A type
    ChainType.Cosmos,                 // Chain B type
    1,                                // IBC version (1 or 2)
  );

  // Start the relayer loop
  // This will:
  // - Poll for new packets every 5 seconds (configurable)
  // - Relay packets bidirectionally
  // - Relay acknowledgements
  // - Handle timeouts
  // - Update clients when stale
  await relayer.start();

  // Graceful shutdown handler
  process.on("SIGINT", async () => {
    console.log("\nShutting down relayer...");
    await relayer.stop();
    process.exit(0);
  });

  // Keep the process running
  console.log("Relayer started successfully!");
  console.log("Press Ctrl+C to stop");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
