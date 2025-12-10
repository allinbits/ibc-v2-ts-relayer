export const RecvPacket = `package main

import (
    "encoding/hex"

    "gno.land/p/aib/ibc/types"
    "gno.land/p/aib/ics23"
    "gno.land/r/aib/ibc/core"
)

func hexDec(s string) []byte {
  if s == "" {
    return nil
  }
  b, err := hex.DecodeString(s)
                 if err != nil { panic(err) }
  return b
}
func main() {
    // Receive the packet
    specs := ics23.IavlSpec()
    recvPacket := types.MsgRecvPacket{
      Packet: types.Packet{
      Sequence:          {{ sequence }},                        // XXX update
      SourceClient:      "{{ sourceClient }}",                // XXX update
      DestinationClient: "{{ destinationClient }}",    
      TimeoutTimestamp:  uint64({{timestamp}}), // XXX update: must be the same as the timestamp of the send packet 
      Payloads: []types.Payload{
      {{#each payloads}}
      {
        SourcePort:      "{{ this.sourcePort }}",             // XXX update
        DestinationPort: "{{ this.destinationPort }}", //XXX update
        Encoding:        "{{ this.encoding }}",
        Value:           hexDec("{{ this.value }}"),           // XXX update: the packet data
        Version:         "{{ this.version }}",         // XXX update: version of app (transfer uses v1)
      },
      {{/each}}
      },
      },
      // Write the proof of packet commitment written during the SendPacket of
      // the counterparty client.
      ProofCommitment: {{{ commitmentProof }}},
      ProofHeight: types.NewHeight({{ proofRevision }}, {{ proofHeight }}), // XXX update
    }
    

    res := core.RecvPacket(cross, recvPacket)

    println(res)
}`;
