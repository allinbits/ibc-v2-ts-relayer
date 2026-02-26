FROM       golang:1.25-alpine
ENV        CGO_ENABLED=0 GOOS=linux
WORKDIR    /app
RUN        apk add --no-cache git
RUN        apk add --no-cache automake make
RUN        git clone https://github.com/atomone-hub/atomone.git
WORKDIR     /app/atomone
RUN        git checkout feat/gno-lc
RUN        make build
WORKDIR     /app/atomone/build
RUN        cp ./atomoned /usr/local/bin/atomoned
RUN         ./atomoned init --chain-id ibctest-1 --default-denom uatone ibctest-1
RUN         ./atomoned keys add validator --keyring-backend="test"
RUN         ./atomoned genesis add-genesis-account $(./atomoned keys show validator -a --keyring-backend="test") 10000000000uatone,100000000000uphoton
RUN         ./atomoned genesis gentx validator 5000000000uatone --keyring-backend="test" --chain-id ibctest-1
RUN         ./atomoned genesis collect-gentxs
RUN          echo "Setting rpc listen address"
RUN         sed -i 's#"tcp://127.0.0.1:26657"#"tcp://0.0.0.0:26657"#g' ~/.atomone/config/config.toml
RUN         sed -i 's/timeout_commit = "5s"/timeout_commit = "1s"/g' ~/.atomone/config/config.toml
RUN         sed -i 's/timeout_propose = "3s"/timeout_propose = "1s"/g' ~/.atomone/config/config.toml
RUN         sed -i 's/index_all_keys = false/index_all_keys = true/g' ~/.atomone/config/config.toml
RUN         sed -i 's/minimum-gas-prices = ""/minimum-gas-prices = "0.0025uatone,0.0025uphoton"/g' ~/.atomone/config/app.toml
RUN         echo '#!/bin/sh' > /app/entrypoint.sh && \
            echo 'set -e' >> /app/entrypoint.sh && \
            echo 'if [ -z "$ATOMONE_RELAYER_ADDRESS" ]; then echo "ERROR: ATOMONE_RELAYER_ADDRESS environment variable is not set" >&2; exit 1; fi' >> /app/entrypoint.sh && \
            echo 'atomoned genesis add-genesis-account $ATOMONE_RELAYER_ADDRESS 10000000000uatone,100000000000uphoton' >> /app/entrypoint.sh && \
            echo 'exec atomoned start' >> /app/entrypoint.sh && \
            chmod +x /app/entrypoint.sh
EXPOSE 26657
EXPOSE 1317
ENTRYPOINT ["/app/entrypoint.sh"]