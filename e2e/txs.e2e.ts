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
import Long from "long";
import {
  describe,
  expect,
  test,
} from "vitest";

import {
  ChainFees,
} from "../src/types/index.ts";

function ibcRegistry(): Registry {
  return new Registry([...defaultRegistryTypes, ["/ibc.core.channel.v2.MsgSendPacket", MsgSendPacket as GeneratedType]]);
}

export const transferFromGnoGRC = async (clientId: string, _sender: string, receiver: string, amount: string, denom: string, memo: string, mnem: string, url: string) => {
  const prefix = "g";

  const provider = new GnoJSONRPCProvider(url);
  const wallet = await GnoWallet.fromMnemonic(mnem, {
    addressPrefix: prefix || "g",
  });
  wallet.connect(provider);
  const result = await wallet.callMethod("gno.land/r/aib/ibc/apps/transfer", "TransferGRC20", [clientId, receiver, denom, amount, BigInt(Math.floor(Date.now() / 1000) + 600).toString()], TransactionEndpoint.BROADCAST_TX_COMMIT, (new Map()), (new Map()).set("ugnot", 3000000),
    {
      gas_wanted: new Long(60000000),
      gas_fee: "750000ugnot",
    });
  console.log("Gno transfer result:", result);
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


  const _marsClient = await connectComet("http://localhost:26657");
  const venusClient = await connectComet("http://localhost:36657");
  const atoneClient = await connectComet("http://localhost:56657");
  const devClient = await connectTm2("http://localhost:46657");

  const venusQuery = QueryClient.withExtensions(venusClient, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension);
  const atoneQuery = QueryClient.withExtensions(atoneClient, setupAuthExtension, setupBankExtension, setupIbcExtension, setupStakingExtension);

  console.log("Connected to all chains successfully.");

  test("Run mars -> venus", async () => {
    await transferFromTm("07-tendermint-2", "mars1z437dpuh5s4p64vtq09dulg6jzxpr2hdmpzeqe", "venus1z437dpuh5s4p64vtq09dulg6jzxpr2hdkj7exr", "10", "umars", "test transfer", "http://localhost:26657", "mars", "mars", {
      chainId: "mars",
      gasDenom: "umars",
      gasPrice: 0,
      id: 1,
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
    await transferFromTm("10-gno-1", "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x", "10", "uatone", "test transfer", "http://localhost:56657", "atone", "ibctest-1", {
      chainId: "ibctest-1",
      gasDenom: "uphoton",
      gasPrice: 0.025,
      id: 1,
    });
    await expect.poll(async () =>
      JSON.parse(
        Buffer.from(
          (await devClient.abciQuery({
            path: "vm/qrender",
            data: Buffer.from(`gno.land/r/aib/ibc/apps/transfer:grc20/ibc/542B346608DE032752AF0B21D165190090CD3194F6D177CF35025E39596ABC16/balance/g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x`, "utf-8")
          })
          ).responseBase.data
        ).toString('utf-8')), {
      timeout: 20000,
      interval: 5000,
    }
    ).toEqual({
      denom: "ibc/542B346608DE032752AF0B21D165190090CD3194F6D177CF35025E39596ABC16",
      balance: 10,
      address: "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x",
    });

    await expect.poll(() => atoneQuery.bank.balance("atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "uatone"), {
      timeout: 20000,
      interval: 5000,
    }).toEqual({
      denom: "uatone",
      amount: "9999999990",
    });
  }, 45000);

  test("Run gno -> atone return", async () => {
    try {
      await transferFromGnoGRC("07-tendermint-2", "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x", "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "10", "ibc/542B346608DE032752AF0B21D165190090CD3194F6D177CF35025E39596ABC16", "test transfer", process.env.RELAYER_MNEMONIC!, "http://localhost:46657");
    } catch (error) {
      console.error("Error during Gno transfer:", error);
      console.log(error);
      console.trace();
      throw new Error();
    }

    await expect.poll(async () =>
      JSON.parse(
        Buffer.from(
          (await devClient.abciQuery({
            path: "vm/qrender",
            data: Buffer.from(`gno.land/r/aib/ibc/apps/transfer:grc20/ibc/542B346608DE032752AF0B21D165190090CD3194F6D177CF35025E39596ABC16/balance/g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x`, "utf-8")
          })
          ).responseBase.data
        ).toString('utf-8')), {
      timeout: 20000,
      interval: 5000,
    }
    ).toEqual({
      denom: "ibc/542B346608DE032752AF0B21D165190090CD3194F6D177CF35025E39596ABC16",
      balance: 0,
      address: "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x",
    });

    await expect.poll(() => atoneQuery.bank.balance("atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "uatone"), {
      timeout: 20000,
      interval: 5000,
    }).toEqual({
      denom: "uatone",
      amount: "10000000000",
    });
  }, 45000);
});
