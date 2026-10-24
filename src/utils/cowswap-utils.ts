import {
  COW_PROTOCOL_VAULT_RELAYER_ADDRESS,
  OrderBookApi,
  OrderQuoteSideKindSell,
  OrderSigningUtils,
  SigningScheme,
  SupportedChainId,
  type QuoteAmountsAndCosts,
} from "@cowprotocol/cow-sdk";
import type { Address, WalletClient } from "viem";
import { getTokenInfo } from "../constants/supported-reward-tokens.ts";

export interface CowSwapQuoteParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  userAddress: Address;
  chainId: number;
}

export interface CowSwapQuoteResult {
  estimatedAmountOut: bigint;
  feeAmount?: bigint;
  amountsAndCosts: QuoteAmountsAndCosts;
}

export interface PostCowSwapOrderParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  owner: Address;
  receiver: Address;
  chainId: number;
  walletClient: WalletClient;
}

/**
 * Resolves the CoW Protocol Vault Relayer contract address for a given chain.
 * The Vault Relayer is the contract that the user must approve for ERC-20 token
 * spending before submitting CoW Swap orders.
 * @param chainId - The EVM chain ID (e.g., 1 for Ethereum Mainnet, 100 for Gnosis).
 * @returns The Vault Relayer contract address as a checksummed hex string.
 * @throws If the chain ID is not supported by the CoW Protocol SDK.
 */
export function getCowSwapVaultRelayerAddress(chainId: number): Address {
  const address = COW_PROTOCOL_VAULT_RELAYER_ADDRESS[chainId as SupportedChainId];
  if (!address) {
    throw new Error(`Unsupported chainId for CoW vault relayer: ${chainId}`);
  }
  return address as Address;
}

/**
 * Fetches a sell-side quote from the CoW Protocol OrderBook API.
 * Validates that both input and output tokens are recognized on the given chain,
 * then queries the CoW orderbook for expected buy amounts and fee estimates.
 * @param params - Quote parameters including token addresses, sell amount, user address, and chain ID.
 * @returns A promise resolving to the estimated buy amount, fee amount, and full amounts-and-costs breakdown.
 * @throws If chain ID is falsy, or if either token address is not found in the supported-tokens registry.
 */
export async function getCowSwapQuote(params: CowSwapQuoteParams): Promise<CowSwapQuoteResult> {
  if (!params.chainId) {
    throw new Error("Chain ID is required to get CowSwap quote.");
  }

  const tokenInInfo = getTokenInfo(params.chainId, params.tokenIn);
  const tokenOutInfo = getTokenInfo(params.chainId, params.tokenOut);

  if (!tokenInInfo || !tokenOutInfo) {
    throw new Error(`Cannot find token info for ${params.tokenIn} or ${params.tokenOut} on chain ${params.chainId}`);
  }

  const orderBookApi = new OrderBookApi({ chainId: params.chainId as SupportedChainId });

  const quoteResponse = await orderBookApi.getQuote({
    kind: OrderQuoteSideKindSell.SELL,
    sellToken: params.tokenIn,
    buyToken: params.tokenOut,
    from: params.userAddress,
    receiver: params.userAddress,
    sellAmountBeforeFee: params.amountIn.toString(),
  });

  const estimatedAmountOut = BigInt(quoteResponse.quote.buyAmount);
  const feeAmount = BigInt(quoteResponse.quote.feeAmount);

  return {
    estimatedAmountOut,
    feeAmount,
    amountsAndCosts: {
      feeAmount: quoteResponse.quote.feeAmount,
      buyAmount: quoteResponse.quote.buyAmount,
      sellAmount: quoteResponse.quote.sellAmount,
    } as unknown as QuoteAmountsAndCosts,
  };
}

/**
 * Submits a signed CoW Protocol sell order to the OrderBook API.
 * Obtains a fresh quote, constructs the EIP-712 order struct with the provided
 * receiver, signs it via the caller's wallet client, and posts the signed order
 * to the CoW orderbook for settlement.
 * @param params - Order parameters including token pair, amounts, owner/receiver addresses,
 *                 chain ID, and a viem WalletClient for EIP-712 signing.
 * @returns A promise resolving to the CoW Protocol order ID (UID) string.
 * @throws If chain ID is falsy, if either token is unrecognized, or if signing/submission fails.
 */
export async function postCowSwapOrder(params: PostCowSwapOrderParams): Promise<string> {
  if (!params.chainId) {
    throw new Error("Chain ID is required to place CoW Swap order.");
  }

  const tokenInInfo = getTokenInfo(params.chainId, params.tokenIn);
  const tokenOutInfo = getTokenInfo(params.chainId, params.tokenOut);

  if (!tokenInInfo || !tokenOutInfo) {
    throw new Error(`Cannot find token info for ${params.tokenIn} or ${params.tokenOut} on chain ${params.chainId}`);
  }

  const orderBookApi = new OrderBookApi({ chainId: params.chainId as SupportedChainId });

  const quoteResponse = await orderBookApi.getQuote({
    kind: OrderQuoteSideKindSell.SELL,
    sellToken: params.tokenIn,
    buyToken: params.tokenOut,
    from: params.owner,
    receiver: params.receiver,
    sellAmountBeforeFee: params.amountIn.toString(),
  });

  const quote = quoteResponse.quote;
  const domain = (await OrderSigningUtils.getDomain(params.chainId as SupportedChainId)) as unknown as Parameters<typeof params.walletClient.signTypedData>[0]["domain"];
  const types = OrderSigningUtils.getEIP712Types() as unknown as Parameters<typeof params.walletClient.signTypedData>[0]["types"];

  const orderToSign = {
    sellToken: quote.sellToken,
    buyToken: quote.buyToken,
    receiver: params.receiver,
    sellAmount: quote.sellAmount,
    buyAmount: quote.buyAmount,
    validTo: quote.validTo,
    appData: quote.appData,
    feeAmount: quote.feeAmount,
    kind: quote.kind,
    partiallyFillable: quote.partiallyFillable,
    sellTokenBalance: quote.sellTokenBalance,
    buyTokenBalance: quote.buyTokenBalance,
  };

  const signature = await params.walletClient.signTypedData({
    account: params.owner,
    domain,
    types,
    primaryType: "Order",
    message: orderToSign,
  });

  const orderId = await orderBookApi.sendOrder({
    ...orderToSign,
    signature,
    signingScheme: SigningScheme.EIP712,
  });

  return orderId;
}
