import {
  DirectSecp256k1HdWallet, OfflineSigner,
} from "@cosmjs/proto-signing";
import {
  GnoWallet,
} from "@gnolang/gno-js-client";
import {
  Entry,
} from "@napi-rs/keyring";

import {
  ChainType,
} from "../types/index.js";

export const getSigner = async (chainId: string, chainType: ChainType, options?: {
  prefix: string
}): Promise<OfflineSigner | GnoWallet> => {
  if (chainType === ChainType.Cosmos) {
    if (typeof window !== "undefined") {
      if (window.keplr) {
        await window.keplr.enable(chainId);
        return await window.keplr.getOfflineSigner(chainId);
      }
      else {
        throw new Error("Keplr extension is not installed");
      }
    }
    else {
      const entry = new Entry("mnemonic", chainId);
      const mnem = entry.getPassword();
      if (!mnem) {
        throw new Error("Mnemonic not found in keyring");
      }
      return await DirectSecp256k1HdWallet.fromMnemonic(mnem, options);
    }
  }
  else if (chainType === ChainType.Gno) {
    if (typeof window !== "undefined") {
      throw new Error("Browser GNO signing not supported yet");
    }
    else {
      const entry = new Entry("mnemonic", chainId);
      const mnem = entry.getPassword();
      if (!mnem) {
        throw new Error("Mnemonic not found in keyring");
      }
      return await GnoWallet.fromMnemonic(mnem, {
        addressPrefix: options?.prefix || "g",
      });
    }
  }
  else {
    throw new Error(`Unsupported chain type: ${chainType}`);
  }
};
