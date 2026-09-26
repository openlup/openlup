import {
  buildProviderAttemptIdentity as buildCoreProviderAttemptIdentity,
  isProviderAttemptReplaySafe,
  type ProviderAttemptIdentity,
  type ProviderAttemptIdentityInput as CoreProviderAttemptIdentityInput,
} from "@openlup/core/payment";

const OPENLUP_PROVIDER_ATTEMPT_NAMESPACE = "openlup";

export type ProviderAttemptIdentityInput = Omit<CoreProviderAttemptIdentityInput, "namespace">;
export type { ProviderAttemptIdentity };

export function buildProviderAttemptIdentity(
  input: ProviderAttemptIdentityInput,
): ProviderAttemptIdentity {
  return buildCoreProviderAttemptIdentity({
    ...input,
    namespace: OPENLUP_PROVIDER_ATTEMPT_NAMESPACE,
  });
}

export { isProviderAttemptReplaySafe };
