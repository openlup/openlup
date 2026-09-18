/**
 * Central registry for build-time preview/config feature flags read on the
 * frontend. Every flag here follows one shape: a `VITE_*` env value that is
 * "true"/not, with a `MODE !== "production"` test override so specs can flip it
 * via a `globalThis.__openlup_TEST_*` global without rebuilding.
 *
 * Why one module: the same 8-line accessor was copy-pasted across nine helper
 * files (and drifted into a few raw `import.meta.env` reads). Collapsing them
 * onto {@link makePreviewFlag} leaves one place to inspect "how is a flag read",
 * and the `architectureGuardrails` guard bans new raw flag reads outside this
 * module and `hiddenSurfaceAccess.ts`.
 *
 * IMPORTANT: env is read via dynamic object access on `import.meta.env` (same as
 * `hiddenSurfaceAccess.ts`, proven on built hidden-preview deploys). Vite bakes
 * `import.meta.env` into a literal object in the bundle, so computed access
 * (`env[envKey]`) reads from that baked object at runtime. Do NOT refactor this to
 * `import.meta.env.VITE_LITERAL` per flag — Vite only statically inlines literal
 * member access, so vitest would pass while a built deploy still reads from the
 * object correctly here; the risk is the reverse (hand-rolling literals reintroduces
 * the per-file drift). The dynamic read keeps every flag working from one factory.
 *
 * Diagnostic activation hooks below are a narrow exception: literal production
 * checks let Vite erase both the lazy feature and its key factory when disabled.
 * Their non-production arm still uses the shared factory and live test override.
 *
 * These flags do NOT change semantics here: the preview-only gating (many of
 * these `VITE_*` keys live in `scripts/guard-hidden-sandbox-preview-env.mjs`
 * HIDDEN_ACTIVATION_FLAGS and fail-closed in production) is unchanged — only the
 * read mechanics are consolidated.
 */


import { createCustomerJourneyActionKey } from "./diagnostics/customerJourneyActionKey";

declare global {
  // eslint-disable-next-line no-var
  var __openlup_TEST_CATALOG_ADMIN__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_CONFIGURATOR_CHECKOUT_REDESIGN: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_DHL_ONLY_DELIVERY__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_INPOST_GEOWIDGET__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_STRIPE_CHECKOUT_UI__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_TPAY_CHECKOUT_SCAFFOLDING__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_TPAY_BLIK_MODEL_O__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_TPAY_SIMULATOR_UI__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_TPAY_ONE_CLICK_UI__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_SUBSCRIPTION_CHECKOUT_CONTRACT__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_PLATFORM_ALERTS_ADMIN__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_OFFER_POLICY_V2_CAPABILITY__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __openlup_TEST_BUNDLE_ADMIN__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __TEST_CUSTOMER_DIAGNOSTIC_HISTORY__: boolean | undefined;
}


/**
 * Build a preview-flag accessor. Reads the test-override global first (only when
 * not a production build), otherwise the `VITE_*` env value compared to "true".
 *
 * @param envKey       the `import.meta.env` key (e.g. "VITE_COMMERCE_...")
 * @param testGlobalKey the `globalThis.__openlup_TEST_*` override key
 */
export function makePreviewFlag(envKey: string, testGlobalKey: string): () => boolean {
  return () => {
    if (import.meta.env.MODE !== "production") {
      const override = (globalThis as unknown as Record<string, boolean | undefined>)[testGlobalKey];
      if (override !== undefined) {
        return override === true;
      }
    }
    return (import.meta.env as Record<string, string | undefined>)[envKey] === "true";
  };
}

/** Admin "Katalog" (agent-operable catalog) preview surface. */
export const catalogAdminEnabled = makePreviewFlag(
  "VITE_COMMERCE_CATALOG_ADMIN_ENABLED",
  "__openlup_TEST_CATALOG_ADMIN__",
);

/**
 * Admin "Pakiety" (bundle configurator) preview surface — the human head of the
 * agent-operable bundle domain shipped in program waves A1-A4. Gates the
 * `/admin/bundles` route and its nav entry; the BFF routes behind it carry their
 * own server-side `COMMERCE_BUNDLE_*` gates, so this flag hides a surface rather
 * than granting one.
 */
export const bundleAdminEnabled = makePreviewFlag(
  "VITE_COMMERCE_BUNDLE_ADMIN_ENABLED",
  "__openlup_TEST_BUNDLE_ADMIN__",
);

/** Admin shell platform-alerts surface (health pill + notification bell). */
export const platformAlertsAdminEnabled = makePreviewFlag(
  "VITE_PLATFORM_ALERTS_ADMIN_ENABLED",
  "__openlup_TEST_PLATFORM_ALERTS_ADMIN__",
);

/** Krok 5/6 checkout redesign preview: purchase-mode tiles (subskrypcja /
 * jednorazowe / pakiet startowy) + condensed step-6 package recap. */
export const configuratorCheckoutRedesignEnabled = makePreviewFlag(
  "VITE_COMMERCE_CONFIGURATOR_CHECKOUT_REDESIGN",
  "__openlup_TEST_CONFIGURATOR_CHECKOUT_REDESIGN",
);

/** The standalone direct-DHL checkout fallback is permanently retired. */
export const dhlOnlyDeliveryEnabled = () => false;

/**
 * Official InPost Geowidget v5 map picker for parcel lockers. When on (and a
 * `VITE_INPOST_GEOWIDGET_KEY` is present) the InPost tile in Step 5 offers a
 * map-based locker chooser; otherwise the token-free list search is used.
 */
export const inpostGeowidgetEnabled = makePreviewFlag(
  "VITE_INPOST_GEOWIDGET_ENABLED",
  "__openlup_TEST_INPOST_GEOWIDGET__",
);

/** Stripe checkout UI (card + wallets). */
export const stripeCheckoutUiEnabled = makePreviewFlag(
  "VITE_COMMERCE_STRIPE_CHECKOUT_UI_ENABLED",
  "__openlup_TEST_STRIPE_CHECKOUT_UI__",
);

/** Tpay checkout scaffolding. */
export const tpayCheckoutScaffoldingEnabled = makePreviewFlag(
  "VITE_PAYMENTS_TPAY_CHECKOUT_SCAFFOLDING",
  "__openlup_TEST_TPAY_CHECKOUT_SCAFFOLDING__",
);

/**
 * Single public switch for new subscription BLIK Model O activation.
 *
 * It controls both the subscription BLIK offer and its mandatory bank picker.
 * One-time Tpay methods and renewals of already stored Model O mandates do not
 * depend on it.
 */
export const tpayBlikModelOEnabled = makePreviewFlag(
  "VITE_PAYMENTS_TPAY_BLIK_MODEL_O_ENABLED",
  "__openlup_TEST_TPAY_BLIK_MODEL_O__",
);

/** Tpay simulator UI. */
export const tpaySimulatorUiEnabled = makePreviewFlag(
  "VITE_PAYMENTS_TPAY_SIMULATOR_UI",
  "__openlup_TEST_TPAY_SIMULATOR_UI__",
);

/** Tpay one-click UI. */
export const tpayOneClickUiEnabled = makePreviewFlag(
  "VITE_PAYMENTS_TPAY_ONE_CLICK_UI",
  "__openlup_TEST_TPAY_ONE_CLICK_UI__",
);

/**
 * W11 subscription checkout contract: routes the configurator checkout through
 * the subscription contract when a subscription bundle is selected. Previously
 * read raw via `import.meta.env.VITE_COMMERCE_V2_W11_SUBSCRIPTION_CHECKOUT_CONTRACT_ENABLED`
 * in three sites with no test override — now a first-class accessor.
 */
export const subscriptionCheckoutContractEnabled = makePreviewFlag(
  "VITE_COMMERCE_V2_W11_SUBSCRIPTION_CHECKOUT_CONTRACT_ENABLED",
  "__openlup_TEST_SUBSCRIPTION_CHECKOUT_CONTRACT__",
);

/** Client can preserve a server-authored v2 policy assignment. Default off. */
export const offerPolicyV2CapabilityEnabled = makePreviewFlag(
  "VITE_COMMERCE_OFFER_POLICY_V2_CAPABILITY_ENABLED",
  "__openlup_TEST_OFFER_POLICY_V2_CAPABILITY__",
);

/**
 * Browser-to-server diagnostic history. Default off.
 *
 * The production build gate deliberately uses the literal Vite key here. It
 * lets a disabled production build erase producer-side dynamic imports from
 * the hot bootstrap and configurator chunks. Non-production keeps the
 * registry's normal live test override behavior.
 */
export const customerDiagnosticHistoryBuildEnabled = import.meta.env.MODE !== "production"
  || import.meta.env.VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED === "true";

export const customerDiagnosticHistoryEnabled = import.meta.env.MODE === "production"
  ? () => import.meta.env.VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED === "true"
  : /* @__PURE__ */ makePreviewFlag(
    "VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED",
    "__TEST_CUSTOMER_DIAGNOSTIC_HISTORY__",
  );

/** Synchronous feature activation hook; observation data stays with the caller. */
export const createCustomerDiagnosticActionKeyWhenEnabled = import.meta.env.MODE === "production"
  ? import.meta.env.VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED === "true"
    ? createCustomerJourneyActionKey
    : null
  : () => customerDiagnosticHistoryEnabled() ? createCustomerJourneyActionKey() : undefined;

/**
 * Lazily loads the reporter after the diagnostics feature gate passes.
 *
 * The literal production check keeps the default-off reporter out of hot
 * chunks; callers retain ownership of their observations and credentials.
 */
export type CustomerDiagnosticReporter = typeof import("./diagnostics/customerJourneyReporter");
export type CustomerDiagnosticReporterLoader = () => Promise<CustomerDiagnosticReporter | null> | null;

export const loadCustomerDiagnosticReporterWhenEnabled: CustomerDiagnosticReporterLoader | null = import.meta.env.MODE === "production"
  ? import.meta.env.VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED === "true"
    ? () => import("./diagnostics/customerJourneyReporter").catch(() => null)
    : null
  : () => customerDiagnosticHistoryEnabled()
    ? import("./diagnostics/customerJourneyReporter").catch(() => null)
    : null;

export {};
