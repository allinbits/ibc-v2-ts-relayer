#!/bin/bash

set -ex

sleep 1

# Run commands with keyring
/bin/with_keyring bash -c "
    ibc-v2-ts-relayer add-mnemonic -c atomone-testnet-1 --mnemonic \"other razor era scene permit morning lend scrub habit beyond mixed icon alcohol fuel news glory alien actual bachelor spell album fitness squeeze energy\"
    ibc-v2-ts-relayer add-mnemonic -c test-13 --mnemonic \"other razor era scene permit morning lend scrub habit beyond mixed icon alcohol fuel news glory alien actual bachelor spell album fitness squeeze energy\"

    ibc-v2-ts-relayer add-gas-price -c atomone-testnet-1 0.025uphoton
    ibc-v2-ts-relayer add-gas-price -c test-13 0.025ugnot

    ibc-v2-ts-relayer add-path \
        -s atomone-testnet-1 \
        -d test-13 \
        --surl https://atomone-testnet-1-rpc.allinbits.services \
        --durl https://rpc.test13.testnets.gno.land \
        --dquery https://test13.indexer.onbloc.xyz/graphql/query \
        --dt gno \
        --ibcv 2

    exec \"\$@\"
" -- "$@"