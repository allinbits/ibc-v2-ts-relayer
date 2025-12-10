/* eslint-disable @stylistic/no-tabs */
export const UpdateClient = `package main

import (
	"time"
	"encoding/hex"

	"gno.land/p/aib/ibc/lightclient/tendermint"
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
		clientID      = "{{ clientId }}"                 
		chainID       = "{{ chainID }}"          
		height        = types.Height{{ openBr }}{{ revisionNumber }}, {{ revisionHeight }}{{ closeBr }}                  // TODO update
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
			TotalVotingPower: {{ totalVotingPower }},
		}
		trustedHeight = types.Height{{ openBr }}{{ trustedRevisionNumber }}, {{ trustedRevisionHeight }}{{ closeBr }}        // TODO update
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
				Time:    time.Unix({{ timeSec }}, {{ timeNanos }}),
				LastBlockID: tendermint.BlockID{
					Hash: hexDec("{{ blockHash }}"),
					PartSetHeader: tendermint.PartSetHeader{
						Total: {{ partSetTotal }},
						Hash:  hexDec("{{ partSetHash }}"),
					},
				},
				LastCommitHash:     hexDec("{{ lastCommitHash }}"), //FIXME
				DataHash:           hexDec("{{ dataHash }}"), //FIXME
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
						Timestamp:        time.Unix({{ this.timestampSeconds }}, {{ this.timestampNanos }}),
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
