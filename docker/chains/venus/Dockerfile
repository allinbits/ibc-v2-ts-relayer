FROM ignitehq/cli AS builder

ENV DO_NOT_TRACK="1"

RUN ignite scaffold chain \
    --address-prefix=venus \
    --default-denom=uvenus \
    venus

WORKDIR /apps/venus

RUN ignite chain build

FROM ignitehq/cli

ENV DO_NOT_TRACK="1"

COPY config.yml /config.yml

COPY --from=builder /apps /apps
COPY --from=builder /home/tendermint /home/tendermint

COPY --from=builder /go/bin/venusd /go/bin/venusd

WORKDIR /apps/venus

ENTRYPOINT ["ignite", "chain", "serve", "--config", "/config.yml", "--skip-build", "--skip-proto", "-r", "-o", "/dev/stdout"]
