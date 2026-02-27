import {
  test,
} from "vitest";

import {
  Relayer,
} from "../src/relayer";
import {
  ChainType,
} from "../src/types";
import {
  log,
} from "../src/utils/logging";

const relayer = new Relayer(log);

const init = async () => {
  await relayer.start();
  await relayer.addMnemonic(
    process.env.RELAYER_MNEMONIC || "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "ibctest-1");
  await relayer.addMnemonic(
    process.env.RELAYER_MNEMONIC || "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "dev");
  await relayer.addGasPrice("ibctest-1", "0.025", "uphoton");
  await relayer.addGasPrice("dev", "0.025", "ugnot");
  await relayer.addNewRelayPath("ibctest-1", "http://localhost:56657", undefined, "dev", "http://localhost:46657", "http://localhost:8546/graphql/query", ChainType.Cosmos, ChainType.Gno, 2);
};

test("Start relayer and. run E2E tests", async () => {
  await init();
  // Wait for the relayer to initialize and start
  console.log("Relayer initialized and started successfully.");
}, 120000);
