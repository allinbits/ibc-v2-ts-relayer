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
  await relayer.addNewdRelayPath("mars", "http://localhost:26657", "venus", "http://localhost:26658", ChainType.Cosmos, ChainType.Cosmos, 1);
  await relayer.addNewdRelayPath("mars", "http://localhost:26657", "venus", "http://localhost:26658", ChainType.Cosmos, ChainType.Cosmos, 2);
  await relayer.init();
  await relayer.start();
};

test("Start relayer and. run E2E tests", async () => {
  await init();
  console.log("Relayer initialized and started successfully.");
}, 60000);
