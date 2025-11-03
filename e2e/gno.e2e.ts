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
    "memory margin pact lesson jacket claw illness ivory swamp permit push antique expose vendor ozone plate wreck danger craft hover refuse word roast orbit",
    "ibctest-1");
  await relayer.addMnemonic(
    "memory margin pact lesson jacket claw illness ivory swamp permit push antique expose vendor ozone plate wreck danger craft hover refuse word roast orbit",
    "dev");
  await relayer.addGasPrice("ibctest-1", "0.025", "uphoton");
  await relayer.addGasPrice("dev", "0.025", "ugnot");
  await relayer.addNewRelayPath("ibctest-1", "http://localhost:26658", "dev", "http://localhost:26657", ChainType.Cosmos, ChainType.Gno, 2);
};

test("Start relayer and. run E2E tests", async () => {
  await init();
  // Wait for the relayer to initialize and start
  console.log("Relayer initialized and started successfully.");
}, 120000);
