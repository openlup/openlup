/** Shared refusal for host-owned operations without native parity. No partial write is permitted. */
export interface FulfillmentNativeUnsupported {
  readonly kind: 'native_unsupported';
  readonly reason: 'host_binding_required';
  readonly retryable: false;
}
