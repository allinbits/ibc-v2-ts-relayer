FROM ignitehq/cli:v29.6.2 AS builder

ENV DO_NOT_TRACK="1"

RUN ignite scaffold chain \
    --address-prefix=mars \
    --default-denom=umars \
    mars

WORKDIR /apps/mars

RUN ignite chain build --skip=proto

FROM ignitehq/cli:v29.6.2

ENV DO_NOT_TRACK="1"

COPY mars/config.yml /config.yml
COPY serve.sh /serve.sh

COPY --from=builder /apps /apps
COPY --from=builder /home/tendermint /home/tendermint

COPY --from=builder /go/bin/marsd /go/bin/marsd

WORKDIR /apps/mars

ENTRYPOINT ["/serve.sh"]
