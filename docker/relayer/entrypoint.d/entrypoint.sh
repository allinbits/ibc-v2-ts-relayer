#!/bin/bash

set -ex

sleep 1

# Run commands with keyring
/bin/with_keyring bash -c "
    ibc-v2-ts-relayer add-mnemonic -c marsibc \"other razor era scene permit morning lend scrub habit beyond mixed icon alcohol fuel news glory alien actual bachelor spell album fitness squeeze energy\"
    ibc-v2-ts-relayer add-mnemonic -c venusibc \"other razor era scene permit morning lend scrub habit beyond mixed icon alcohol fuel news glory alien actual bachelor spell album fitness squeeze energy\"

    ibc-v2-ts-relayer add-gas-price -c marsibc 0.025umars
    ibc-v2-ts-relayer add-gas-price -c venusibc 0.025uvenus

    ibc-v2-ts-relayer add-path \
        -s marsibc -d venusibc \
        --surl http://mars:26657 \
        --durl http://venus:26657

    exec \"\$@\"
" -- "$@"