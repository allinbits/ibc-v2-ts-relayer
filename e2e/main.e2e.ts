import {
  QueryClient, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension,
} from "@cosmjs/stargate";
import {
  connectComet,
} from "@cosmjs/tendermint-rpc";
import {
  expect,
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
import {
  setupIbcV2Extension,
} from "../src/v2queries/ibc";

const relayer = new Relayer(log);

const init = async () => {
  await relayer.start();
  await relayer.addMnemonic(
    "other razor era scene permit morning lend scrub habit beyond mixed icon alcohol fuel news glory alien actual bachelor spell album fitness squeeze energy",
    "mars");
  await relayer.addMnemonic(
    "other razor era scene permit morning lend scrub habit beyond mixed icon alcohol fuel news glory alien actual bachelor spell album fitness squeeze energy",
    "venus");
  await relayer.addGasPrice("mars", "0.025", "udenom");
  await relayer.addGasPrice("venus", "0.025", "udenom");
  await relayer.addNewRelayPath("mars", "http://localhost:26657", "venus", "http://localhost:26658", ChainType.Cosmos, ChainType.Cosmos, 2);
};

const addV1 = async () => {
  await relayer.addNewRelayPath("mars", "http://localhost:26657", "venus", "http://localhost:26658", ChainType.Cosmos, ChainType.Cosmos, 1);
};

test("Start relayer and. run E2E tests", async () => {
  await init();
  // Wait for the relayer to initialize and start
  console.log("Relayer initialized and started successfully.");
  const tmClientA = await connectComet("http://localhost:26657");
  const tmClientB = await connectComet("http://localhost:26658");

  const queryA = QueryClient.withExtensions(
    tmClientA, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension, setupIbcV2Extension,
  );
  const queryB = QueryClient.withExtensions(
    tmClientB, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension, setupIbcV2Extension,
  );
  const counterA = await queryA.ibc.clientV2.counterparty("07-tendermint-0");
  expect(counterA).toBeDefined();
  expect(counterA.counterpartyInfo?.clientId).toBe("07-tendermint-0");
  const counterB = await queryB.ibc.clientV2.counterparty("07-tendermint-0");
  expect(counterB).toBeDefined();
  expect(counterB.counterpartyInfo?.clientId).toBe("07-tendermint-0");
  await addV1();
  const counterA_v1 = await queryA.ibc.channel.channel("transfer", "channel-0");
  expect(counterA_v1).toBeDefined();
  expect(counterA_v1.channel?.counterparty).toBe("channel-0");
  const counterB_v1 = await queryB.ibc.channel.channel("transfer", "channel-0");
  expect(counterB_v1).toBeDefined();
  expect(counterB_v1.channel?.counterparty).toBe("channel-0");
}, 120000);
