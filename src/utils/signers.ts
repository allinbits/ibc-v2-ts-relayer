import { DirectSecp256k1HdWallet, OfflineSigner } from "@cosmjs/proto-signing";

export const getSigner = async (chainId: string): Promise<OfflineSigner> => {
  if (typeof window !== "undefined") {
    if (window.keplr) {
      await window.keplr.enable(chainId);
      return await window.keplr.getOfflineSigner(chainId);
    } else {
      throw new Error("Keplr extension is not installed");
    }
  }else{
    return await DirectSecp256k1HdWallet.generate(12);
  }
}