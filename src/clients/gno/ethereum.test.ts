import {
  describe, expect, it,
} from "vitest";

import {
  createEthereumClientScript, gnoBytes, isEthereumClientId, parseEthereumClientState, parseEthereumConsensusState, registerEthereumCounterpartyScript, RenderedEthereumClient,
} from "./ethereum.js";

// clients/ethereum-1 as the core realm renders it (gno-realms filetest
// z15a_create_ethereum_client).
const rendered: RenderedEthereumClient = JSON.parse("{\"client_state\":{\"chain_id\":\"3151908\",\"genesis_validators_root\":\"0ewwW5e/YzZXHCNI5Ki/FzaEsM235V9+ZVTVH4R4taM=\",\"min_sync_committee_participants\":\"11\",\"sync_committee_size\":\"32\",\"genesis_time\":\"1761902227\",\"genesis_slot\":\"0\",\"seconds_per_slot\":\"2\",\"slots_per_epoch\":\"8\",\"epochs_per_sync_committee_period\":\"8\",\"latest_height\":{\"revision_number\":0,\"revision_height\":72},\"latest_execution_block_number\":\"72\",\"is_frozen\":false,\"ibc_contract_address\":\"HZXVRFhurLY7YVTp5FEisy3tEao=\",\"ibc_commitment_slot\":\"EmCURIknKYjZ3yhRSbWqGw9I8hNtb0FhWfhAo+B0dgA=\",\"fork_parameters\":{\"genesis_fork_version\":\"EAAAOA==\",\"altair\":{\"version\":\"IAAAOA==\",\"epoch\":\"0\"},\"bellatrix\":{\"version\":\"MAAAOA==\",\"epoch\":\"0\"},\"capella\":{\"version\":\"QAAAOA==\",\"epoch\":\"0\"},\"deneb\":{\"version\":\"UAAAOA==\",\"epoch\":\"0\"},\"electra\":{\"version\":\"YAAAOA==\",\"epoch\":\"0\"},\"fulu\":{\"version\":\"cAAAOA==\",\"epoch\":\"1\"},\"gloas\":{\"version\":\"AAAAAA==\",\"epoch\":\"18446744073709551615\"}}},\"last_consensus_state\":{\"height\":{\"revision_number\":0,\"revision_height\":72},\"slot\":72,\"timestamp\":1761902371,\"state_root\":\"q4lNCXiYYNW6M0L2Hrd/aBZJ0CJSzBwCYPwO83mVBIE=\",\"current_sync_committee\":{\"pubkeys_hash\":\"Iqn/CGyjxIVK0GKMgWoV/IcY1+/JspOvKlrHHVS0sU8=\",\"aggregate_pubkey\":\"uSh4ZTA79IGqgNfyUBJ7sLIoGf9oGgImJoDTHnE0+1MX9VMcX4QkRkG2ku7xvRUc\"},\"next_sync_committee_known\":false}}");

describe("gno-hosted Ethereum clients", () => {
  const cs = parseEthereumClientState(rendered.client_state);
  const cons = parseEthereumConsensusState(rendered.last_consensus_state!);

  it("parses the core realm's renders", () => {
    expect(cs.chainId).toBe(3151908n);
    expect(cs.latestHeight).toEqual({
      revisionNumber: 0n,
      revisionHeight: 72n,
    });
    expect(cs.forkParameters.gloas.epoch).toBe(2n ** 64n - 1n);
    expect(cs.ibcContractAddress).toHaveLength(20);
    expect(cons.slot).toBe(72n);
    expect(cons.currentSyncCommittee.aggregatePubkey).toHaveLength(48);
    expect(cons.nextSyncCommittee).toBeUndefined();
  });

  it("renders the states back as Gno literals", () => {
    const src = createEthereumClientScript(cs, cons);
    expect(src).toContain("ChainID: 3151908,");
    expect(src).toContain("LatestSlot: 72,");
    expect(src).toContain("Fulu: ethereum.Fork{Version: [4]byte{0x70, 0x00, 0x00, 0x38}, Epoch: 1},");
    expect(src).toContain("Epoch: 18446744073709551615}");
    expect(src).toContain(`IBCContractAddress: ${gnoBytes(cs.ibcContractAddress)},`);
    expect(src).toContain("Timestamp: 1761902371,");
    expect(src).not.toContain("NextSyncCommittee");
    expect(createEthereumClientScript(cs, {
      ...cons,
      nextSyncCommittee: cons.currentSyncCommittee,
    })).toContain("NextSyncCommittee: &ethereum.SummarizedSyncCommittee{");
  });

  it("quotes bytes as escapes", () => {
    expect(gnoBytes(new Uint8Array([0, 0x22, 0x5c, 0xff]))).toBe("[]byte(\"\\x00\\x22\\x5c\\xff\")");
  });

  it("registers the router's empty prefix", () => {
    expect(registerEthereumCounterpartyScript("ethereum-1", "client-0"))
      .toContain("core.RegisterCounterparty(cross(cur), \"ethereum-1\", [][]byte{{}}, \"client-0\")");
    expect(isEthereumClientId("ethereum-3")).toBe(true);
    expect(isEthereumClientId("07-tendermint-0")).toBe(false);
  });
});
