/* eslint-disable max-lines-per-function */
import { QueryNextSequenceSendResponse,QueryPacketCommitmentResponse,QueryUnreceivedAcksResponse, QueryUnreceivedPacketsResponse } from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/query";
import {QueryClientImpl as ChannelV2Query} from "@atomone/cosmos-ibc-types/build/ibc/core/channel/v2/query";
import { createProtobufRpcClient, QueryClient } from "@cosmjs/stargate";

export interface IbcV2Extension {
  readonly ibc: {
    readonly channelV2: {      
      readonly packetCommitment: (
        clientId: string,
        sequence: number,
      ) => Promise<QueryPacketCommitmentResponse>;
      readonly unreceivedPackets: (
        clientId: string,
        packetCommitmentSequences: readonly number[],
      ) => Promise<QueryUnreceivedPacketsResponse>;
      readonly unreceivedAcks: (
        clientId: string,
        packetAckSequences: readonly number[],
      ) => Promise<QueryUnreceivedAcksResponse>;
      readonly nextSequenceSend: (
        clientId: string
      ) => Promise<QueryNextSequenceSendResponse>;
    };
  };
}

export function setupIbcV2Extension(base: QueryClient): IbcV2Extension {
  const rpc = createProtobufRpcClient(base);
  // Use these services to get easy typed access to query methods
  // These cannot be used for proof verification
  const channelQueryService = new ChannelV2Query(rpc);

  return {
    ibc: {
      channelV2: {
        packetCommitment: async (
          clientId: string,
          sequence: number,
        ) =>
          channelQueryService.PacketCommitment({
            clientId,
            sequence: BigInt(sequence),
          }),
        unreceivedPackets: async (
          clientId: string,
          sequences: readonly number[],
        ) =>
          channelQueryService.UnreceivedPackets({
            clientId,
            sequences: sequences.map((s) =>
              BigInt(s),
            ),
          }),
        unreceivedAcks: async (
          clientId: string,
          packetAckSequences: readonly number[],
        ) =>
          channelQueryService.UnreceivedAcks({
            clientId,
            packetAckSequences: packetAckSequences.map((s) => BigInt(s)),
          }),
        nextSequenceSend: async (clientId: string) =>
          channelQueryService.NextSequenceSend({
            clientId
          }),
      },
    },
  };
}
