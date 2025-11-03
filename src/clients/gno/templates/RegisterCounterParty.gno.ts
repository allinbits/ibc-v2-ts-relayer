/* eslint-disable @stylistic/no-tabs */
export const RegisterCounterparty = `package main

import (
	"encoding/hex"
	"gno.land/r/aib/ibc/core"
)

func hexDec(s string) []byte {
  b, err := hex.DecodeString(s)
                 if err != nil { panic(err) }
  return b
}
func main() {
	var (
		clientID                 = "{{ clientId }}"
		counterpartyMerklePrefix = [][]byte{
			hexDec("{{ iavlStoreKey }}"),
			hexDec("{{ StoreKey }}"),
		}
		counterpartyClientID = "{{ counterpartyClientId }}"
	)
	core.RegisterCounterparty(cross, clientID, counterpartyMerklePrefix, counterpartyClientID)
}`;
