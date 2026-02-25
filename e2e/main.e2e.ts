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
    process.env.RELAYER_MNEMONIC || "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "mars");
  await relayer.addMnemonic(
    process.env.RELAYER_MNEMONIC || "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "venus");
  await relayer.addGasPrice("mars", "0.025", "umars");
  await relayer.addGasPrice("venus", "0.025", "uvenus");
  await relayer.addNewRelayPath("mars", "http://localhost:26657", undefined, "venus", "http://localhost:36657", undefined, ChainType.Cosmos, ChainType.Cosmos, 2);
};

const addV1 = async () => {
  await relayer.addNewRelayPath("mars", "http://localhost:26657", undefined, "venus", "http://localhost:36657", undefined, ChainType.Cosmos, ChainType.Cosmos, 1);
};

test("Start relayer and. run E2E tests", async () => {
  await init();
  // Wait for the relayer to initialize and start
  console.log("Relayer initialized and started successfully.");
  const tmClientA = await connectComet("http://localhost:26657");
  const tmClientB = await connectComet("http://localhost:36657");

  const queryA = QueryClient.withExtensions(
    tmClientA, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension, setupIbcV2Extension,
  );
  const queryB = QueryClient.withExtensions(
    tmClientB, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension, setupIbcV2Extension,
  );
  const counterA = await queryA.ibc.clientV2.counterparty("07-tendermint-1");
  expect(counterA).toBeDefined();
  expect(counterA.counterpartyInfo?.clientId).toBe("07-tendermint-1");
  const counterB = await queryB.ibc.clientV2.counterparty("07-tendermint-1");
  expect(counterB).toBeDefined();
  expect(counterB.counterpartyInfo?.clientId).toBe("07-tendermint-1");
  await addV1();

  const counterA_v1 = await queryA.ibc.channel.channel("transfer", "channel-0");
  expect(counterA_v1).toBeDefined();
  expect(counterA_v1.channel?.counterparty.channelId).toBe("channel-0");
  expect(counterA_v1.channel?.counterparty.portId).toBe("transfer");
  const counterB_v1 = await queryB.ibc.channel.channel("transfer", "channel-0");
  expect(counterB_v1).toBeDefined();
  expect(counterB_v1.channel?.counterparty.channelId).toBe("channel-0");
  expect(counterB_v1.channel?.counterparty.portId).toBe("transfer");
}, 120000);
