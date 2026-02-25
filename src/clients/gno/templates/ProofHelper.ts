import {
  InnerOp,
} from "@atomone/cosmos-ibc-types/cosmos/ics23/v1/proofs.js";
import {
  toHex,
} from "@cosmjs/encoding";
import {
  ExistenceProof, LeafOp, NonExistenceProof,
} from "cosmjs-types/cosmos/ics23/v1/proofs.js";
import {
  MerkleProof,
} from "cosmjs-types/ibc/core/commitment/v1/commitment.js";

export const renderInnerOps = (innerOps: InnerOp[]): string => {
  let gnoCode = "[]*ics23.InnerOp{\n";
  for (const op of innerOps) {
    gnoCode += `{
      Hash:   specs.InnerSpec.Hash,
      Prefix: hexDec("${toHex(op.prefix)}"),
      Suffix: hexDec("${toHex(op.suffix)}"),
    },
    `;
  }
  gnoCode += "},\n";
  return gnoCode;
};
export const renderLeafOp = (leaf: LeafOp): string => {
  const gnoCode = `&ics23.LeafOp{
    Hash:         specs.LeafSpec.Hash,
    PrehashKey:   specs.LeafSpec.PrehashKey,
    PrehashValue: specs.LeafSpec.PrehashValue,
    Length:       specs.LeafSpec.Length,
    Prefix:       hexDec("${toHex(leaf.prefix)}"),
  }`;
  return gnoCode;
};
export const renderExistenceProof = (exist: ExistenceProof): string => {
  const gnoCode = `&ics23.ExistenceProof{
    Key:   hexDec("${toHex(exist.key)}"),
    Value: hexDec("${toHex(exist.value)}"),
    Leaf: ${renderLeafOp(exist.leaf!)},
    Path: ${renderInnerOps(exist.path)}
  },`;
  return gnoCode;
};
export const renderNonExistenceProof = (nonexist: NonExistenceProof): string => {
  const gnoCode = `&ics23.NonExistenceProof{
    Key:   hexDec("${toHex(nonexist.key)}"),
    Left: ${nonexist.left ? renderExistenceProof(nonexist.left) : "nil,"}
    Right: ${nonexist.right ? renderExistenceProof(nonexist.right) : "nil,"}
  },`;
  return gnoCode;
};
export const ProofHelper = (proof: MerkleProof): string => {
  let gnoCode = "[]ics23.CommitmentProof{\n";
  for (const p of proof.proofs) {
    if (p.exist) {
      gnoCode += `  ics23.CommitmentProof_Exist{
        Exist: ${renderExistenceProof(p.exist)}
      },`;
    }
    if (p.nonexist) {
      gnoCode += `  ics23.CommitmentProof_Nonexist{
        Nonexist: ${renderNonExistenceProof(p.nonexist)}
      },`;
    }
  }
  return gnoCode + "}";
};
