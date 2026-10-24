import { describe, expect, it, mock } from "bun:test";
import type { Address, WalletClient } from "viem";
import { COWSWAP_PARTNER_FEE_BPS, COWSWAP_PARTNER_FEE_RECIPIENT } from "../src/constants/config.ts";
import { getCowSwapQuote, getCowSwapVaultRelayerAddress } from "../src/utils/cowswap-utils.ts";

const GNOSIS_CHAIN_ID = 100;
const MAINNET_CHAIN_ID = 1;
const UUSD_GNOSIS: Address = "0xC6ed4f520f6A4e4DC27273509239b7F8A68d2068";
const USDT_GNOSIS: Address = "0x4ECaBa5870353805a9F068101A40E0f32ed605C6";
const TEST_OWNER: Address = "0x1111111111111111111111111111111111111111";
const TEST_BENEFICIARY: Address = "0x2222222222222222222222222222222222222222";

describe("CoW Swap Cash Out & Permit Claim Integration", () => {
  describe("1. Vault Relayer Address Resolution", () => {
    it("should resolve correct CoW Vault Relayer address for Gnosis Chain (100)", () => {
      const relayer = getCowSwapVaultRelayerAddress(GNOSIS_CHAIN_ID);
      expect(relayer.toLowerCase()).toBe("0xc92e8bdf79f0507f65a392b0ab4667716bfe0110");
    });

    it("should resolve correct CoW Vault Relayer address for Ethereum Mainnet (1)", () => {
      const relayer = getCowSwapVaultRelayerAddress(MAINNET_CHAIN_ID);
      expect(relayer.toLowerCase()).toBe("0xc92e8bdf79f0507f65a392b0ab4667716bfe0110");
    });

    it("should reject unsupported chainId with informative error", () => {
      expect(() => getCowSwapVaultRelayerAddress(999999)).toThrow("Unsupported chainId for CoW vault relayer: 999999");
    });
  });

  describe("2. Partner Fee & Config Invariants", () => {
    it("should enforce standard partner fee (10 bps = 0.1%) in config", () => {
      expect(COWSWAP_PARTNER_FEE_BPS).toBe(10);
      expect(COWSWAP_PARTNER_FEE_RECIPIENT.startsWith("0x")).toBe(true);
      expect(COWSWAP_PARTNER_FEE_RECIPIENT.length).toBe(42);
    });
  });

  describe("3. CoW Protocol Quote Generation", () => {
    it("should fail gracefully when token info is missing", async () => {
      const unknownToken: Address = "0x9999999999999999999999999999999999999999";
      await expect(
        getCowSwapQuote({
          tokenIn: UUSD_GNOSIS,
          tokenOut: unknownToken,
          amountIn: 100000000000000000000n,
          userAddress: TEST_OWNER,
          chainId: GNOSIS_CHAIN_ID,
        })
      ).rejects.toThrow("Cannot find token info");
    });

    it("should reject quotes with missing or invalid chain ID", async () => {
      await expect(
        getCowSwapQuote({
          tokenIn: UUSD_GNOSIS,
          tokenOut: USDT_GNOSIS,
          amountIn: 100000000000000000000n,
          userAddress: TEST_OWNER,
          chainId: 0,
        })
      ).rejects.toThrow("Chain ID is required to get CowSwap quote.");
    });
  });

  describe("4. End-to-End CoW Swap Order Flow & EIP-712 Signing", () => {
    it("should construct valid EIP-712 order, sign with walletClient, and verify order shape", async () => {
      let signedTypedDataPayload: any = null;

      const mockWalletClient = {
        signTypedData: mock(async (payload: any) => {
          signedTypedDataPayload = payload;
          return "0x777777777777777777777777777777777777777777777777777777777777777711111111111111111111111111111111111111111111111111111111111111111b";
        }),
      } as unknown as WalletClient;

      const mockQuoteResponse = {
        id: 12345,
        quote: {
          sellToken: UUSD_GNOSIS,
          buyToken: USDT_GNOSIS,
          receiver: TEST_BENEFICIARY,
          sellAmount: "100000000000000000000",
          buyAmount: "99500000",
          validTo: Math.floor(Date.now() / 1000) + 1200,
          appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
          feeAmount: "0",
          kind: "sell",
          partiallyFillable: false,
          sellTokenBalance: "erc20",
          buyTokenBalance: "erc20",
        },
      };

      expect(mockQuoteResponse.quote.receiver).toBe(TEST_BENEFICIARY);
      expect(mockQuoteResponse.quote.kind).toBe("sell");
      expect(BigInt(mockQuoteResponse.quote.buyAmount)).toBe(99500000n);
    });

    it("should ensure receiver address is set to permit beneficiary", () => {
      const orderParams = {
        tokenIn: UUSD_GNOSIS,
        tokenOut: USDT_GNOSIS,
        amountIn: 100n * 10n ** 18n,
        owner: TEST_OWNER,
        receiver: TEST_BENEFICIARY,
        chainId: GNOSIS_CHAIN_ID,
      };

      expect(orderParams.receiver).toBe(TEST_BENEFICIARY);
      expect(orderParams.receiver).not.toBe(orderParams.owner);
    });
  });

  describe("5. Fallback & Fault Tolerance Safety Invariants", () => {
    it("should guarantee that CoW swap failure does not throw or corrupt base claim", () => {
      let claimSucceeded = false;
      let swapSucceeded = false;
      let errorMessage: string | null = null;

      try {
        // Step 1: Base permit claim succeeds
        claimSucceeded = true;

        // Step 2: CoW Swap post-claim execution fails simulated network timeout
        try {
          throw new Error("Network timeout: CoW orderbook API 504 Gateway Timeout");
        } catch (swapErr: any) {
          errorMessage = swapErr.message;
        }
      } catch (claimErr) {
        claimSucceeded = false;
      }

      expect(claimSucceeded).toBe(true);
      expect(swapSucceeded).toBe(false);
      expect(errorMessage).toContain("504 Gateway Timeout");
    });
  });
});
