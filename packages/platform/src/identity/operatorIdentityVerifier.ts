import { createCustomerIdentityVerifier } from "./customerIdentityVerifier.js";
import type { IdentityJwtLibraryLoader } from "./jwtLibrary.js";
import type { IdentityVerifierPort } from "./ports.js";
export function createOperatorIdentityVerifier(config: { issuer: string; audience: string; customerAudience: string; jwks: string }, loadJwt: IdentityJwtLibraryLoader): IdentityVerifierPort {
  if (!config.customerAudience.trim() || config.audience === config.customerAudience) throw new Error("operator_audience_must_be_distinct");
  // Inspect the payload returned by the same cryptographic verification, never an unverified decode.
  return createCustomerIdentityVerifier(config, async () => {
    const library = await loadJwt();
    return { ...library, async jwtVerify(token, key, options) {
      const verified = await library.jwtVerify(token, key, options);
      const payload = verified.payload as Record<string, unknown>;
      const { iat, exp } = payload;
      if (payload.aud !== config.audience || typeof iat !== "number" || typeof exp !== "number"
        || !Number.isInteger(iat) || !Number.isInteger(exp) || exp <= iat || exp - iat > 900
        || iat > Math.floor(Date.now() / 1000) || exp <= Math.floor(Date.now() / 1000)) throw new Error("operator_token_profile_invalid");
      return verified;
    } };
  });
}
