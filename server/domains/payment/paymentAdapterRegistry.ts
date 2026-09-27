// Deprecated re-exports kept at the old path for the upgrade window.
// openlup-remove-before: openlup-source-preview/9
// eslint-disable-next-line no-restricted-imports -- deprecated re-export of the moved runtime registry; removed in openlup-source-preview/9.
export {
  /** @deprecated Moved to server/runtime/payment/paymentAdapterRegistry.ts; removed in openlup-source-preview/9. */
  getPaymentExecutionAdapter,
  /** @deprecated Moved to server/runtime/payment/paymentAdapterRegistry.ts; removed in openlup-source-preview/9. */
  NoopSettlementNotAllowedError,
  /** @deprecated Moved to server/runtime/payment/paymentAdapterRegistry.ts; removed in openlup-source-preview/9. */
  UnknownPaymentProviderError,
} from "../../runtime/payment/paymentAdapterRegistry.js";
