FROM        golang:1.25-alpine
ENV         CGO_ENABLED=0 GOOS=linux
WORKDIR     /app
RUN        apk add --no-cache git
ADD        https://api.github.com/repos/gnolang/gno/git/refs/heads/master /dev/null
RUN        git clone --depth 1 --branch master https://github.com/gnolang/gno.git
WORKDIR     /app
ADD        https://api.github.com/repos/allinbits/gno-realms/git/refs/heads/master /dev/null
RUN        git clone --depth 1 --branch master https://github.com/allinbits/gno-realms.git
WORKDIR     /app/gno-realms
RUN         cp -R ./gno.land/* /app/gno/examples/gno.land
WORKDIR     /app/gno/contribs/gnodev
RUN        go build -o /usr/local/bin/gnodev .
WORKDIR    /app
RUN        git clone https://github.com/gnolang/tx-indexer.git
WORKDIR    /app/tx-indexer
RUN        	go build -o build/tx-indexer ./cmd
WORKDIR    /app
# gnodev master dropped -lazy-loader and glob -paths: examples under
# $GNOROOT/examples load by default, and -paths takes explicit comma-separated
# package paths (kept for the IBC realms to ensure they deploy at genesis).
RUN        echo '#!/bin/sh' > /app/entrypoint.sh && \
           echo 'set -e' >> /app/entrypoint.sh && \
           echo 'if [ -z "$GNO_RELAYER_ADDRESS" ]; then echo "ERROR: GNO_RELAYER_ADDRESS environment variable is not set" >&2; exit 1; fi' >> /app/entrypoint.sh && \
           echo '/usr/local/bin/gnodev local -root /app/gno -paths gno.land/r/aib/ibc/core,gno.land/r/aib/ibc/apps/transfer -empty-blocks -no-watch -v -add-account $GNO_RELAYER_ADDRESS=1000000000000ugnot -node-rpc-listener 0.0.0.0:26657 -web-listener 0.0.0.0:8888 &' >> /app/entrypoint.sh && \
           echo "/app/tx-indexer/build/tx-indexer start --remote http://127.0.0.1:26657 --listen-address 0.0.0.0:8546 --db-path /app/tx-indexer/indexer-db" >> /app/entrypoint.sh && \
           chmod +x /app/entrypoint.sh
EXPOSE 8888
EXPOSE 8546
EXPOSE 26657
ENTRYPOINT  ["/app/entrypoint.sh"]
