import {
  DirectSecp256k1HdWallet,
} from "@cosmjs/proto-signing";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock keyring for non-browser environment
const mockMnemonic = "test mnemonic word word word word word word word word word word word jolt";
vi.mock("@napi-rs/keyring", () => ({
  Entry: class MockEntry {
    getPassword() { return mockMnemonic; }
    setPassword(password: string) { return; }
    constructor(service: string, account: string) {}
  },
}));

import {
  getSigner,
} from "./signers";

// Helper to reset global window
declare let global: {
  window?: unknown
};

describe("getSigner", () => {
  const chainId = "test-chain";
  let originalWindow: unknown;

  beforeEach(() => {
    originalWindow = global.window;
  });

  afterEach(() => {
    global.window = originalWindow;
    vi.restoreAllMocks();
  });

  it("returns Keplr signer if window.keplr exists", async () => {
    const enable = vi.fn().mockResolvedValue(undefined);
    const offlineSigner = {
      foo: "bar",
    };
    const getOfflineSigner = vi.fn().mockResolvedValue(offlineSigner);
    global.window = {
      keplr: {
        enable,
        getOfflineSigner,
      },
    } as unknown;
    const signer = await getSigner(chainId);
    expect(enable).toHaveBeenCalledWith(chainId);
    expect(getOfflineSigner).toHaveBeenCalledWith(chainId);
    expect(signer).toBe(offlineSigner);
  });

  it("throws if Keplr is not installed", async () => {
    global.window = {
    };
    await expect(getSigner(chainId)).rejects.toThrow("Keplr extension is not installed");
  });

  it("returns DirectSecp256k1HdWallet in non-browser env", async () => {
    global.window = undefined;
    const walletObj = {
      wallet: true,
      getAccounts: vi.fn(),
    };
    const fromMnemonicSpy = vi.spyOn(DirectSecp256k1HdWallet, "fromMnemonic")
      .mockResolvedValue(walletObj as any);

    const signer = await getSigner(chainId);

    expect(fromMnemonicSpy).toHaveBeenCalled();
    expect(signer).toBeDefined();
    expect(signer).toHaveProperty("wallet");
  });
});
