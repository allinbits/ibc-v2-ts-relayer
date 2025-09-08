#!/bin/sh

CHAIN_NAME="${1:-mars}"

ignite scaffold chain $CHAIN_NAME

cd $CHAIN_NAME/

ignite chain serve --config /config.yaml
