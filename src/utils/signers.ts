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
  Account, mnemonicToAccount, privateKeyToAccount,
} from "viem/accounts";

import {
  ChainType,
} from "../types/index.js";

export const getSigner = async (chainId: string, chainType: ChainType, options?: {
  prefix: string
}): Promise<OfflineSigner | GnoWallet | Account> => {
  if (chainType === ChainType.Cosmos) {
    if (typeof window !== "undefined") {
      if (window.keplr) {
        // Keplr handles address prefixes internally based on chain registry
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
  else if (chainType === ChainType.Ethereum) {
    if (typeof window !== "undefined") {
      throw new Error("Browser Ethereum signing not supported yet");
    }
    const entry = new Entry("mnemonic", chainId);
    const secret = entry.getPassword();
    if (!secret) {
      throw new Error("Mnemonic not found in keyring");
    }
    // The keyring entry holds a mnemonic, or a 0x-prefixed private key.
    if (/^0x[0-9a-fA-F]{64}$/.test(secret.trim())) {
      return privateKeyToAccount(secret.trim() as `0x${string}`);
    }
    return mnemonicToAccount(secret);
  }
  else {
    throw new Error(`Unsupported chain type: ${chainType}`);
  }
};
