import {
  QueryClient, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension,
} from "@cosmjs/stargate";
import {
  connectComet,
} from "@cosmjs/tendermint-rpc";
import {
  connectTm2,
} from "@gnolang/tm2-rpc";
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
} from "../src/v2queries/ibc.ts";

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
  const tmClient = await connectComet("http://localhost:56657");
  const gnoClient = await connectTm2("http://localhost:46657");
  const clientB = await gnoClient.abciQuery({
    path: "vm/qrender",
    data: Buffer.from("gno.land/r/aib/ibc/core:clients/07-tendermint-1", "utf-8"),
  });
  const clientState = JSON.parse(Buffer.from(clientB.responseBase.data).toString("utf-8"));
  console.log("Client State:", clientState);
  
  const queryA = QueryClient.withExtensions(
    tmClient, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension, setupIbcV2Extension,
  );

  const counterA = await queryA.ibc.clientV2.counterparty("07-tendermint-1");
  expect(counterA).toBeDefined();
  expect(counterA.counterpartyInfo?.clientId).toBe("10-gno-0");

  console.log("Relayer initialized and started successfully.");
}, 120000);
