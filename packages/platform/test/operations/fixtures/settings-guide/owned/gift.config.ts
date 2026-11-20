const wrapFeeMinor = 150;
if (!Number.isSafeInteger(wrapFeeMinor) || wrapFeeMinor < 0) {
  throw Error("gift.wrapFeeMinor requires whole nonnegative minor units.");
}
export const gift = { wrapFeeMinor };
export const quoteGiftOrderMinor = (subtotal: number, wrap: boolean) =>
  subtotal + (wrap ? gift.wrapFeeMinor : 0);
