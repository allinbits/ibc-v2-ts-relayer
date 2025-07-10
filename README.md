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