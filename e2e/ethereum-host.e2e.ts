/**
 * Ethereum as a host of a gno.land light client, end to end on local chains:
 * the gno-eth-ibc testnet (3 secp256k1 validators) and anvil with the eureka
 * router deployed by gno-eth-ibc's e2e (`make e2e-local` there leaves both
 * running). See README.md "Ethereum host e2e" for the environment.
 *
 * The test deploys a GnoLightClient through EthereumIbcClient.createGnoClient
 * from GnoIbcClient.buildCreateClientArgs, adds it to the router, links it to
 * a placeholder Ethereum client on gno (GnoIbcClient.createEthereumClient),
 * sends an ICS20 transfer from gno, and relays it with this repository's code
 * only: updateClient, getPacketProofV2, receivePacketsV2.
 */
import {
  readFileSync,
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
  TransactionEndpoint,
} from "@gnolang/tm2-js-client";
import {
  createPublicClient, Hex, hexToBytes, http, parseAbi,
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
  IBC_STORE_COMMITMENT_SLOT,
} from "../src/clients/ethereum/sourceAbi.ts";
import {
  ETHEREUM_LC_TYPE, EthereumClientState, EthereumConsensusState,
} from "../src/clients/ethereum/types.ts";
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

// Sends an ICS20 transfer of ugnot from gno and returns the packet it sent.
async function gnoTransfer(wallet: GnoWallet, gnoClientId: string, amount: number): Promise<{
  height: number
  packet: PacketV2
}> {
  const timeout = Math.floor(Date.now() / 1000) + 3600;
  const result = await wallet.callMethod("gno.land/r/aib/ibc/apps/transfer", "Transfer", [gnoClientId, RECEIVER, "ugnot", String(amount), String(timeout), ""], TransactionEndpoint.BROADCAST_TX_COMMIT, (new Map()).set("ugnot", amount), (new Map()).set("ugnot", 3000000), {
    gas_wanted: 150_000_000n,
    gas_fee: "10000000ugnot",
  });
  const {
    Events: rawEvents, Error: error,
  } = result.deliver_tx.ResponseBase;
  if (error) {
    throw new Error(`transfer failed: ${JSON.stringify(error)}`);
  }
  // typed as a JSON string, delivered parsed
  const events: GnoEvent[] = typeof rawEvents === "string" ? JSON.parse(rawEvents) : rawEvents ?? [];
  const packetHex = events.flatMap(e => e.attrs ?? []).find(a => a.key === "encoded_packet_hex")?.value;
  if (!packetHex) {
    throw new Error(`no packet in the transfer's events: ${JSON.stringify(events)}`);
  }
  return {
    height: Number(result.height),
    packet: PacketV2.decode(Buffer.from(packetHex, "hex")),
  };
}

interface GnoEvent {
  attrs?: {
    key: string
    value: string
  }[]
}

// An Ethereum client on gno that is never updated, anvil having no beacon
// chain: enough to send packets from gno to the router.
function placeholderEthereumClient(chainId: bigint, router: Hex): {
  clientState: EthereumClientState
  consensusState: EthereumConsensusState
} {
  const fork = (v: number) => ({
    version: new Uint8Array([v, 0, 0, 0]),
    epoch: 0n,
  });
  return {
    clientState: {
      lcType: ETHEREUM_LC_TYPE,
      chainId,
      genesisValidatorsRoot: new Uint8Array(32),
      minSyncCommitteeParticipants: 1n,
      syncCommitteeSize: 32n,
      genesisTime: 0n,
      genesisSlot: 0n,
      forkParameters: {
        genesisForkVersion: new Uint8Array(4),
        altair: fork(1),
        bellatrix: fork(2),
        capella: fork(3),
        deneb: fork(4),
        electra: fork(5),
        fulu: fork(6),
        gloas: {
          version: new Uint8Array(4),
          epoch: 2n ** 64n - 1n,
        },
      },
      secondsPerSlot: 12n,
      slotsPerEpoch: 32n,
      epochsPerSyncCommitteePeriod: 256n,
      latestHeight: {
        revisionNumber: 0n,
        revisionHeight: 1n,
      },
      latestExecutionBlockNumber: 1n,
      ibcContractAddress: hexToBytes(router),
      ibcCommitmentSlot: hexToBytes(IBC_STORE_COMMITMENT_SLOT),
    },
    consensusState: {
      lcType: ETHEREUM_LC_TYPE,
      slot: 1n,
      stateRoot: new Uint8Array(32),
      // must precede the packets' timeouts
      timestamp: {
        seconds: BigInt(Math.floor(Date.now() / 1000) - 60),
      },
      currentSyncCommittee: {
        pubkeysHash: new Uint8Array(32),
        aggregatePubkey: new Uint8Array(48),
      },
    },
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

  // the gno side: an Ethereum client that is never updated
  const placeholder = placeholderEthereumClient(BigInt(eth.chainId), deployment.ics26Router);
  const {
    clientId: gnoClientId,
  } = await gno.createEthereumClient(placeholder.clientState, placeholder.consensusState);

  // the Ethereum side, through this repository's host
  const args = await gno.buildCreateClientArgs();
  const {
    clientId,
  } = await eth.createGnoClient(args.clientState, args.consensusState);
  await eth.registerCounterParty(clientId, gnoClientId, Buffer.from("main"), Buffer.from("/pv/vm:gno.land/r/aib/ibc/core:"));
  await gno.registerCounterParty(gnoClientId, clientId, new Uint8Array());
  expect(await eth.getCounterparty(clientId)).toBe(gnoClientId);

  const sent = await gnoTransfer(wallet, gnoClientId, 1234);
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
  const second = await gnoTransfer(wallet, gnoClientId, 66);
  await gno.waitOneBlock();
  await gno.waitOneBlock();
  const h2 = await eth.updateClient(clientId, gno);
  const proof2 = await gno.getPacketProofV2(second.packet, h2);
  const res2 = await eth.receivePacketsV2([second.packet], [proof2.proof], h2);
  expect(parseAcksFromTxEventsV2(res2.events)).toHaveLength(1);
}, 300_000);
