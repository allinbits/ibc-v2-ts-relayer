Tentative Instructions.

Requires:
- node >= v20
- pnpm 

To install pnpm run:
`npm install -g pnpm`

Once you clone the repo:

```
cd ibc-v2-ts-relayer
pnpm install
```

In order to test the relayer you need 2 running SDK >= 0.50 chains running with IBC v2 wired and enabled.

Easiest way is to scaffold 2 chains using the latest Ignite CLI (build from repo)

In the second one, you'll have to adjust the config.yml file to ensure API/RPC/faucet are running on different ports.

To do this, modify the first (and only) validator in config.yml like so:

```
- name: alice
  bonded: 100000000stake
  config:
    p2p:
      laddr: "tcp://0.0.0.0:26659"
    rpc:
      laddr: "tcp://0.0.0.0:26658"
  app:
    api: 
      swagger: true
      enable: true
      address: "tcp://localhost:1318"
      max-open-connections: "1000"
    grpc:
      enable: true
      address: "localhost:9091"
  rpc:
    address: "0.0.0.0:26658"
```

and the faucet port as needed.

Then start both chains with `ignite chain serve`.

The `src/index.ts` file is currently configured to look for 2 chains on `localhost:26657` and `localhost:26658` called `chaina` and `chainb` accordingly.
It sets up an IBC v1 and an IBC v2 connection between them.
Modify as needed.

The `src/utils/signers.ts` file currently has the mnemonic for the relayer account hard-coded (reading from keyring pending). Again modify as needed.

Once the above have been setup:

`node dist/index.js` will start the relayer and do V1 and v2 handshaking between the 2 chains and start relaying messages for the 2 paths (v1 and v2)

Below you will find the basic code (in Typescript) to craft an MsgSendPacket message in order to create an IBC v2 Transfer transaction:

First we create the FungibleTokenPacketData (V2 transfer app) and proto-encode it to a Uint8Array:

```
      const packetData = FungibleTokenPacketData.encode(({
        amount: <amount>,
        denom: <denom>,
        sender: <senderAddress>,
        receiver: <receiverAddress>,
        memo: <optionalMemo>,
      } as FungibleTokenPacketData)).finish();
```

This can also be JSON or solidity ABI encoded (instead of proto-encoded) chosen by the encoding field in the payload struct.
The payload struct is constructed as follows:

```
      const payloadV2 =  Payload.fromPartial({
        sourcePort: 'transfer',
        destinationPort: 'transfer',
        version: 'ics20-1',
        encoding: "application/x-protobuf", // can also be "application/json" or "application/x-solidity-abi"
        value: packetData, // the byte[] above
      });
```

Finally we build the message like so:

```
      const msg = MsgSendPacket.fromPartial({
        sourceClient: <sourceClientId>, //e.g. "07-tendermint-1"
        signer: <signerAddress>,
        payloads: [payloadV2], // an array of payloads such as the one above
        timeoutTimestamp: <unixTimestamp> // in SECONDS
      })
```
## Ethereum as a host of gno.land light clients

`src/clients/ethereum/host.ts` relays to [GnoLightClient](https://github.com/gnolang/gno-eth-ibc) contracts
behind the solidity-ibc-eureka v3.0.2 ICS26Router; `gnoibc.ts` holds its header and proof encoders, checked
byte for byte against the Go encoder (`src/clients/ethereum/testdata/gnoibc-vectors.json`, from
`go run ./cmd/genfixtures -ts-out …` in gno-eth-ibc's `fixtures/`). The contract ABI and bytecode in
`src/clients/ethereum/artifacts/` are generated with `pnpm gen:eth-artifacts` (`GNO_ETH_IBC` points at a
gno-eth-ibc checkout with a Foundry build; each file records the source commit).

End to end on local chains (`pnpm test:eth-host:e2e`): run `make e2e-local` in gno-eth-ibc first. It leaves
the gno testnet (`127.0.0.1:26657`) and anvil (`127.0.0.1:8545`) running with the router deployed
(`contracts/deployments/local.json`). The test then deploys a GnoLightClient through `createGnoClient`, adds
it with `registerCounterParty`, sends an ICS20 transfer from gno over a placeholder Ethereum client (created
with `createEthereumClient`), relays it with `updateClient`, `getPacketProofV2` and `receivePacketsV2`, and
checks the ack and the voucher balance. Environment: `GNO_ETH_IBC` (default `../gnolang/gno-eth-ibc`),
`GNO_RPC`, `ETH_RPC`, `ETH_PRIVATE_KEY` and `GNO_MNEMONIC` (defaults: the public dev keys of anvil and of the
testnet's test1 account).

## gno.land as a host of Ethereum light clients

The gno client relays Ethereum (`relayer add-ethereum-chain -c <chain-id> -r <ICS26Router> -b <beacon API>
[-p <proof RPC>]`) to the Ethereum light client of the IBC core realm
(`gno.land/p/aib/ibc/lightclient/ethereum/v0` in gno-realms, which needs the chain's `crypto/bls12381`
natives). Heights of an Ethereum client are finalized beacon slots.

- `createEthereumClient` and the counterparty registration (the router's empty merkle prefix) are MsgRun
  scripts, built by `src/clients/gno/ethereum.ts`.
- Updates and packets are MsgCalls to `gno.land/r/aib/ibc/ethrelay`, whose arguments are messages in the
  `gno.land/p/aib/encoding/wire/v0` format (`src/clients/ethereum/wire.ts`). An update carries the sync committee's
  non-signers, not its keys; one that crosses sync committee periods takes several transactions, each sent
  once gno's block time has reached its signature slot.
- Storage proofs are taken with `eth_getProof` at finalized blocks, 64 to 96 blocks behind head. Most public
  RPCs refuse that; set the chain's proof RPC (`-p`) to one that serves it, such as an archive node.

Gas on gno.land: about 40M per update (50M when it crosses a period), 94M to receive a packet, 63M per
acknowledgement.
