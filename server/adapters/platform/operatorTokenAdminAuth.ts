import { createHash, timingSafeEqual } from "node:crypto";

import type {
  AdminAuthorizationResult,
  AdminAuthPort,
  AdminPrincipalRole,
} from "../../domains/auth/ports.js";

const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PlatformOperatorAuthConfig = {
  readonly operatorToken: string;
  readonly operatorId: string;
};

export type PlatformOperatorAllowlistCheck = (principalId: string) => Promise<boolean>;

export type PlatformOperatorAuthConfigResolution =
  | { readonly config: PlatformOperatorAuthConfig; readonly error?: undefined }
  | { readonly config?: undefined; readonly error: "platform_operator_token_required" | "platform_operator_token_invalid" | "platform_operator_id_required" | "platform_operator_id_invalid" };

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Validate the direct-bundle operator identity before an auth port is constructed. */
export function resolvePlatformOperatorAuthConfig(
  env: Record<string, string | undefined>,
): PlatformOperatorAuthConfigResolution {
  const operatorToken = env.PLATFORM_OPERATOR_TOKEN?.trim() ?? "";
  if (!operatorToken) return { error: "platform_operator_token_required" };
  const tokenBytes = byteLength(operatorToken);
  if (tokenBytes < MIN_TOKEN_BYTES || tokenBytes > MAX_TOKEN_BYTES) {
    return { error: "platform_operator_token_invalid" };
  }

  const operatorId = env.PLATFORM_OPERATOR_ID?.trim() ?? "";
  if (!operatorId) return { error: "platform_operator_id_required" };
  if (!UUID_PATTERN.test(operatorId)) return { error: "platform_operator_id_invalid" };
  return { config: { operatorToken, operatorId: operatorId.toLowerCase() } };
}

function matchesOperatorToken(candidate: string | null, expected: string): boolean {
  if (!candidate || byteLength(candidate) > MAX_TOKEN_BYTES) return false;
  const actualDigest = createHash("sha256").update(candidate, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

/**
 * Direct-bundle AdminAuthPort backed by an opaque operator token and a durable
 * operator allowlist. The checker is reached only after token and role checks.
 */
export function createOperatorTokenAdminAuth(
  config: PlatformOperatorAuthConfig,
  isOperatorAllowed: PlatformOperatorAllowlistCheck,
): AdminAuthPort {
  return {
    async authorize(
      accessToken: string | null,
      options: { allowedRoles?: readonly AdminPrincipalRole[] } = {},
    ): Promise<AdminAuthorizationResult> {
      if (!matchesOperatorToken(accessToken, config.operatorToken)) {
        return { ok: false, code: "UNAUTHORIZED", message: "Admin session required" };
      }
      if (options.allowedRoles && !options.allowedRoles.includes("admin")) {
        return { ok: false, code: "FORBIDDEN", message: "Admin role required" };
      }
      if (!(await isOperatorAllowed(config.operatorId))) {
        return { ok: false, code: "FORBIDDEN", message: "Admin role required" };
      }
      return {
        ok: true,
        principalId: config.operatorId,
        role: "admin",
        isMachineActor: true,
      };
    },
  };
}
