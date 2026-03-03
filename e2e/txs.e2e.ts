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
  SigningStargateClient,
} from "@cosmjs/stargate";
import {
  GnoJSONRPCProvider,
  GnoWallet,
} from "@gnolang/gno-js-client";
import {
  TransactionEndpoint,
} from "@gnolang/tm2-js-client";
import Long from "long";
import {
  test,
} from "vitest";

import {
  ChainFees,
} from "../src/types/index.ts";

function ibcRegistry(): Registry {
  return new Registry([...defaultRegistryTypes, ["/ibc.core.channel.v2.MsgSendPacket", MsgSendPacket as GeneratedType]]);
}

export const transferFromGnoGRC = async (clientId: string, sender: string, receiver: string, amount: string, denom: string, memo: string, mnem: string) => {
  const prefix = "g";

  const provider = new GnoJSONRPCProvider("http://localhost:26657");
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

test("Run mars -> venus test", async () => {
  await transferFromTm("07-tendermint-2", "mars1z437dpuh5s4p64vtq09dulg6jzxpr2hdmpzeqe", "venus1z437dpuh5s4p64vtq09dulg6jzxpr2hdkj7exr", "10", "umars", "test transfer", "http://localhost:26657", "mars", "mars", {
    chainId: "mars",
    gasDenom: "umars",
    gasPrice: 0.025,
    id: 1,
  });
  await transferFromTm("10-gno-1", "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x", "10", "uatone", "test transfer", "http://localhost:46657", "atone", "ibctest-1", {
    chainId: "ibctest-1",
    gasDenom: "uphoton",
    gasPrice: 0.025,
    id: 1,
  });
}, 120000);
