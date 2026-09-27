import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const repoRoot = process.cwd();
const hiddenCommerceEndpointPattern =
  /\/api\/bff\/(?:commerce\/(?:configurator-intent|recommendation|quote|order-draft|checkout|checkout-resume(?:\/[A-Za-z0-9_-]+)?)|admin\/commerce\/(?:orders(?:\/(?:detail|hold|release-hold|note|update-shipping-address))?|runtime\/(?:start|payment-result))|admin\/inventory\/(?:stock|reservations|atp-check|stock-adjustment)|admin\/fulfillment\/commerce-orders(?:\/(?:detail|create|record-provider-attempt|record-label|record-tracking-event|hand-off|cancel))?)\b/;
const hiddenCustomerEndpointPattern = /\/api\/bff\/customers\/(?:me|magic-link|preferences|addresses)\b/;
const hiddenAddressCanonEndpointPattern =
  /\/api\/bff\/address-canon\/(?:postal-code|localities|streets)\b/;
const hiddenProviderEndpointPattern =
  /\/api\/bff\/(?:(?:payment\/webhooks\/(?:stripe|tpay))|(?:webhooks\/(?:stripe|tpay)\/payment)|admin\/accounting(?:\/|$))/;

function readFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return readFiles(fullPath);
    return [fullPath];
  });
}

function relativePath(file: string): string {
  return relative(repoRoot, file).split(sep).join("/");
}

function isHiddenConfiguratorFile(file: string): boolean {
  const path = relativePath(file);
  // Line γ moved the checkout machine to `src/checkout/**`; the exemption follows the same
  // files rather than being widened - the configurator page tree keeps its half.
  return path.startsWith("src/pages/skomponuj-pakiet/") || path.startsWith("src/checkout/");
}

// The post-delivery review form (Wave 5) is an intentionally PUBLIC customer
// surface: anonymous, token-gated (noindex), reached from the review-request
// marketing email. It legitimately calls the commerce order-feedback client
// (the public submit_order_feedback path), so it is exempt from the
// hidden-commerce-surface guardrail like the configurator above.
function isReviewFormFile(file: string): boolean {
  return new Set([
    "src/pages/OrderReviewPage.tsx",
    "src/pages/ReviewPage.tsx",
  ]).has(relativePath(file));
}

function isHiddenAccountFile(file: string): boolean {
  const path = relativePath(file);
  return path.startsWith("src/pages/account/") || path.startsWith("src/components/account/");
}

// The in-account Tpay status page/terminal (flag-gated hidden surface, behind
// the account order flow) is the cream sibling of the public configurator's
// PlatnoscPage: it legitimately imports the commerce client to poll
// payment-status + drive the staging simulator, exactly like the configurator
// above. The abandoned-checkout recovery pay-page (W4) is the same kind of
// hidden surface: token-authenticated (no login), flag-gated behind
// COMMERCE_CHECKOUT_RECOVERY_ENABLED, it imports the checkout-recovery client +
// the commerce payment-status client to re-pay an existing order. The W5
// in-account CTA hook is the same hidden surface from the other direction: it
// imports the checkout-recovery client only to mint a token + deep-link into
// that pay-page. Same hidden-surface exemption, kept narrow to these files.
function isHiddenAccountOrderTerminalFile(file: string): boolean {
  return new Set([
    "src/pages/account/v2/order/AccountOrderStatusPage.tsx",
    "src/pages/account/v2/order/AccountOrderStatusTerminal.tsx",
    "src/pages/account/CompletePaymentPage.tsx",
    "src/pages/account/v2/lib/useCheckoutRecoveryCta.ts",
    // Orders-list CTA hook: same as useCheckoutRecoveryCta but keyed by orderId
    // (one-time / subscription first-cycle) — mints a token + deep-links to the
    // recovery pay-page. Same narrow hidden-surface exemption.
    "src/pages/account/v2/lib/useCompleteOrderPaymentCta.ts",
    // Recovery pay-page internals: the hook drives the redeem/pay/poll + Tpay
    // simulator, the picker reads the Tpay channel contract — same hidden surface.
    "src/pages/account/useCheckoutRecoveryPay.ts",
    "src/pages/account/useCheckoutRecoveryPaymentSubmission.ts",
    "src/pages/account/checkoutRecoveryEntry.ts",
    "src/pages/account/useCheckoutRecoveryProviderUi.ts",
    "src/pages/account/checkoutRecoveryPolling.ts",
    "src/pages/account/checkoutRecoveryUiState.ts",
    "src/pages/account/CheckoutRecoveryMethodPicker.tsx",
  ]).has(relativePath(file));
}

// The admin panel is a private operator surface (behind ProtectedRoute + admin
// auth, treated as a private path by Analytics below), not customer-visible UI.
// Admin commerce tooling (e.g. the "Rabaty" discounts editor) legitimately
// imports the commerce domain, so admin files are outside this guardrail.
function isAdminFile(file: string): boolean {
  const path = relativePath(file);
  return path.startsWith("src/pages/admin/") || path.startsWith("src/components/admin/");
}

// Admin OMS preview brought a few non-admin-dir files (e.g. src/App.tsx) into
// the commerce import surface; keep its explicit allowlist alongside the broad
// admin exemption above.
function isAdminOmsPreviewFile(file: string): boolean {
  const path = relativePath(file);
  return new Set([
    "src/App.tsx",
    "src/components/admin/AdminLayout.tsx",
    "src/pages/admin/DashboardPage.tsx",
    "src/pages/admin/OrderDetailBlocks.tsx",
    "src/pages/admin/OrderDetailSections.tsx",
    "src/pages/admin/OrderDetailSheet.tsx",
    "src/pages/admin/OrdersPage.tsx",
    "src/pages/admin/OrdersPageTable.tsx",
    "src/pages/admin/ordersPageUtils.ts",
  ]).has(path);
}

function isPublicCommerceMarketingFile(file: string): boolean {
  const path = relativePath(file);
  return new Set([
    "src/components/product/NotifyMeWhenInStock.tsx",
    // These public acquisition surfaces consume the read-only, product-only
    // active-offer projection. They never call a transactional checkout route
    // or synthesize a customer amount in the browser.
    "src/components/product/ProductOfferCard.tsx",
    "src/pages/v2/sections/StarterPlanBlock.tsx",
  ]).has(path);
}

function importSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /import\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
    /export\s+(?:type\s+)?[^"']+\s+from\s+["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specs.add(match[1]);
    }
  }

  return [...specs];
}

describe("ecommerce hidden UI guardrails", () => {
  it("keeps hidden commerce surfaces out of customer-visible UI", () => {
    const uiRuntimeFiles = [
      ...readFiles(join(repoRoot, "src/pages")),
      ...readFiles(join(repoRoot, "src/components")),
      join(repoRoot, "src/App.tsx"),
      join(repoRoot, "src/main.tsx"),
    ]
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => !/\.(test|spec)\./.test(file))
      .filter((file) => !isHiddenConfiguratorFile(file))
      .filter((file) => !isHiddenAccountOrderTerminalFile(file))
      .filter((file) => !isReviewFormFile(file))
      .filter((file) => !isAdminFile(file))
      .filter((file) => !isAdminOmsPreviewFile(file))
      .filter((file) => !isPublicCommerceMarketingFile(file));

    const violations = uiRuntimeFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const commerceImports = importSpecifiers(source).filter((specifier) => {
        // This hidden-terminal storage helper needs only the canonical response
        // shapes. Keep the exemption to that exact type module so any future
        // commerce/runtime import or endpoint string still fails this guard.
        if (
          relativePath(file) === "src/pages/account/checkoutRecoveryStripeSession.ts"
          && specifier === "@/domains/commerce/checkoutRecoveryContracts"
        ) return false;
        // Explicit DEV-only optional reference-adapter route. Keep this exemption
        // to its exact client import so endpoint, provider, and other commerce
        // guardrails remain active for the page.
        if (
          relativePath(file) === "src/pages/ReferenceStorePage.tsx"
          && specifier === "@/domains/commerce/referenceCommerceClient"
        ) return false;
        if (/^@\/domains\/commerce(?:\/|$)/.test(specifier)) return true;
        if (/^@\/domains\/inventory(?:\/|$)/.test(specifier)) return true;
        if (/^@\/domains\/fulfillment\/commerceFulfillment/.test(specifier)) return true;
        if (/^@\/domains\/address-canon(?:\/|$)/.test(specifier)) return true;
        if (specifier === "@/data/commercePriceBook") return true;
        if (!specifier.startsWith(".")) return false;

        const resolved = relativePath(join(dirname(file), specifier));
        return (
          resolved.startsWith("src/domains/commerce/") ||
          resolved.startsWith("src/domains/inventory/") ||
          resolved.startsWith("src/domains/fulfillment/commerceFulfillment") ||
          resolved.startsWith("src/domains/address-canon/") ||
          resolved === "src/data/commercePriceBook"
        );
      });
      const endpointUsage = hiddenCommerceEndpointPattern.test(source)
        ? ["hidden commerce endpoint string"]
        : [];
      const customerEndpointUsage =
        !isHiddenAccountFile(file) && hiddenCustomerEndpointPattern.test(source)
          ? ["hidden customer endpoint string"]
          : [];
      const addressCanonEndpointUsage = hiddenAddressCanonEndpointPattern.test(source)
        ? ["hidden address canon endpoint string"]
        : [];
      const providerEndpointUsage = hiddenProviderEndpointPattern.test(source)
        ? ["hidden provider/accounting endpoint string"]
        : [];

      return [
        ...commerceImports,
        ...endpointUsage,
        ...customerEndpointUsage,
        ...addressCanonEndpointUsage,
        ...providerEndpointUsage,
      ].map((violation) => `${relativePath(file)} -> ${violation}`);
    });

    expect(violations).toEqual([]);
  });

  it("keeps current marketing and static public runtime free of hidden provider domains", () => {
    const staticRuntimeFiles = [
      ...readFiles(join(repoRoot, "src/pages")),
      ...readFiles(join(repoRoot, "src/components")),
      ...readFiles(join(repoRoot, "src/data")),
    ]
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => !/\.(test|spec)\./.test(file))
      .filter((file) => !isHiddenConfiguratorFile(file))
      .filter((file) => !isHiddenAccountFile(file))
      .filter((file) => !isAdminFile(file))
      .filter((file) => !isAdminOmsPreviewFile(file))
      .filter((file) => !isPublicCommerceMarketingFile(file));

    const violations = staticRuntimeFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return importSpecifiers(source)
        .filter((specifier) =>
          /domains\/(?:payment|accounting)/.test(specifier) ||
          /(?:stripe|tpay|fakturownia|omnipack)/i.test(specifier),
        )
        .map((specifier) => `${relativePath(file)} -> ${specifier}`);
    });

    expect(violations).toEqual([]);
  });

  it("keeps analytics out of hidden private, customer account, and capability paths", () => {
    const analytics = readFileSync(join(repoRoot, "src/components/Analytics.tsx"), "utf8");
    const routePolicy = readFileSync(join(repoRoot, "src/lib/analytics/routePolicy.ts"), "utf8");

    expect(analytics).toContain('from "@/lib/analytics/routePolicy"');
    expect(analytics).toContain("const excludedPath = !isGtmAnalyticsRouteEligible(pathname)");
    expect(routePolicy).toContain('"/admin"');
    expect(routePolicy).toContain('"/konto"');
    expect(routePolicy).toContain('"/zaloguj-sie"');
    expect(routePolicy).toContain('"/moja-opinia"');
    expect(routePolicy).toContain('"/review"');
    expect(analytics).toContain("const granted = !excludedPath && hasAnalyticsConsent");
    expect(analytics).toContain("!excludedPath &&");
    expect(analytics).toContain("pushAnalyticsEvent(\"page_view\"");
  });
});
