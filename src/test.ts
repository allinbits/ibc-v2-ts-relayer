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
  ChainType,
} from "./types/index.js";
import {
  getSigner,
} from "./utils/signers.js";
import {
  storage,
} from "./utils/storage.js";
import {
  getPrefix,
} from "./utils/utils.js";

export const packetData = FungibleTokenPacketData.encode(({
  amount: "10",
  denom: "uatone",
  sender: "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6",
  receiver: "g1z437dpuh5s4p64vtq09dulg6jzxpr2hd4q8r5x",
  memo: "GNO IBC",
} as FungibleTokenPacketData)).finish();

const payload = Payload.fromPartial({
  sourcePort: "transfer",
  destinationPort: "transfer",
  version: "ics20-1",
  encoding: "application/x-protobuf", // can also be "application/json" or "application/x-solidity-abi"
  value: packetData, // the byte[] above
});
const msg = MsgSendPacket.fromPartial({
  sourceClient: "10-gno-0", // e.g. "07-tendermint-1"
  signer: "atone1z437dpuh5s4p64vtq09dulg6jzxpr2hdgu88r6",
  payloads: [payload], // an array of payloads such as the one above
  timeoutTimestamp: BigInt(Math.floor(Date.now() / 1000) + 600), // in SECONDS
});
function ibcRegistry(): Registry {
  return new Registry([...defaultRegistryTypes, ["/ibc.core.channel.v2.MsgSendPacket", MsgSendPacket as GeneratedType]]);
}
const test = async () => {
  const prefixA = await getPrefix(ChainType.Cosmos, "htttp://localhost:26659");
  const signerA = await getSigner("ibctest-1", ChainType.Cosmos, {
    prefix: prefixA,
  });
  const feesA = await storage.getChainFees("ibctest-1");

  const clientA = SigningStargateClient.connectWithSigner("htttp://localhost:26659", signerA as OfflineSigner, {
    gasPrice: GasPrice.fromString(feesA.gasPrice + feesA.gasDenom),
    registry: ibcRegistry(),
  });
  (await clientA).signAndBroadcast((await (signerA as OfflineSigner).getAccounts())[0].address, [
    {
      typeUrl: "/ibc.core.channel.v2.MsgSendPacket",
      value: msg,
    },
  ], "auto");
};
test();
