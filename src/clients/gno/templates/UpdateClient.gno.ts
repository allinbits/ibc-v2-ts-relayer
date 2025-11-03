/* eslint-disable @stylistic/no-tabs */
export const UpdateClient = `package main

import (
	"crypto/sha256"
	"time"
	"hex"

	"gno.land/p/aib/ibc/lightclient/tendermint"
	"gno.land/p/aib/ibc/lightclient/tendermint/testing"
	"gno.land/p/aib/ibc/types"
	"gno.land/r/aib/ibc/core"
)

func hexDec(s string) []byte {
  b, err := hex.DecodeString(s)
                 if err != nil { panic(err) }
  return b
}
func main() {
	var (
		clientID      = {{ clientId }}                 
		chainID       = {{ chainId }}                       
		timestamp     = time.Unix({{ timestampSec }}, {{ timestampNanos }})
		blockhash     = hexDec("{{ blockHash }}")
		parsethash    = hexDec("{{ partSetHash }}")
		consensushash = hexDec("{{ consensusHash }}")
		apphash       = hexDec("{{ appHash }}")
		height        = types.Height{{{ revisionNumber }}, {{ revisionHeight}}}                 // TODO update
		valset        = &tendermint.ValidatorSet{          // TODO update
			Validators: []*tendermint.Validator{
        {{#each validators}}
        {
					Address:     hexDec("{{ this.address }}"),
					PubKey:      hexDec("{{ this.pubKey }}"),
					VotingPower: {{ this.votingPower}},
				},
        {{/each}}
			},
			Proposer: &tendermint.Validator{
				Address:     hexDec("{{ proposerAddress }}"),
				PubKey:      hexDec("{{ proposerPubKey }}"),
				VotingPower: {{ proposerVotingPower }},
			},
			TotalVotingPower: {{ totalVotingPower}},
		}
		trustedHeight = types.Height{{{ trustedRevisionNumber }}, {{ trustedRevisionHeight }}}        // TODO update
		trustedValset = &tendermint.ValidatorSet{ // TODO update
			Validators: []*tendermint.Validator{
        {{#each trustedValidators}}
        {
					Address:     hexDec("{{ this.address }}"),
					PubKey:      hexDec("{{ this.pubKey }}"),
					VotingPower: {{ this.votingPower}},
				},
        {{/each}}
			},
			Proposer: &tendermint.Validator{
					Address:     hexDec("{{ trustedProposerAddress }}"),
					PubKey:      hexDec("{{ trustedProposerPubKey }}"),
					VotingPower: {{ trustedProposerVotingPower}},
			},
			TotalVotingPower: {{ trustedVotingPower }},
		}
		msgHeader = &tendermint.MsgHeader{
			Header: &tendermint.Header{
				Version: tendermint.Consensus{
					Block: tendermint.BlockProtocol,
					App:   0, //NOTE no idea what to put there, sounds unused
				},
				ChainID: chainID,
				Height:  height.RevisionHeight,
				Time:    time.Unix({{ timestampSec }}, {{ timestampNanos }}),
				LastBlockID: tendermint.BlockID{
					Hash: hexDec("{{ blockHash }}"),
					PartSetHeader: tendermint.PartSetHeader{
						Total: {{ partSetTotal }},
						Hash:  hexDec("{{ partSetHash }}"),
					},
				},
				LastCommitHash:     hexDec("{{ LastCommitHash }}"), //FIXME
				DataHash:           hexDec("{{ DataHash }}"), //FIXME
				ValidatorsHash:     hexDec("{{ validatorsHash }}"),
				NextValidatorsHash: hexDec("{{ nextValidatorsHash }}"),
				ConsensusHash:      hexDec("{{ consensusHash }}"),
				AppHash:            hexDec("{{ appHash }}"),
				LastResultsHash:    hexDec("{{ lastResultsHash }}"),
				EvidenceHash:       hexDec("{{ evidenceHash }}"),                  
				ProposerAddress:    hexDec("{{ proposerAddress }}"), // TODO update
			},
			Commit: &tendermint.Commit{
				Height: {{ commitHeight }},
				Round:  {{ commitRound }},
				BlockID: tendermint.BlockID{
					Hash: hexDec("{{ commitBlockIdHash }}"),
					PartSetHeader: tendermint.PartSetHeader{
						Total: {{ commitPartSetTotal }},
						Hash:  hexDec("{{ commitPartSetHash }}"),
					},
				},
				Signatures: []tendermint.CommitSig{
          {{#each commitSignatures}}
					{
						BlockIDFlag:      {{ this.blockIdFlag }},
						ValidatorAddress: hexDec("{{ this.validatorAddress }}"),
						Signature:        hexDec("{{ this.signature }}"),
					},
          {{/each}}
				},
			},
			ValidatorSet:      valset,
			TrustedHeight:     trustedHeight,
			TrustedValidators: trustedValset,
		}
	)
	core.UpdateClient(cross, clientID, msgHeader)
}`;
