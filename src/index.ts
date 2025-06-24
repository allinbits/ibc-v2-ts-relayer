import { Relayer } from "./relayer";
import { ChainType } from "./types";
import { log } from "./utils/logging";

const relayer = new Relayer(log);

const init = async () => {
  await relayer.addExistingRelayPath(
    "chainA",
    "nodeA",
    "chainB",
    "nodeB",
    ChainType.Cosmos, // ChainType.Cosmos
    ChainType.Gno,    // ChainType.Gno
    "clientA",
    "clientB",
    1 // version
  );
  await relayer.start();
};
init();