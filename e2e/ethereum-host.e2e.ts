/**
 * Ethereum as a host of a gno.land light client, end to end on local chains:
 * the gno-eth-ibc testnet (3 secp256k1 validators) and anvil with the eureka
 * router deployed by gno-eth-ibc's e2e (`make e2e-local` there leaves both
 * running). See README.md "Ethereum host e2e" for the environment.
 *
 * The test deploys a GnoLightClient through EthereumIbcClient.createGnoClient
 * from GnoIbcClient.buildCreateClientArgs, adds it to the router, links it to
 * a placeholder Ethereum client on gno (created with gno-eth-ibc's Go
 * relayer), sends an ICS20 transfer from gno, and relays it with this
 * repository's code only: updateClient, getPacketProofV2, receivePacketsV2.
 */
import {
  execFileSync,
} from "node:child_process";
import {
  existsSync, readFileSync,
} from "node:fs";
import {
  join, resolve,
} from "node:path";

import {
  Packet as PacketV2,
} from "@atomone/atomone-types/ibc/core/channel/v2/packet.js";
import {
  GnoWallet,
} from "@gnolang/gno-js-client";
import {
  createPublicClient, Hex, http, parseAbi,
} from "viem";
import {
  privateKeyToAccount,
} from "viem/accounts";
import {
  expect, test,
} from "vitest";

import {
  EthereumIbcClient,
} from "../src/clients/ethereum/IbcClient.ts";
import {
  GnoIbcClient,
} from "../src/clients/gno/IbcClient.ts";
import {
  ClientStatus, ClientType,
} from "../src/types/index.ts";
import {
  log,
} from "../src/utils/logging.ts";
import {
  parseAcksFromTxEventsV2,
} from "../src/utils/utils.ts";

const GNO_ETH_IBC = resolve(process.env.GNO_ETH_IBC ?? "../gnolang/gno-eth-ibc");
const GNO_RPC = process.env.GNO_RPC ?? "http://127.0.0.1:26657";
const ETH_RPC = process.env.ETH_RPC ?? "http://127.0.0.1:8545";
// anvil's first dev account: a public test key, local chains only
const ETH_KEY = (process.env.ETH_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
// the testnet's genesis-funded test1 key: public, local chains only
const GNO_MNEMONIC = process.env.GNO_MNEMONIC
  ?? "source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast";
const RECEIVER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function goRelayer(...args: string[]): string {
  const bin = join(GNO_ETH_IBC, ".cache/bin/relayer");
  if (!existsSync(bin)) {
    execFileSync("go", ["build", "-o", bin, "./cmd/relayer"], {
      cwd: join(GNO_ETH_IBC, "relayer"),
    });
  }
  return execFileSync(bin, args, {
    env: {
      ...process.env,
      GNO_MNEMONIC,
    },
    encoding: "utf8",
  });
}

function gnoTransfer(gnoClientId: string, amount: number): {
  height: number
  packet: PacketV2
} {
  const timeout = Math.floor(Date.now() / 1000) + 3600;
  const out = execFileSync(join(GNO_ETH_IBC, "testnet/.data/bin/gnokey"), ["maketx", "call", "-home", join(GNO_ETH_IBC, "testnet/.data/gnokey"), "-insecure-password-stdin", "-pkgpath", "gno.land/r/aib/ibc/apps/transfer", "-func", "Transfer", "-args", gnoClientId, "-args", RECEIVER, "-args", "ugnot", "-args", String(amount), "-args", String(timeout), "-args", "", "-send", `${amount}ugnot`, "-gas-fee", "10000000ugnot", "-gas-wanted", "150000000", "-broadcast", "-chainid", "gno-eth-dev", "-remote", GNO_RPC, "test1"], {
    input: "\n",
    encoding: "utf8",
  });
  const height = Number(/HEIGHT:\s+(\d+)/.exec(out)?.[1]);
  const packetHex = /"encoded_packet_hex","value":"([0-9a-f]+)"/.exec(out)?.[1];
  if (!height || !packetHex) {
    throw new Error(`transfer failed:\n${out}`);
  }
  return {
    height,
    packet: PacketV2.decode(Buffer.from(packetHex, "hex")),
  };
}

test("Ethereum hosts a GnoLightClient and receives a packet from gno", async () => {
  const deployment = JSON.parse(readFileSync(join(GNO_ETH_IBC, "contracts/deployments/local.json"), "utf8"));
  const wallet = await GnoWallet.fromMnemonic(GNO_MNEMONIC, {
    addressPrefix: "g",
  });
  const gno = await GnoIbcClient.connectWithSigner(GNO_RPC, "http://127.0.0.1:1/unused", wallet, {
    senderAddress: await wallet.getAddress(),
    addressPrefix: "g",
    logger: log,
  });
  const eth = await EthereumIbcClient.connectWithSigner(ETH_RPC, privateKeyToAccount(ETH_KEY), {
    router: deployment.ics26Router,
    beacon: "http://127.0.0.1:1/unused",
  }, {
    logger: log,
  });

  // the gno side: an Ethereum client that is never updated (anvil has no beacon chain)
  const created = JSON.parse(goRelayer("gno-create-eth-client", "-gno-rpc", GNO_RPC, "-evm-chain-id", eth.chainId, "-router", deployment.ics26Router));
  const gnoClientId: string = created.clientId;

  // the Ethereum side, through this repository's host
  const args = await gno.buildCreateClientArgs();
  const {
    clientId,
  } = await eth.createGnoClient(args.clientState, args.consensusState);
  await eth.registerCounterParty(clientId, gnoClientId, Buffer.from("main"), Buffer.from("/pv/vm:gno.land/r/aib/ibc/core:"));
  goRelayer("gno-register-counterparty", "-gno-rpc", GNO_RPC, "-client", gnoClientId, "-counterparty", clientId);
  expect(await eth.getCounterparty(clientId)).toBe(gnoClientId);

  const sent = gnoTransfer(gnoClientId, 1234);
  expect(sent.packet.destinationClient).toBe(clientId);

  // relay as link.ts does: update to a height above the packet's, prove at height - 1
  await gno.waitOneBlock();
  await gno.waitOneBlock();
  const headerHeight = await eth.updateClient(clientId, gno);
  expect(Number(headerHeight.revisionHeight)).toBeGreaterThan(sent.height);
  const proof = await gno.getPacketProofV2(sent.packet, headerHeight);
  const res = await eth.receivePacketsV2([sent.packet], [proof.proof], headerHeight);
  const acks = parseAcksFromTxEventsV2(res.events);
  expect(acks).toHaveLength(1);
  expect(acks[0].originalPacket.sequence).toBe(sent.packet.sequence);

  // the voucher reached the receiver
  const pc = createPublicClient({
    transport: http(ETH_RPC),
  });
  const token = await pc.readContract({
    address: deployment.ics20Transfer,
    abi: parseAbi(["function ibcERC20Contract(string) view returns (address)"]),
    functionName: "ibcERC20Contract",
    args: [`transfer/${clientId}/ugnot`],
  } as never) as Hex;
  const balance = await pc.readContract({
    address: token,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [RECEIVER],
  } as never);
  expect(balance).toBe(1234n);

  // the views the Link and the monitor use
  const cs = await eth.getLatestClientState(clientId, ClientType.Gno);
  expect(cs.latestHeight?.revisionHeight).toBe(headerHeight.revisionHeight);
  expect(await eth.getClientStatus(clientId)).toBe(ClientStatus.Active);
  const after = await eth.getConsensusStatesAfter(clientId, ClientType.Gno, 0n, 10);
  expect(after.map(s => s.revisionHeight)).toContain(headerHeight.revisionHeight);

  // a second round uses the validator set the client cached
  const second = gnoTransfer(gnoClientId, 66);
  await gno.waitOneBlock();
  await gno.waitOneBlock();
  const h2 = await eth.updateClient(clientId, gno);
  const proof2 = await gno.getPacketProofV2(second.packet, h2);
  const res2 = await eth.receivePacketsV2([second.packet], [proof2.proof], h2);
  expect(parseAcksFromTxEventsV2(res2.events)).toHaveLength(1);
}, 300_000);
