import {
  GnoJSONRPCProvider,
  GnoWallet,
} from "@gnolang/gno-js-client";
import {
  TransactionEndpoint,
} from "@gnolang/tm2-js-client";
import {
  beforeAll,
} from "vitest";

// gnodev deploys realms with test1 as DefaultCreator, making it the core realm admin
const TEST1_SEED = "source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast";

export function setupGnoWhitelist(gnoUrl = "http://localhost:46657") {
  beforeAll(async () => {
    const mnemonic = process.env.RELAYER_MNEMONIC ?? "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const relayerWallet = await GnoWallet.fromMnemonic(mnemonic, { addressPrefix: "g" });
    const relayerAddr = await relayerWallet.getAddress();

    const provider = await GnoJSONRPCProvider.create(gnoUrl);
    const test1Wallet = await GnoWallet.fromMnemonic(TEST1_SEED, { addressPrefix: "g" });
    test1Wallet.connect(provider);

    await test1Wallet.callMethod(
      "gno.land/r/aib/ibc/core",
      "AddRelayer",
      [relayerAddr],
      TransactionEndpoint.BROADCAST_TX_COMMIT,
      new Map(),
      (new Map()).set("ugnot", 1000000),
      {
        gas_wanted: 90000000n,
        gas_fee: "1000000ugnot",
      },
    );
  });
}
