import {
  createHash,
} from "node:crypto";

import {
  Payload,
} from "@atomone/cosmos-ibc-types/ibc/core/channel/v2/packet.js";
import {
  MsgSendPacket,
} from "@atomone/cosmos-ibc-types/ibc/core/channel/v2/tx.js";
import {
  FungibleTokenPacketData,
} from "@clockworkgr/ibc-v2-client-ts/lib/ibc.applications.transfer.v1/types/ibc/applications/transfer/v1/packet.js";
import {
  DirectSecp256k1HdWallet,
  GeneratedType,
  OfflineSigner,
  Registry,
} from "@cosmjs/proto-signing";
import {
  defaultRegistryTypes,
  GasPrice,
  QueryClient,
  setupAuthExtension,
  setupBankExtension,
  setupIbcExtension,
  setupStakingExtension,
  SigningStargateClient,
} from "@cosmjs/stargate";
import {
  connectComet,
} from "@cosmjs/tendermint-rpc";
import {
  GnoJSONRPCProvider,
  GnoWallet,
} from "@gnolang/gno-js-client";
import {
  TransactionEndpoint,
} from "@gnolang/tm2-js-client";
import {
  connectTm2,
} from "@gnolang/tm2-rpc";
import {
  describe,
  expect,
  test,
} from "vitest";

import {
  ChainFees,
} from "../src/types/index.ts";
import {
  setupIbcV2Extension,
} from "../src/v2queries/ibc.ts";
import {
  setupGnoWhitelist,
} from "./setup.ts";

function ibcRegistry(): Registry {
  return new Registry([...defaultRegistryTypes, ["/ibc.core.channel.v2.MsgSendPacket", MsgSendPacket as GeneratedType]]);
}

// Mirrors the voucher denom derivation of the gno-realms transfer app
// (gno.land/r/aib/ibc/apps/transfer, denom.gno) which follows ICS20 v2:
// the receiving chain prefixes the trace with (destPort, destClient) and the
// voucher denom is "ibc/" + uppercase hex sha256 of "transfer/<clientID>/<base>".
// ibc-go uses the same derivation on the cosmos side.
function ibcVoucherDenom(destClientId: string, baseDenom: string): string {
  const hash = createHash("sha256").update(`transfer/${destClientId}/${baseDenom}`).digest("hex").toUpperCase();
  return `ibc/${hash}`;
}

export const transferFromGnoGRC = async (clientId: string, _sender: string, receiver: string, amount: string, denom: string, memo: string, mnem: string, url: string) => {
  const prefix = "g";

  const provider = await GnoJSONRPCProvider.create(url);
  const wallet = await GnoWallet.fromMnemonic(mnem, {
    addressPrefix: prefix || "g",
  });
  wallet.connect(provider);
  const result = await wallet.callMethod("gno.land/r/aib/ibc/apps/transfer", "Transfer", [clientId, receiver, denom, amount, BigInt(Math.floor(Date.now() / 1000) + 600).toString(), ""], TransactionEndpoint.BROADCAST_TX_COMMIT, (new Map()), (new Map()).set("ugnot", 3000000),
    {
      gas_wanted: 80000000n,
      gas_fee: "1000000ugnot",
    });
  return result;
};
export const transferFromGno = async (clientId: string, _sender: string, receiver: string, amount: string, denom: string, memo: string, mnem: string, url: string) => {
  const prefix = "g";

  const provider = await GnoJSONRPCProvider.create(url);
  const wallet = await GnoWallet.fromMnemonic(mnem, {
    addressPrefix: prefix || "g",
  });
  wallet.connect(provider);
  const result = await wallet.callMethod("gno.land/r/aib/ibc/apps/transfer", "Transfer", [clientId, receiver, denom, amount, BigInt(Math.floor(Date.now() / 1000) + 600).toString(), ""], TransactionEndpoint.BROADCAST_TX_COMMIT, (new Map()).set(denom, amount), (new Map()).set("ugnot", 3000000),
    {
      gas_wanted: 80000000n,
      gas_fee: "1000000ugnot",
    });
  return result;
};
export const transferFromTm = async (clientId: string, sender: string, receiver: string, amount: string, denom: string, memo: string, url: string, prefix: string, chain_id: string, chainFee: ChainFees) => {
  const packetData = FungibleTokenPacketData.encode(({
    amount,
    denom,
    sender,
    receiver,
    memo,
  } as FungibleTokenPacketData)).finish();

  const payload = Payload.fromPartial({
    sourcePort: "transfer",
    destinationPort: "transfer",
    version: "ics20-1",
    encoding: "application/x-protobuf", // can also be "application/json" or "application/x-solidity-abi"
    value: packetData, // the byte[] above
  });

  const msg = MsgSendPacket.fromPartial({
    sourceClient: clientId, // e.g. "07-tendermint-1"
    signer: sender,
    payloads: [payload], // an array of payloads such as the one above
    timeoutTimestamp: BigInt(Math.floor(Date.now() / 1000) + 600), // in SECONDS
  });
  const prefixA = prefix;
  const signerA = await DirectSecp256k1HdWallet.fromMnemonic(process.env.RELAYER_MNEMONIC || "", {
    prefix: prefixA,
  });
  const feesA = chainFee;

  const clientA = await SigningStargateClient.connectWithSigner(url, signerA as OfflineSigner, {
    gasPrice: GasPrice.fromString(feesA.gasPrice + feesA.gasDenom),
    registry: ibcRegistry(),
  });
  const result = await clientA.signAndBroadcast((await (signerA as OfflineSigner).getAccounts())[0].address, [
    {
      typeUrl: "/ibc.core.channel.v2.MsgSendPacket",
      value: msg,
    },
  ], "auto");
  return result;
};
describe("IBC Transfer Tests", async () => {
  setupGnoWhitelist();

  const _marsClient = await connectComet("http://localhost:26657");
  const venusClient = await connectComet("http://localhost:36657");
  const atoneClient = await connectComet("http://localhost:56657");
  const devClient = await connectTm2("http://localhost:46657");

  const venusQuery = QueryClient.withExtensions(venusClient, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension);
  const atoneQuery = QueryClient.withExtensions(atoneClient, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension, setupIbcV2Extension);

  // Discover the atone<->gno client pair instead of hardcoding IDs: the
  // relayer under test relays the most recently created "10-gno-N" client on
  // atone, and its registered v2 counterparty is the tendermint client on gno.
  const gnoClientsOnAtone = (await atoneQuery.ibc.client.allStates())
    .clientStates
    .map(cs => cs.clientId)
    .filter(id => /^10-gno-\d+$/.test(id))
    .sort((a, b) => Number(a.split("-")[2]) - Number(b.split("-")[2]));
  if (gnoClientsOnAtone.length === 0) {
    throw new Error("no 10-gno client found on atone - has the relay path been set up?");
  }
  const atoneGnoClient = gnoClientsOnAtone[gnoClientsOnAtone.length - 1];
  const gnoAtoneClient = (await atoneQuery.ibc.clientV2.counterparty(atoneGnoClient)).counterpartyInfo?.clientId;
  if (!gnoAtoneClient) {
    throw new Error(`no counterparty registered for ${atoneGnoClient} on atone`);
  }
  console.log(`Using client pair: atone ${atoneGnoClient} <-> gno ${gnoAtoneClient}`);

  // Voucher denoms as derived by the receiving chain (see ibcVoucherDenom).
  const atoneVoucherOnGno = ibcVoucherDenom(gnoAtoneClient, "uatone");
  const gnotVoucherOnAtone = ibcVoucherDenom(atoneGnoClient, "ugnot");

  test("Run mars -> venus", async () => {
    await transferFromTm("07-tendermint-2", "mars1z437dpuh5s4p64vtq09dulg6jzxpr2hdmpzeqe", "venus1z437dpuh5s4p64vtq09dulg6jzxpr2hdkj7exr", "10", "umars", "test transfer", "http://localhost:26657", "mars", "mars", {
      chainId: "mars",
      gasDenom: "umars",
      gasPrice: 0,
      id: 1,
      gasAdjustment: 1,
    });

    await expect.poll(() => venusQuery.bank.balance("venus1z437dpuh5s4p64vtq09dulg6jzxpr2hdkj7exr", "ibc/6A1C01F79DAE527D8ACF970FE0BE370CB6F7988E7BFA736291710B5EACD5DCCE"), {
      timeout: 20000,
      interval: 5000,
    }).toEqual({
      denom: "ibc/6A1C01F79DAE527D8ACF970FE0BE370CB6F7988E7BFA736291710B5EACD5DCCE",
      amount: "10",
    });
  }, 45000);

  test("Run venus -> mars return", async () => {
    await transferFromTm("07-tendermint-2", "venus1z437dpuh5s4p64vtq09dulg6jzxpr2hdkj7exr", "mars1z437dpuh5s4p64vtq09dulg6jzxpr2hdmpzeqe", "10", "transfer/07-tendermint-2/umars", "test transfer", "http://localhost:36657", "venus", "venus", {
      chainId: "venus",
      gasDenom: "uvenus",
      gasPrice: 0,
      id: 1,
      gasAdjustment: 1,
    });

    await expect.poll(() => venusQuery.bank.balance("venus1z437dpuh5s4p64vtq09dulg6jzxpr2hdkj7exr", "ibc/6A1C01F79DAE527D8ACF970FE0BE370CB6F7988E7BFA736291710B5EACD5DCCE"), {
      timeout: 20000,
      interval: 5000,
    }).toEqual({
      denom: "ibc/6A1C01F79DAE527D8ACF970FE0BE370CB6F7988E7BFA736291710B5EACD5DCCE",
      amount: "0",
    });
  }, 45000);

  test("Run atone -> gno", async () => {
    await transferFromTm(atoneGnoClient, "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x", "10", "uatone", "test transfer", "http://localhost:56657", "atone", "ibctest-1", {
      chainId: "ibctest-1",
      gasDenom: "uphoton",
      gasPrice: 0.025,
      id: 1,
      gasAdjustment: 1,
    });
    await expect.poll(async () =>
      JSON.parse(
        Buffer.from(
          (await devClient.abciQuery({
            path: "vm/qrender",
            data: Buffer.from(`gno.land/r/aib/ibc/apps/transfer:voucher/${atoneVoucherOnGno}/balance/g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x`, "utf-8"),
          })
          ).responseBase.data,
        ).toString("utf-8")), {
      timeout: 30000,
      interval: 3000,
    },
    ).toEqual({
      denom: atoneVoucherOnGno,
      balance: 10,
      address: "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x",
    });

    await expect.poll(() => atoneQuery.bank.balance("atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "uatone"), {
      timeout: 30000,
      interval: 3000,
    }).toEqual({
      denom: "uatone",
      amount: "9999999990",
    });
  }, 60000);

  test("Run gno -> atone return", async () => {
    await transferFromGnoGRC(gnoAtoneClient, "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x", "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "10", atoneVoucherOnGno, "test transfer", process.env.RELAYER_MNEMONIC!, "http://localhost:46657");

    await expect.poll(async () =>
      JSON.parse(
        Buffer.from(
          (await devClient.abciQuery({
            path: "vm/qrender",
            data: Buffer.from(`gno.land/r/aib/ibc/apps/transfer:voucher/${atoneVoucherOnGno}/balance/g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x`, "utf-8"),
          })
          ).responseBase.data,
        ).toString("utf-8")), {
      timeout: 30000,
      interval: 3000,
    },
    ).toEqual({
      denom: atoneVoucherOnGno,
      balance: 0,
      address: "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x",
    });

    await expect.poll(() => atoneQuery.bank.balance("atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "uatone"), {
      timeout: 30000,
      interval: 3000,
    }).toEqual({
      denom: "uatone",
      amount: "10000000000",
    });
  }, 60000);
  test("Run gno -> atone native", async () => {
    await transferFromGno(gnoAtoneClient, "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x", "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "10", "ugnot", "test transfer", process.env.RELAYER_MNEMONIC!, "http://localhost:46657");

    await expect.poll(() => atoneQuery.bank.balance("atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", gnotVoucherOnAtone), {
      timeout: 30000,
      interval: 3000,
    }).toEqual({
      denom: gnotVoucherOnAtone,
      amount: "10",
    });
  }, 60000);

  test("Run atone -> gno native return", async () => {
    await transferFromTm(atoneGnoClient, "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x", "10", `transfer/${atoneGnoClient}/ugnot`, "test transfer", "http://localhost:56657", "atone", "ibctest-1", {
      chainId: "ibctest-1",
      gasDenom: "uphoton",
      gasPrice: 0.025,
      id: 1,
      gasAdjustment: 1,
    });

    await expect.poll(() => atoneQuery.bank.balance("atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", gnotVoucherOnAtone), {
      timeout: 30000,
      interval: 3000,
    }).toEqual({
      denom: gnotVoucherOnAtone,
      amount: "0",
    });
  }, 60000);
});
