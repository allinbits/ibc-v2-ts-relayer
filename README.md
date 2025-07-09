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
Modify as needed.

The `src/utils/signers.ts` file currently has the mnemonic for the relayer account hard-coded (reading from keyring pending). Again modify as needed.

Once the above have been setup:

`node dist/index.js` will start the relayer and do V1 handshaking between the 2 chains and start relaying messages.
