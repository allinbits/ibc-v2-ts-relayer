/* eslint-disable @stylistic/no-tabs */
export const CreateClient = `package main

import (
	"time"
	"encoding/hex"

	"gno.land/p/aib/ibc/lightclient/tendermint/v0"
	"gno.land/p/aib/ibc/types/v0"
	"gno.land/p/aib/ics23/v0"
	"gno.land/r/aib/ibc/core"
)
func hexDec(s string) []byte {
  b, err := hex.DecodeString(s)
                 if err != nil { panic(err) }
  return b
}
func main(cur realm) {
	// CreateClient
	var (
		chainID      = "{{ chainID }}"
		latestHeight = types.Height{ 
			RevisionNumber: {{ revisionNumber }},
			RevisionHeight: {{ revisionHeight }},
		}
		clientState = tendermint.ClientState{
			ChainID:         chainID,
			TrustLevel:      tendermint.Fraction{2, 3},
			UnbondingPeriod: {{ unbondingPeriod}},
			TrustingPeriod:  {{ trustingPeriod }},
			MaxClockDrift:   {{ maxClockDrift }},
			LatestHeight:    latestHeight,
			ProofSpecs:      ics23.GetSDKProofSpecs(),
		}
		apphash        = hexDec("{{ appHash }}")
		valhash        = hexDec("{{ nextValHash }}")
		timestamp      = time.Unix({{ timestampSec }}, {{ timestampNanos }})
		consensusState = tendermint.ConsensusState{
			Timestamp:          timestamp,
			Root:               tendermint.MerkleRoot{Hash: apphash[:]},
			NextValidatorsHash: valhash[:],
		}
	)
	id := core.CreateClient(cross(cur), clientState, consensusState)
	println(id)
}`;
