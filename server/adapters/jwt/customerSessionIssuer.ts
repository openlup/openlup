import { importJWK, SignJWT, type JWK } from "jose";
import type { CustomerSessionIssuerPort } from "../../domains/auth/ports.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;

export interface CustomerSessionIssuerConfig {
  audience: string;
  issuer: string;
  keyId: string;
  privateJwk: string;
  ttlSeconds: number;
}

export function createCustomerSessionIssuer(
  config: CustomerSessionIssuerConfig,
): CustomerSessionIssuerPort {
  const audience = claim(config.audience, "audience");
  const issuer = claim(config.issuer, "issuer");
  if (!KID.test(config.keyId)) throw new Error("customer session key id configuration is invalid");
  if (!Number.isInteger(config.ttlSeconds) || config.ttlSeconds < 300 || config.ttlSeconds > 86_400) {
    throw new Error("customer session ttl configuration is invalid");
  }
  const key = importPrivateKey(config.privateJwk);

  return {
    async issue({ principalId, email }) {
      if (!UUID.test(principalId)) throw new Error("customer session principal is invalid");
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail || normalizedEmail.length > 320) {
        throw new Error("customer session email is invalid");
      }
      const issuedAt = Math.floor(Date.now() / 1000);
      const expiresAt = issuedAt + config.ttlSeconds;
      const accessToken = await new SignJWT({ email: normalizedEmail, email_verified: true })
        .setProtectedHeader({ alg: "ES256", kid: config.keyId, typ: "JWT" })
        .setSubject(principalId)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .sign(await key);
      return { accessToken, expiresAt: new Date(expiresAt * 1000).toISOString() };
    },
  };
}

function importPrivateKey(value: string) {
  if (!value || value.length > 16_384) throw new Error("customer session private JWK configuration is invalid");
  let parsed: JWK;
  try {
    parsed = JSON.parse(value) as JWK;
  } catch {
    throw new Error("customer session private JWK configuration is invalid");
  }
  if (parsed.kty !== "EC" || parsed.crv !== "P-256" || parsed.alg !== "ES256" || typeof parsed.d !== "string") {
    throw new Error("customer session private JWK configuration is invalid");
  }
  return importJWK(parsed, "ES256");
}

function claim(value: string, label: string): string {
  if (!value || value.length > 256 || value.trim() !== value) {
    throw new Error(`customer session ${label} configuration is invalid`);
  }
  return value;
}
