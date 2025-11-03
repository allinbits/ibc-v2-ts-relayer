/**
 * Connection Handshake Example
 *
 * This example demonstrates the IBC connection handshake,
 * which establishes a verified connection between two chains.
 *
 * The connection handshake is a 4-step process:
 * 1. ConnOpenInit - Chain A initiates
 * 2. ConnOpenTry - Chain B responds
 * 3. ConnOpenAck - Chain A acknowledges
 * 4. ConnOpenConfirm - Chain B confirms
 *
 * Prerequisites:
 * - Light clients already created on both chains
 */

import { TendermintIbcClient } from "../src/clients/tendermint/IbcClient";
import { getSigner } from "../src/utils/signers";
import { GasPrice } from "@cosmjs/stargate";
import { log } from "../src/utils/logging";

async function main() {
  // Setup clients (same as create-clients.ts example)
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

  // Assume clients already exist from previous example
  const clientIdOnA = "07-tendermint-0";  // Tracks chain B
  const clientIdOnB = "07-tendermint-1";  // Tracks chain A

  // ========================================
  // Step 1: ConnOpenInit on Chain A
  // ========================================
  console.log("Step 1: Connection Open Init on Chain A");
  const initResult = await clientA.connOpenInit(
    clientIdOnA,      // Local client
    clientIdOnB,      // Remote client
  );
  const connectionIdA = initResult.connectionId;
  console.log(`  ✅ Connection created on A: ${connectionIdA}`);

  // Wait for chain A to finalize the block
  await clientA.waitOneBlock();
  await clientA.waitForIndexer();

  // Update client on B with latest state from A (includes the ConnOpenInit)
  const headerHeightA = await clientB.updateClient(clientIdOnB, clientA);
  console.log(`  Updated client on B to height ${headerHeightA.revisionHeight}`);

  // ========================================
  // Step 2: ConnOpenTry on Chain B
  // ========================================
  console.log("\nStep 2: Connection Open Try on Chain B");

  // Get proof of the connection initialization from chain A
  const proofInit = await clientA.getConnectionHandshakeProof(
    clientIdOnA,
    connectionIdA,
    headerHeightA,
  );

  const tryResult = await clientB.connOpenTry(clientIdOnB, proofInit);
  const connectionIdB = tryResult.connectionId;
  console.log(`  ✅ Connection created on B: ${connectionIdB}`);

  // Wait for chain B to finalize
  await clientB.waitOneBlock();
  await clientB.waitForIndexer();

  // Update client on A with latest state from B
  const headerHeightB = await clientA.updateClient(clientIdOnA, clientB);
  console.log(`  Updated client on A to height ${headerHeightB.revisionHeight}`);

  // ========================================
  // Step 3: ConnOpenAck on Chain A
  // ========================================
  console.log("\nStep 3: Connection Open Ack on Chain A");

  // Get proof of the ConnOpenTry from chain B
  const proofTry = await clientB.getConnectionHandshakeProof(
    clientIdOnB,
    connectionIdB,
    headerHeightB,
  );

  await clientA.connOpenAck(connectionIdA, proofTry);
  console.log(`  ✅ Connection acknowledged on A`);

  // Wait for chain A to finalize
  await clientA.waitOneBlock();
  await clientA.waitForIndexer();

  // Update client on B
  const headerHeightA2 = await clientB.updateClient(clientIdOnB, clientA);

  // ========================================
  // Step 4: ConnOpenConfirm on Chain B
  // ========================================
  console.log("\nStep 4: Connection Open Confirm on Chain B");

  // Get proof of the ConnOpenAck from chain A
  const proofAck = await clientA.getConnectionHandshakeProof(
    clientIdOnA,
    connectionIdA,
    headerHeightA2,
  );

  await clientB.connOpenConfirm(connectionIdB, proofAck);
  console.log(`  ✅ Connection confirmed on B`);

  console.log("\n🎉 Connection handshake complete!");
  console.log(`\nConnection IDs:`);
  console.log(`  Chain A: ${connectionIdA}`);
  console.log(`  Chain B: ${connectionIdB}`);
  console.log(`\nThese connections can now be used to create channels for packet transfer.`);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
