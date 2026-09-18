import { describe, expect, it } from "vitest";
import {
  ADMIN_OMS_SURFACE_PATHS,
  ADMIN_RISK_SURFACE_PATHS,
  CUSTOMER_ACCOUNT_SURFACE_PATHS,
  HIDDEN_SURFACE_PATHS,
  isAccountOrderFlowEnabled,
  isAdminOmsSurfaceAllowed,
  isAdminRiskSurfaceAllowed,
  isCustomerAccountSurfaceAllowed,
  isHiddenSurfaceAccessAllowed,
} from "./hiddenSurfaceAccess";

describe("hidden surface access", () => {
  it("blocks hidden customer-facing surfaces by default", () => {
    expect(isHiddenSurfaceAccessAllowed({})).toBe(false);
    expect(isCustomerAccountSurfaceAllowed({})).toBe(false);
    expect(isAdminOmsSurfaceAllowed({})).toBe(false);
    expect(isAdminRiskSurfaceAllowed({})).toBe(false);
  });

  it("requires the public hidden-surface flag before account UI can register", () => {
    expect(isCustomerAccountSurfaceAllowed({
      VITE_COMMERCE_V2_W12_CUSTOMER_AUTH_UI: "true",
    })).toBe(false);

    expect(isCustomerAccountSurfaceAllowed({
      VITE_PUBLIC_HIDDEN_SURFACES_ENABLED: "true",
      VITE_COMMERCE_V2_W12_CUSTOMER_AUTH_UI: "true",
    })).toBe(true);
  });

  it("requires the public hidden-surface flag before admin OMS can register", () => {
    expect(isAdminOmsSurfaceAllowed({
      VITE_ADMIN_OMS_UI_ENABLED: "true",
    })).toBe(false);

    expect(isAdminOmsSurfaceAllowed({
      VITE_PUBLIC_HIDDEN_SURFACES_ENABLED: "true",
      VITE_ADMIN_OMS_UI_ENABLED: "true",
    })).toBe(true);
  });

  it("gates in-account ordering behind the account surface AND its own flag", () => {
    // Off by default.
    expect(isAccountOrderFlowEnabled({})).toBe(false);
    // The order-flow flag alone is not enough — the account surface must be allowed.
    expect(isAccountOrderFlowEnabled({
      VITE_ACCOUNT_ORDER_FLOW_ENABLED: "true",
    })).toBe(false);
    // Account surface allowed but order flow off → account dashboard stays in overview mode.
    expect(isAccountOrderFlowEnabled({
      VITE_PUBLIC_HIDDEN_SURFACES_ENABLED: "true",
      VITE_COMMERCE_V2_W12_CUSTOMER_AUTH_UI: "true",
    })).toBe(false);
    // All three on → in-account order flow enabled.
    expect(isAccountOrderFlowEnabled({
      VITE_PUBLIC_HIDDEN_SURFACES_ENABLED: "true",
      VITE_COMMERCE_V2_W12_CUSTOMER_AUTH_UI: "true",
      VITE_ACCOUNT_ORDER_FLOW_ENABLED: "true",
    })).toBe(true);
  });

  it("requires the public hidden-surface flag before admin risk review can register", () => {
    expect(isAdminRiskSurfaceAllowed({
      VITE_ADMIN_RISK_UI_ENABLED: "true",
    })).toBe(false);

    expect(isAdminRiskSurfaceAllowed({
      VITE_PUBLIC_HIDDEN_SURFACES_ENABLED: "true",
      VITE_ADMIN_RISK_UI_ENABLED: "true",
    })).toBe(true);
  });

  it("pins every new hidden PL/EN surface for smoke coverage", () => {
    expect(HIDDEN_SURFACE_PATHS).toContain("/build-your-box/payment");
    expect(HIDDEN_SURFACE_PATHS).toContain("/your-dog-on-a-can");
    expect(CUSTOMER_ACCOUNT_SURFACE_PATHS).toContain("/account/payment/recover");
    expect(ADMIN_OMS_SURFACE_PATHS).toContain("/admin/orders");
    expect(ADMIN_RISK_SURFACE_PATHS).toContain("/admin/risk");
  });
});
