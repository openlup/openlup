/**
 * The `/auth/v1/verify` GET link the Auth send-email hook puts in a message.
 *
 * A leaf module on purpose: `scripts/customer-auth-get-verify.ts` builds the same
 * URL to probe the real endpoint, and that probe only catches a token/token_hash
 * flip (#1032/#1034) because it shares this code rather than reimplementing it.
 * The probe is loaded by `node --experimental-strip-types`, which does not
 * rewrite `.js` specifiers, so this file deliberately imports nothing - pulling
 * it out of `authSendEmailHook.ts` is what lets both callers reach it.
 *
 * It replaced `supabase/functions/_shared/auth-verify-url.ts`, which was the
 * shared copy until the Edge tree was retired on 2026-09-04.
 */

function authVerifyType(actionType: string): string {
  return actionType === "email_change_current" || actionType === "email_change_new"
    ? "email_change"
    : actionType;
}

/**
 * Supabase's email GET endpoint reads the hashed token from a raw query
 * separator, so the first byte is percent-encoded to survive a template that
 * would otherwise split on it.
 */
function qpSafeTokenValue(token: string): string {
  if (token.length === 0) return token;
  return `%${token.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}${encodeURIComponent(token.slice(1))}`;
}

export function buildAuthVerifyUrl(authServiceUrl: string, actionType: string, tokenHash: string, redirectTo: string): string {
  const params = new URLSearchParams({ type: authVerifyType(actionType), redirect_to: redirectTo });
  return `${authServiceUrl.replace(/\/+$/, "")}/auth/v1/verify?token=${qpSafeTokenValue(tokenHash)}&${params.toString()}`;
}
