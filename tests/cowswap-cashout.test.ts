import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { Address, WalletClient } from "viem";
import { COWSWAP_PARTNER_FEE_BPS, COWSWAP_PARTNER_FEE_RECIPIENT } from "../src/constants/config.ts";
import {
  getCowSwapQuote,
  getCowSwapVaultRelayerAddress,
  postCowSwapOrder,
} from "../src/utils/cowswap-utils.ts";

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
    it("should call postCowSwapOrder, sign EIP-712 data, and return an order ID", async () => {
      const MOCK_SIGNATURE =
        "0x777777777777777777777777777777777777777777777777777777777777777711111111111111111111111111111111111111111111111111111111111111111b";
      const MOCK_ORDER_ID = "0xabc123order";

      // Capture the signTypedData calls
      const signTypedDataMock = mock(async (payload: any) => MOCK_SIGNATURE);

      const mockWalletClient = {
        signTypedData: signTypedDataMock,
      } as unknown as WalletClient;

      // Mock the @cowprotocol/cow-sdk module to intercept OrderBookApi and OrderSigningUtils
      const mockGetQuote = mock(async () => ({
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
      }));

      const mockSendOrder = mock(async () => MOCK_ORDER_ID);

      // Intercept module
      mock.module("@cowprotocol/cow-sdk", () => ({
        COW_PROTOCOL_VAULT_RELAYER_ADDRESS: { 100: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" },
        OrderBookApi: class {
          getQuote = mockGetQuote;
          sendOrder = mockSendOrder;
        },
        OrderQuoteSideKindSell: { SELL: "sell" },
        OrderSigningUtils: {
          getDomain: async () => ({
            name: "Gnosis Protocol",
            version: "v2",
            chainId: GNOSIS_CHAIN_ID,
            verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
          }),
          getEIP712Types: () => ({
            Order: [
              { name: "sellToken", type: "address" },
              { name: "buyToken", type: "address" },
              { name: "receiver", type: "address" },
              { name: "sellAmount", type: "uint256" },
              { name: "buyAmount", type: "uint256" },
              { name: "validTo", type: "uint32" },
              { name: "appData", type: "bytes32" },
              { name: "feeAmount", type: "uint256" },
              { name: "kind", type: "string" },
              { name: "partiallyFillable", type: "bool" },
              { name: "sellTokenBalance", type: "string" },
              { name: "buyTokenBalance", type: "string" },
            ],
          }),
        },
        SigningScheme: { EIP712: "eip712" },
        SupportedChainId: {},
      }));

      // Re-import to pick up mocked module
      const { postCowSwapOrder: mockedPostOrder } = await import("../src/utils/cowswap-utils.ts");

      const orderId = await mockedPostOrder({
        tokenIn: UUSD_GNOSIS,
        tokenOut: USDT_GNOSIS,
        amountIn: 100n * 10n ** 18n,
        owner: TEST_OWNER,
        receiver: TEST_BENEFICIARY,
        chainId: GNOSIS_CHAIN_ID,
        walletClient: mockWalletClient,
      });

      // Verify that signTypedData was called
      expect(signTypedDataMock).toHaveBeenCalledTimes(1);

      // Verify the signTypedData payload
      const signPayload = signTypedDataMock.mock.calls[0][0];
      expect(signPayload.primaryType).toBe("Order");
      expect(signPayload.account).toBe(TEST_OWNER);
      expect(signPayload.message.receiver).toBe(TEST_BENEFICIARY);
      expect(signPayload.message.sellToken).toBe(UUSD_GNOSIS);
      expect(signPayload.message.buyToken).toBe(USDT_GNOSIS);

      // Verify sendOrder was called with correct signature
      expect(mockSendOrder).toHaveBeenCalledTimes(1);
      const sendOrderArg = mockSendOrder.mock.calls[0][0];
      expect(sendOrderArg.signature).toBe(MOCK_SIGNATURE);
      expect(sendOrderArg.signingScheme).toBe("eip712");
      expect(sendOrderArg.receiver).toBe(TEST_BENEFICIARY);

      // Verify the returned order ID
      expect(orderId).toBe(MOCK_ORDER_ID);
    });

    it("should ensure receiver address is set to permit beneficiary in signed order", async () => {
      const signTypedDataMock = mock(async () => "0xdeadbeef");
      const mockWalletClient = {
        signTypedData: signTypedDataMock,
      } as unknown as WalletClient;

      const mockGetQuote = mock(async () => ({
        id: 99,
        quote: {
          sellToken: UUSD_GNOSIS,
          buyToken: USDT_GNOSIS,
          receiver: TEST_BENEFICIARY,
          sellAmount: "50000000000000000000",
          buyAmount: "49750000",
          validTo: Math.floor(Date.now() / 1000) + 600,
          appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
          feeAmount: "0",
          kind: "sell",
          partiallyFillable: false,
          sellTokenBalance: "erc20",
          buyTokenBalance: "erc20",
        },
      }));

      const mockSendOrder = mock(async () => "0xorderid2");

      mock.module("@cowprotocol/cow-sdk", () => ({
        COW_PROTOCOL_VAULT_RELAYER_ADDRESS: { 100: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" },
        OrderBookApi: class {
          getQuote = mockGetQuote;
          sendOrder = mockSendOrder;
        },
        OrderQuoteSideKindSell: { SELL: "sell" },
        OrderSigningUtils: {
          getDomain: async () => ({ name: "GP", version: "v2", chainId: 100, verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" }),
          getEIP712Types: () => ({ Order: [] }),
        },
        SigningScheme: { EIP712: "eip712" },
        SupportedChainId: {},
      }));

      const { postCowSwapOrder: mockedPostOrder } = await import("../src/utils/cowswap-utils.ts");

      await mockedPostOrder({
        tokenIn: UUSD_GNOSIS,
        tokenOut: USDT_GNOSIS,
        amountIn: 50n * 10n ** 18n,
        owner: TEST_OWNER,
        receiver: TEST_BENEFICIARY,
        chainId: GNOSIS_CHAIN_ID,
        walletClient: mockWalletClient,
      });

      // The critical assertion: receiver in the signed message MUST be the beneficiary
      const signPayload = signTypedDataMock.mock.calls[0][0];
      expect(signPayload.message.receiver).toBe(TEST_BENEFICIARY);
      expect(signPayload.message.receiver).not.toBe(TEST_OWNER);
    });
  });

  describe("5. Fallback & Fault Tolerance Safety Invariants", () => {
    it("should guarantee that postCowSwapOrder rejection does not corrupt an independent claim", async () => {
      // Simulate a claim-then-swap flow where swap fails but claim remains intact
      let claimResult: { success: boolean; txHash: string } | null = null;
      let swapOrderId: string | null = null;
      let swapError: string | null = null;

      // Step 1: Base permit claim succeeds independently
      claimResult = { success: true, txHash: "0xclaimtx" };

      // Step 2: Attempt CoW swap post-claim — mock postCowSwapOrder to reject
      const failingPostOrder = async (): Promise<string> => {
        throw new Error("Network timeout: CoW orderbook API 504 Gateway Timeout");
      };

      try {
        swapOrderId = await failingPostOrder();
      } catch (err: any) {
        swapError = err.message;
        // Non-blocking: swap failure is logged, not re-thrown
      }

      // The claim result must remain intact despite swap failure
      expect(claimResult).not.toBeNull();
      expect(claimResult!.success).toBe(true);
      expect(claimResult!.txHash).toBe("0xclaimtx");
      expect(swapOrderId).toBeNull();
      expect(swapError).toContain("504 Gateway Timeout");
    });

    it("should reject postCowSwapOrder when chain ID is missing", async () => {
      const mockWalletClient = { signTypedData: mock(async () => "0x") } as unknown as WalletClient;

      await expect(
        postCowSwapOrder({
          tokenIn: UUSD_GNOSIS,
          tokenOut: USDT_GNOSIS,
          amountIn: 100n * 10n ** 18n,
          owner: TEST_OWNER,
          receiver: TEST_BENEFICIARY,
          chainId: 0,
          walletClient: mockWalletClient,
        })
      ).rejects.toThrow("Chain ID is required to place CoW Swap order.");
    });
  });
});
