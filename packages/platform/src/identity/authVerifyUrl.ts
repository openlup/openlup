import type { HttpRequest } from "../http/index.js";

function authVerifyType(actionType: string): string {
  return actionType === "email_change_current" || actionType === "email_change_new"
    ? "email_change"
    : actionType;
}


function qpSafeTokenValue(token: string): string {
  if (token.length === 0) return token;
  return `%${token.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}${encodeURIComponent(token.slice(1))}`;
}

export function buildAuthVerifyUrl(authServiceUrl: string, actionType: string, tokenHash: string, redirectTo: string): string {
  const params = new URLSearchParams({ type: authVerifyType(actionType), redirect_to: redirectTo });
  return `${authServiceUrl.replace(/\/+$/, "")}/auth/v1/verify?token=${qpSafeTokenValue(tokenHash)}&${params.toString()}`;
}

/** Only configured HTTP(S) origins authorize the default magic-link destination. */
export function createMagicLinkOriginResolver(
  configuredOrigins: readonly string[],
): (req: HttpRequest) => string | null {
  const origins = configuredOrigins.map(normalizeOrigin);
  const origin = origins.length > 0 && origins.every((value) => value !== null)
    ? (origins[0] ?? null)
    : null;
  return () => origin;
}

function normalizeOrigin(value: string): string | null {
  const candidate = value.trim();
  // URL parsing alone accepts paths, credentials and repaired backslashes.
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Invalid return targets use the callback's default landing page. */
export function normalizeMagicLinkReturnPath(value: string | undefined, origin: string): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return undefined;
  // Reject encoded separators, controls and nested escapes before any later decoding.
  if (value.includes("\\") || Array.from(value).some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f) || /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f|25)/i.test(value)) return undefined;
  try {
    const url = new URL(value, origin);
    if (url.origin !== new URL(origin).origin || url.pathname.startsWith("//")) return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}
