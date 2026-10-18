import {
  createManagedEmailTrustPolicy, createVerifierResultOnlyEmailTrustPolicy,
  parseEmailVerifyingProviders, type EmailTrustPolicy,
} from "@openlup/platform/identity";
import { resolveBundleId } from "@openlup/platform/kernel";

type Env = Record<string, string | undefined>;
type ManagedEnv = { url: string; anonKey: string };
/** Host-lifetime cache; a changed origin, key or declaration replaces the binding. */
let binding: { url: string; key: string; providers: string; policy: EmailTrustPolicy } | undefined;
export function bindIdentityEmailTrust(env: Env, managed?: ManagedEnv): EmailTrustPolicy {
  if (resolveBundleId(env) === "node-postgres") return createVerifierResultOnlyEmailTrustPolicy();
  if (!managed) throw new Error("Identity email-trust settings are not configured");
  return bindManagedIdentityEmailTrust(env, managed);
}
export function bindManagedIdentityEmailTrust(env: Env, managed: ManagedEnv): EmailTrustPolicy {
  const providers = parseEmailVerifyingProviders(env.IDENTITY_EMAIL_VERIFYING_PROVIDERS ?? "").join(",");
  if (!binding || binding.url !== managed.url || binding.key !== managed.anonKey || binding.providers !== providers) {
    binding = { url: managed.url, key: managed.anonKey, providers, policy: createManagedEmailTrustPolicy({
      authBaseUrl: managed.url, publicKey: managed.anonKey, emailVerifyingProviders: providers ? providers.split(",") : [],
    }) };
  }
  return binding.policy;
}
