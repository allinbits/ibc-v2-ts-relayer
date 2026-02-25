#!/bin/sh
set -e

if [ -z "$RELAYER_MNEMONIC" ]; then
  echo "ERROR: RELAYER_MNEMONIC environment variable is not set" >&2
  exit 1
fi

cp /config.yml /tmp/config.yml
sed -i "s|__RELAYER_MNEMONIC__|${RELAYER_MNEMONIC}|g" /tmp/config.yml

exec ignite chain serve --config /tmp/config.yml --skip-build --skip-proto -r -o /dev/stdout
