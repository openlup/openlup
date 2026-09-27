// Deprecated re-exports kept at the old path for the upgrade window.
// openlup-remove-before: openlup-source-preview/9
// eslint-disable-next-line no-restricted-imports -- deprecated re-export of the moved provider UI; removed in openlup-source-preview/9.
export {
  /** @deprecated Moved to src/checkout/adapters/stripe/useStripePromise.ts; removed in openlup-source-preview/9. */
  resetStripePromiseCacheForTests,
  /** @deprecated Moved to src/checkout/adapters/stripe/useStripePromise.ts; removed in openlup-source-preview/9. */
  STRIPE_LOAD_TIMEOUT_MS,
  /** @deprecated Moved to src/checkout/adapters/stripe/useStripePromise.ts; removed in openlup-source-preview/9. */
  type StripeLoaderState,
  /** @deprecated Moved to src/checkout/adapters/stripe/useStripePromise.ts; removed in openlup-source-preview/9. */
  type StripeLoadStatus,
  /** @deprecated Moved to src/checkout/adapters/stripe/useStripePromise.ts; removed in openlup-source-preview/9. */
  useStripeLoader,
  /** @deprecated Moved to src/checkout/adapters/stripe/useStripePromise.ts; removed in openlup-source-preview/9. */
  useStripePromise,
} from "@/checkout/adapters/stripe/useStripePromise";
