import { importJWK, jwtVerify, type JWK } from "jose";
import type { IdentityVerifierPort, VerifiedPrincipal } from "../../domains/auth/ports.js";

const MAX_JWKS_BYTES = 12_288;
const MAX_TOKEN_BYTES = 8_192;
const MAX_CLAIM_BYTES = 256;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64URL_COORDINATE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JWK_FIELDS = new Set(["alg", "crv", "kid", "kty", "use", "x", "y"]);
type VerificationKey = Awaited<ReturnType<typeof importJWK>>;

export interface CustomerIdentityVerifierConfig {
  audience: string;
  issuer: string;
  jwks: string;
}

interface ExactVerificationJwk extends JWK {
  alg: "ES256";
  crv: "P-256";
  kid: string;
  kty: "EC";
  use: "sig";
  x: string;
  y: string;
}

/**
 * Offline self-host identity adapter. It accepts only configured public ES256
 * keys and never discovers keys, calls an identity provider, or issues tokens.
 */
export function createCustomerIdentityVerifier(
  config: CustomerIdentityVerifierConfig,
): IdentityVerifierPort {
  const issuer = readClaim(config.issuer, "issuer");
  const audience = readClaim(config.audience, "audience");
  const jwks = readJwks(config.jwks);
  let keys: Promise<Map<string, VerificationKey>> | null = null;
  const importedKeys = () => keys ??= Promise.all(
    jwks.map(async (jwk) => [jwk.kid, await importJWK(jwk, "ES256")] as const),
  ).then((entries) => new Map<string, VerificationKey>(entries));

  return {
    async verifyAccessToken(accessToken: string): Promise<VerifiedPrincipal | null> {
      if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > MAX_TOKEN_BYTES) {
        return null;
      }
      const resolvedKeys = await importedKeys();

      try {
        const verified = await jwtVerify(
          accessToken,
          async (header) => {
            if (header.alg !== "ES256" || typeof header.kid !== "string" || !KID.test(header.kid)) {
              throw new Error("customer identity token header rejected");
            }
            const key = resolvedKeys.get(header.kid);
            if (!key) throw new Error("customer identity token key rejected");
            return key;
          },
          { algorithms: ["ES256"], audience, issuer },
        );
        if (typeof verified.payload.sub !== "string" || !UUID.test(verified.payload.sub)) return null;
        return { email: null, emailVerified: false, principalId: verified.payload.sub };
      } catch {
        return null;
      }
    },
  };
}

function readClaim(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_CLAIM_BYTES
    || value.trim() !== value
    || [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`customer identity ${label} configuration is invalid`);
  }
  return value;
}

function readJwks(value: string): ExactVerificationJwk[] {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_JWKS_BYTES) {
    throw new Error("customer identity JWKS configuration is invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("customer identity JWKS configuration is invalid");
  }
  if (!isRecord(parsed) || !hasOnlyFields(parsed, new Set(["keys"])) || !Array.isArray(parsed.keys)) {
    throw new Error("customer identity JWKS configuration is invalid");
  }
  if (parsed.keys.length < 1 || parsed.keys.length > 2) {
    throw new Error("customer identity JWKS configuration is invalid");
  }

  const keys = parsed.keys.map(readJwk);
  if (new Set(keys.map((key) => key.kid)).size !== keys.length) {
    throw new Error("customer identity JWKS configuration is invalid");
  }
  return keys;
}

function readJwk(value: unknown): ExactVerificationJwk {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, JWK_FIELDS)
    || value.kty !== "EC"
    || value.crv !== "P-256"
    || value.alg !== "ES256"
    || value.use !== "sig"
    || typeof value.kid !== "string"
    || !KID.test(value.kid)
    || typeof value.x !== "string"
    || !BASE64URL_COORDINATE.test(value.x)
    || typeof value.y !== "string"
    || !BASE64URL_COORDINATE.test(value.y)
  ) {
    throw new Error("customer identity JWKS configuration is invalid");
  }
  return value as unknown as ExactVerificationJwk;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: Set<string>): boolean {
  return Object.keys(value).every((field) => fields.has(field));
}
