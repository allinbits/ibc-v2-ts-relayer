/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  DirectSecp256k1HdWallet,
  OfflineSigner,
} from "@cosmjs/proto-signing";
import {
  GnoWallet,
} from "@gnolang/gno-js-client";
import {
  Entry,
} from "@napi-rs/keyring";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ChainType,
} from "../types/index.js";
import {
  getSigner,
} from "./signers.js";

vi.mock("@cosmjs/proto-signing", () => ({
  DirectSecp256k1HdWallet: {
    fromMnemonic: vi.fn(),
  },
}));

vi.mock("@gnolang/gno-js-client", () => ({
  GnoWallet: {
    fromMnemonic: vi.fn(),
  },
}));

vi.mock("@napi-rs/keyring", () => ({
  Entry: vi.fn(),
}));

describe("signers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset window object
    (globalThis as any).window = undefined;
  });

  describe("getSigner - Cosmos chains", () => {
    it("should use Keplr in browser environment", async () => {
      const mockOfflineSigner = {
        getAccounts: vi.fn(),
      } as unknown as OfflineSigner;

      const mockKeplr = {
        enable: vi.fn(),
        getOfflineSigner: vi.fn().mockResolvedValue(mockOfflineSigner),
      };

      (globalThis as any).window = {
        keplr: mockKeplr,
      };

      const signer = await getSigner("cosmoshub-4", ChainType.Cosmos);

      expect(mockKeplr.enable).toHaveBeenCalledWith("cosmoshub-4");
      expect(mockKeplr.getOfflineSigner).toHaveBeenCalledWith("cosmoshub-4");
      expect(signer).toBe(mockOfflineSigner);
    });

    it("should throw error when Keplr is not installed", async () => {
      (globalThis as any).window = {
        keplr: undefined,
      };

      await expect(
        getSigner("cosmoshub-4", ChainType.Cosmos),
      ).rejects.toThrow("Keplr extension is not installed");
    });

    it("should use keyring mnemonic in Node.js environment", async () => {
      const mockMnemonic = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12";
      const mockWallet = {
        getAccounts: vi.fn(),
      } as unknown as DirectSecp256k1HdWallet;

      const mockEntry = {
        getPassword: vi.fn().mockReturnValue(mockMnemonic),
      };

      vi.mocked(Entry).mockImplementation(function (this: any) {
        return mockEntry as any;
      } as any);
      vi.mocked(DirectSecp256k1HdWallet.fromMnemonic).mockResolvedValue(mockWallet);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {
      });

      const signer = await getSigner("cosmoshub-4", ChainType.Cosmos);

      expect(Entry).toHaveBeenCalledWith("mnemonic", "cosmoshub-4");
      expect(mockEntry.getPassword).toHaveBeenCalled();
      expect(DirectSecp256k1HdWallet.fromMnemonic).toHaveBeenCalledWith(
        mockMnemonic,
        undefined,
      );
      expect(signer).toBe(mockWallet);

      consoleSpy.mockRestore();
    });

    it("should pass prefix option to wallet", async () => {
      const mockMnemonic = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12";
      const mockWallet = {
        getAccounts: vi.fn(),
      } as unknown as DirectSecp256k1HdWallet;

      const mockEntry = {
        getPassword: vi.fn().mockReturnValue(mockMnemonic),
      };

      vi.mocked(Entry).mockImplementation(function (this: any) {
        return mockEntry as any;
      } as any);
      vi.mocked(DirectSecp256k1HdWallet.fromMnemonic).mockResolvedValue(mockWallet);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {
      });

      await getSigner("cosmoshub-4", ChainType.Cosmos, {
        prefix: "cosmos",
      });

      expect(DirectSecp256k1HdWallet.fromMnemonic).toHaveBeenCalledWith(
        mockMnemonic,
        {
          prefix: "cosmos",
        },
      );

      consoleSpy.mockRestore();
    });

    it("should throw error when mnemonic not found in keyring", async () => {
      const mockEntry = {
        getPassword: vi.fn().mockReturnValue(null),
      };

      vi.mocked(Entry).mockImplementation(function (this: any) {
        return mockEntry as any;
      } as any);

      await expect(
        getSigner("cosmoshub-4", ChainType.Cosmos),
      ).rejects.toThrow("Mnemonic not found in keyring");
    });
  });

  describe("getSigner - Gno chains", () => {
    it("should throw error in browser environment", async () => {
      (globalThis as any).window = {
      };

      await expect(
        getSigner("test4", ChainType.Gno),
      ).rejects.toThrow("Browser GNO signing not supported yet");
    });

    it("should use keyring mnemonic in Node.js environment", async () => {
      const mockMnemonic = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12";
      const mockWallet = {
        getAccounts: vi.fn(),
      } as unknown as GnoWallet;

      const mockEntry = {
        getPassword: vi.fn().mockReturnValue(mockMnemonic),
      };

      vi.mocked(Entry).mockImplementation(function (this: any) {
        return mockEntry as any;
      } as any);
      vi.mocked(GnoWallet.fromMnemonic).mockResolvedValue(mockWallet);

      const signer = await getSigner("test4", ChainType.Gno);

      expect(Entry).toHaveBeenCalledWith("mnemonic", "test4");
      expect(mockEntry.getPassword).toHaveBeenCalled();
      expect(GnoWallet.fromMnemonic).toHaveBeenCalledWith(
        mockMnemonic,
        {
          addressPrefix: "g",
        },
      );
      expect(signer).toBe(mockWallet);
    });

    it("should use custom prefix for Gno wallet", async () => {
      const mockMnemonic = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12";
      const mockWallet = {
        getAccounts: vi.fn(),
      } as unknown as GnoWallet;

      const mockEntry = {
        getPassword: vi.fn().mockReturnValue(mockMnemonic),
      };

      vi.mocked(Entry).mockImplementation(function (this: any) {
        return mockEntry as any;
      } as any);
      vi.mocked(GnoWallet.fromMnemonic).mockResolvedValue(mockWallet);

      await getSigner("test4", ChainType.Gno, {
        prefix: "gno",
      });

      expect(GnoWallet.fromMnemonic).toHaveBeenCalledWith(
        mockMnemonic,
        {
          addressPrefix: "gno",
        },
      );
    });

    it("should default to 'g' prefix when not provided", async () => {
      const mockMnemonic = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12";
      const mockWallet = {
        getAccounts: vi.fn(),
      } as unknown as GnoWallet;

      const mockEntry = {
        getPassword: vi.fn().mockReturnValue(mockMnemonic),
      };

      vi.mocked(Entry).mockImplementation(function (this: any) {
        return mockEntry as any;
      } as any);
      vi.mocked(GnoWallet.fromMnemonic).mockResolvedValue(mockWallet);

      await getSigner("test4", ChainType.Gno);

      expect(GnoWallet.fromMnemonic).toHaveBeenCalledWith(
        mockMnemonic,
        {
          addressPrefix: "g",
        },
      );
    });

    it("should throw error when mnemonic not found in keyring", async () => {
      const mockEntry = {
        getPassword: vi.fn().mockReturnValue(null),
      };

      vi.mocked(Entry).mockImplementation(function (this: any) {
        return mockEntry as any;
      } as any);

      await expect(
        getSigner("test4", ChainType.Gno),
      ).rejects.toThrow("Mnemonic not found in keyring");
    });

    it("should throw error when mnemonic is empty string", async () => {
      const mockEntry = {
        getPassword: vi.fn().mockReturnValue(""),
      };

      vi.mocked(Entry).mockImplementation(function (this: any) {
        return mockEntry as any;
      } as any);

      await expect(
        getSigner("test4", ChainType.Gno),
      ).rejects.toThrow("Mnemonic not found in keyring");
    });
  });

  describe("getSigner - different chain IDs", () => {
    it("should handle different Cosmos chain IDs", async () => {
      const mockMnemonic = "test mnemonic";
      const mockWallet = {
      } as unknown as DirectSecp256k1HdWallet;

      const mockEntry = {
        getPassword: vi.fn().mockReturnValue(mockMnemonic),
      };

      vi.mocked(Entry).mockImplementation(function (this: any) {
        return mockEntry as any;
      } as any);
      vi.mocked(DirectSecp256k1HdWallet.fromMnemonic).mockResolvedValue(mockWallet);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {
      });

      await getSigner("osmosis-1", ChainType.Cosmos);
      expect(Entry).toHaveBeenCalledWith("mnemonic", "osmosis-1");

      await getSigner("juno-1", ChainType.Cosmos);
      expect(Entry).toHaveBeenCalledWith("mnemonic", "juno-1");

      consoleSpy.mockRestore();
    });
  });
});
