type HiddenSurfaceEnv = Partial<Record<string, string | boolean | undefined>>;

export const PUBLIC_HIDDEN_SURFACES_FLAG = "VITE_PUBLIC_HIDDEN_SURFACES_ENABLED";
export const CUSTOMER_ACCOUNT_UI_FLAG = "VITE_COMMERCE_V2_W12_CUSTOMER_AUTH_UI";
export const ADMIN_OMS_UI_FLAG = "VITE_ADMIN_OMS_UI_ENABLED";
export const ACCOUNT_ORDER_FLOW_FLAG = "VITE_ACCOUNT_ORDER_FLOW_ENABLED";
export const ADMIN_RISK_UI_FLAG = "VITE_ADMIN_RISK_UI_ENABLED";
export const PUBLIC_HOMEPAGE_PERSONALIZATION_FLAG = "VITE_PUBLIC_HOMEPAGE_PERSONALIZATION_ENABLED";

export const HIDDEN_SURFACE_PATHS = [
  "/v2",
  "/en/v2",
  "/skomponuj-pakiet",
  "/skomponuj-pakiet/dziekujemy",
  "/skomponuj-pakiet/platnosc-nieudana",
  "/skomponuj-pakiet/platnosc",
  "/skomponuj-pakiet/tpay-simulator",
  "/build-your-box",
  "/build-your-box/thank-you",
  "/build-your-box/payment-failed",
  "/build-your-box/payment",
  "/build-your-box/tpay-simulator",
  "/zrob-puszke",
  "/your-dog-on-a-can",
] as const;

export const CUSTOMER_ACCOUNT_SURFACE_PATHS = [
  "/zaloguj-sie",
  "/sign-in",
  "/konto/auth/callback",
  "/account/auth/callback",
  "/konto",
  "/account",
  "/konto/platnosc/napraw",
  "/account/payment/recover",
] as const;

export const ADMIN_OMS_SURFACE_PATHS = [
  "/admin/orders",
  "/admin/dunning-recovery",
] as const;

export const ADMIN_RISK_SURFACE_PATHS = [
  "/admin/risk",
] as const;

export function isHiddenSurfaceAccessAllowed(
  env: HiddenSurfaceEnv = import.meta.env,
): boolean {
  return isTrue(env[PUBLIC_HIDDEN_SURFACES_FLAG]);
}

export function isCustomerAccountSurfaceAllowed(
  env: HiddenSurfaceEnv = import.meta.env,
): boolean {
  return isHiddenSurfaceAccessAllowed(env) && isTrue(env[CUSTOMER_ACCOUNT_UI_FLAG]);
}

export function isAdminOmsSurfaceAllowed(
  env: HiddenSurfaceEnv = import.meta.env,
): boolean {
  return isHiddenSurfaceAccessAllowed(env) && isTrue(env[ADMIN_OMS_UI_FLAG]);
}

/**
 * In-account ordering gate. Lets a logged-in customer compose and order a
 * package from inside the V2 account (pet picker → confirm → configurator).
 * Requires the customer-account surface AND its own flag. Off by default.
 */
export function isAccountOrderFlowEnabled(
  env: HiddenSurfaceEnv = import.meta.env,
): boolean {
  return isCustomerAccountSurfaceAllowed(env) && isTrue(env[ACCOUNT_ORDER_FLOW_FLAG]);
}

/**
 * Admin risk-review UI gate. Requires hidden-surface access AND its own flag so
 * the /admin/risk queue stays hidden until explicitly enabled. Off by default.
 */
export function isAdminRiskSurfaceAllowed(
  env: HiddenSurfaceEnv = import.meta.env,
): boolean {
  return isHiddenSurfaceAccessAllowed(env) && isTrue(env[ADMIN_RISK_UI_FLAG]);
}

function isTrue(value: string | boolean | undefined): boolean {
  return value === true || value === "true";
}

/**
 * Build-time gate for the /v2 hero personalization variant. Off by default; when
 * on, the hero fetches the personalization bundle and renders a personalized
 * headline for recognised returning visitors (else the generic headline). The
 * server generation + endpoint have their own (server-side) flag; this only
 * governs the client render.
 */
export function isHomepagePersonalizationEnabled(
  env: HiddenSurfaceEnv = import.meta.env,
): boolean {
  return isTrue(env[PUBLIC_HOMEPAGE_PERSONALIZATION_FLAG]);
}
