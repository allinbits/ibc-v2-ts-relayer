import {
  Relayer,
} from "./relayer";
import {
  ChainType,
} from "./types";
import {
  log,
} from "./utils/logging";

const relayer = new Relayer(log);

const init = async () => {
  await relayer.addNewdRelayPath("chaina", "http://localhost:26657", "chainb", "http://localhost:26658", ChainType.Cosmos, ChainType.Cosmos, 1);
  await relayer.addNewdRelayPath("chaina", "http://localhost:26657", "chainb", "http://localhost:26658", ChainType.Cosmos, ChainType.Cosmos, 2);
  await relayer.init();
  await relayer.start();
};
init();
