// The one cron bearer check shared by the cron entrypoint guard and the scheduler verifier.
//
// Grammar: `Authorization: Bearer <token>`, scheme case-insensitive, the first value of a repeated
// header, the presented token trimmed and the configured secret compared as-is. The comparison takes
// the same time for every presented token of the secret's byte length, so a mismatch reveals no
// matching prefix; a token of another byte length (including any non-ASCII one) is refused first.

import { timingSafeEqual } from "node:crypto";

import type { PlatformHttpRequest } from "@openlup/core/platform-runtime";

/** Extract the Bearer token from a request Authorization header (case-insensitive). */
export function bearerToken(req: PlatformHttpRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

/** True when the presented token equals the configured secret, compared in constant time. */
export function cronSecretMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (presentedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
}
