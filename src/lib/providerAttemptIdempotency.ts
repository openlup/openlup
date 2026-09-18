import {
  buildProviderAttemptIdentity as buildCoreProviderAttemptIdentity,
  isProviderAttemptReplaySafe,
  type ProviderAttemptIdentity,
  type ProviderAttemptIdentityInput as CoreProviderAttemptIdentityInput,
} from "@openlup/core/payment";

const openlup_PROVIDER_ATTEMPT_NAMESPACE = "openlup";

export type ProviderAttemptIdentityInput = Omit<CoreProviderAttemptIdentityInput, "namespace">;
export type { ProviderAttemptIdentity };

export function buildProviderAttemptIdentity(
  input: ProviderAttemptIdentityInput,
): ProviderAttemptIdentity {
  return buildCoreProviderAttemptIdentity({
    ...input,
    namespace: openlup_PROVIDER_ATTEMPT_NAMESPACE,
  });
}

export { isProviderAttemptReplaySafe };
