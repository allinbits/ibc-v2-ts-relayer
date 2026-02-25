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
  toHex,
} from "@cosmjs/encoding";
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
  GnoWallet, MemFile, MemPackage,
} from "@gnolang/gno-js-client";
import {
  TransactionEndpoint,
} from "@gnolang/tm2-js-client";
import Long from "long";

import {
  ChainType,
} from "./types/index.js";
import {
  storage,
} from "./utils/storage.js";
import {
  getPrefix,
} from "./utils/utils.js";

function ibcRegistry(): Registry {
  return new Registry([...defaultRegistryTypes, ["/ibc.core.channel.v2.MsgSendPacket", MsgSendPacket as GeneratedType]]);
}
export const transferFromAtomone = async (clientId: string, sender: string, receiver: string, amount: string, denom: string, memo: string, mnem: string) => {
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
  const prefixA = await getPrefix(ChainType.Cosmos, "htttp://localhost:26659");
  const signerA = await DirectSecp256k1HdWallet.fromMnemonic(mnem, {
    prefix: prefixA,
  });
  const feesA = await storage.getChainFees("ibctest-1");

  const clientA = await SigningStargateClient.connectWithSigner("htttp://localhost:26659", signerA as OfflineSigner, {
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

export const transferFromGno = async (clientId: string, sender: string, receiver: string, amount: string, denom: string, memo: string, mnem: string) => {
  const packetData = FungibleTokenPacketData.encode(({
    amount,
    denom,
    sender,
    receiver,
    memo,
  } as FungibleTokenPacketData)).finish();

  const rundotgno = `package main

import (
        "chain/banker"
        "encoding/hex"

        "gno.land/p/aib/ibc/types"
        "gno.land/r/aib/ibc/core"
)

func hexDec(s string) []byte {
  b, err := hex.DecodeString(s)
  if err != nil { panic(err) }
  return b
}
func main() {
        var (
                packet = types.MsgSendPacket{
                        SourceClient:     "${clientId}",        // XXX update
                        TimeoutTimestamp: uint64(${BigInt(Math.floor(Date.now() / 1000) + 600).toString()}), // XXX update
                        Payloads: []types.Payload{
                                {
                                        SourcePort:      "transfer",           // XXX update
                                        DestinationPort: "transfer",           // XXX update
                                        Encoding:        "application/x-protobuf",           // XXX update
                                        Value:           hexDec("${toHex(packetData)}"),
                                        Version:         "ics20-1",           // XXX update
                                },
                        },
                }
                banker = banker.NewBanker(banker.BankerTypeOriginSend)
        )

        sequence := core.SendPacket(cross, banker, packet)

        println(sequence)
}
`;
  const memFile = MemFile.fromPartial({
    name: "run.gno",
    body: rundotgno,
  });
  const memPackage = MemPackage.fromPartial({
    files: [memFile],
    name: "main",
    path: "",
  });
  const prefix = await getPrefix(ChainType.Gno, "http://localhost:26657");

  const provider = new GnoJSONRPCProvider("http://localhost:26657");
  const wallet = await GnoWallet.fromMnemonic(mnem, {
    addressPrefix: prefix || "g",
  });
  wallet.connect(provider);
  const result = await wallet.executePackage(memPackage, TransactionEndpoint.BROADCAST_TX_COMMIT, (new Map()), (new Map()).set("ugnot", 3000000),
    {
      gas_wanted: new Long(60000000),
      gas_fee: "750000ugnot",
    });
  console.log("Gno transfer result:", result);
  return result;
};

export const transferFromGnoGRC = async (clientId: string, sender: string, receiver: string, amount: string, denom: string, memo: string, mnem: string) => {
  const prefix = await getPrefix(ChainType.Gno, "http://localhost:26657");

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
// transferFromAtomone("10-gno-0", "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x", "10", "uatone", "test transfer", "other razor era scene permit morning lend scrub habit beyond mixed icon alcohol fuel news glory alien actual bachelor spell album fitness squeeze energy");
transferFromGnoGRC("07-tendermint-1", "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x", "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6", "10", "ibc/F9A67CB19B2CAD2ADEC20AD475BE86DF851DEC2B6F6CABC9B7B781BD9131D18F", "test transfer", "other razor era scene permit morning lend scrub habit beyond mixed icon alcohol fuel news glory alien actual bachelor spell album fitness squeeze energy");
