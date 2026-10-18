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
