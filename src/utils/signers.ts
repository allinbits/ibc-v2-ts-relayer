import {
  DirectSecp256k1HdWallet, OfflineSigner,
} from "@cosmjs/proto-signing";
import {
  Entry,
} from "@napi-rs/keyring";

export const getSigner = async (chainId: string): Promise<OfflineSigner> => {
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
    const entry = new Entry("menmonic", chainId);
    const mnem = entry.getPassword();
    if (!mnem) {
      throw new Error("Mnemonic not found in keyring");
    }
    return await DirectSecp256k1HdWallet.fromMnemonic(mnem);
  }
};
