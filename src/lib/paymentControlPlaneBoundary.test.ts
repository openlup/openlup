import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { allMigrations, effectiveGrantMigration, functionNamesWithPrefix } from "../test/effectiveMigration";

const repoRoot = process.cwd();

// The payment-control RPC family, discovered from the corpus rather than listed.
// Until W4a this file checked a hardcoded list of 8 names against exactly two
// frozen migrations. Five family members had been added since and were covered by
// nothing (`apply_before_sub_lock`, `apply_reconciliation_result`,
// `mark_setup_event_processed`, `reopen_interactive_prepared_attempt`,
// `reopen_prepared_attempt_after_absence`), and `apply_result` alone had been
// fully replaced nine times, most recently in 20260827134000 - so the grant shape
// the test read was the June one regardless of what later migrations did.
const paymentControlFunctions = functionNamesWithPrefix("commerce_payment_control_");
const allMigrationSql = allMigrations().map((entry) => entry.content).join("\n");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function isHiddenAccountFile(file: string): boolean {
  const path = relativePath(file);
  return path.startsWith("src/pages/account/") || path.startsWith("src/components/account/");
}

/**
 * Hidden Stripe checkout UI surface (W11.7 Wave C). The configurator entry
 * page mounts `<StripePaymentStep>` and `<PaymentStatusPoller>` behind the
 * `VITE_COMMERCE_STRIPE_CHECKOUT_UI_ENABLED` flag; with the flag off the
 * page renders byte-identically to the pre-Wave-C samples-only flow.
 * `WalletExpressRow` is the up-front Apple Pay / Google Pay tile (Express
 * Checkout Element) on the same hidden payment step — it imports only
 * `useStripePromise` (a thin Stripe.js loader wrapper), no payment-control
 * plane. The allow-list stays narrow so the boundary still catches any
 * payment-control leak into the broader configurator subtree.
 */
function isHiddenStripeCheckoutFile(file: string): boolean {
  const path = relativePath(file);
  return [
    // The checkout-completion lifecycle (extracted from index.tsx so the same
    // money path serves both the public page and the in-account host).
    "src/checkout/machine/useConfiguratorCheckout.ts",
    "src/checkout/adapters/SkomponujPakietStripePayPanel.tsx",
    "src/checkout/adapters/WalletExpressRow.tsx",
  ].includes(path);
}

// The in-account Tpay status/terminal (flag-gated hidden surface) REUSES the
// shared `PaymentStatusPoller` — a PSP-public status component (it takes a
// `fetchStatus` prop; no payment-control plane). Same allowance the configurator's
// hidden Stripe checkout files get, kept narrow to this one file.
function isHiddenAccountOrderTerminalFile(file: string): boolean {
  return new Set([
    "src/pages/account/v2/order/AccountOrderStatusTerminal.tsx",
  ]).has(relativePath(file));
}

// The table pins below match the pg_dump form of the frozen managed schema
// baseline. A tree whose hosted chain carries the platform schema under its own
// migrations, without that baseline file, declares the same tables in another
// form; matching that form by text would need a model of hand-written DDL. There
// the pins do not apply and the runner reports them as skipped, not passed.
const managedBaselinePresent = existsSync(join(repoRoot, "supabase/migrations/00000000000000_platform_schema_baseline.sql"));

describe("payment-control plane boundary", () => {
  it.skipIf(!managedBaselinePresent)("declares the payment-control tables and links the inbound inbox to them", () => {
    // Read from the whole migration corpus, which in this tree starts from the
    // schema baseline, so the pin holds whichever migration now owns the DDL.
    for (const required of [
      "CREATE TABLE public.commerce_payment_intents (",
      "CREATE TABLE public.commerce_payment_attempts (",
      "CREATE TABLE public.commerce_payment_state_transitions (",
      "CREATE TABLE public.commerce_payment_reconciliation_runs (",
      "CREATE TABLE public.inbound_provider_events (",
      "ADD CONSTRAINT inbound_provider_events_payment_intent_id_fkey FOREIGN KEY (payment_intent_id) REFERENCES public.commerce_payment_intents(id)",
      "ON CONFLICT (provider, provider_event_id) DO NOTHING",
    ]) {
      expect(allMigrationSql).toContain(required);
    }
  });

  it("still covers every RPC the hardcoded list used to name", () => {
    // Discovery must never silently shrink: the eight names this boundary was
    // written for stay a floor, whatever the scan finds.
    for (const fn of [
      "commerce_payment_control_create_intent",
      "commerce_payment_control_record_attempt",
      "commerce_payment_control_ingest_event",
      "commerce_payment_control_apply_result",
      "commerce_payment_control_mark_timeout",
      "commerce_payment_control_record_reconciliation",
      "commerce_payment_control_prepare_provider_attempt",
      "commerce_payment_control_finalize_provider_attempt",
    ]) {
      expect(paymentControlFunctions).toContain(fn);
    }
  });

  it("keeps every payment-control RPC unreachable from a browser role", () => {
    for (const fn of paymentControlFunctions) {
      const grants = effectiveGrantMigration(fn).content;
      const escapedFn = escapeRegExp(fn);

      // The default on a new function is EXECUTE for PUBLIC. The seal is the
      // REVOKE, and it must be restated by whichever migration last touched
      // privileges for this function.
      expect(grants).toMatch(
        new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${escapedFn}\\b[^;]*\\bFROM\\s+[^;]*\\bPUBLIC\\b`, "i"),
      );

      // After that REVOKE the only role granted anything is the service role:
      // the RPC is either server-callable or internal-only. A schema dump spells
      // the grant `GRANT ALL`, a hand-written migration `GRANT EXECUTE`.
      const grantedRoles = [...grants.matchAll(new RegExp(
        `GRANT\\s+(?:EXECUTE|ALL(?:\\s+PRIVILEGES)?)\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${escapedFn}\\b[^;]*?\\bTO\\s+([^;]+);`,
        "gi",
      ))].flatMap(([, roles]) => roles.split(",").map((role) => role.trim()));
      expect(grantedRoles.filter((role) => role !== "service_role")).toEqual([]);

      // No migration anywhere, at any point in history, hands a browser role
      // EXECUTE on the money path.
      expect(allMigrationSql).not.toMatch(
        new RegExp(`GRANT\\s+(?:EXECUTE|ALL(?:\\s+PRIVILEGES)?)\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${escapedFn}\\b[^;]*\\bTO\\s+[^;]*\\b(?:PUBLIC|anon|authenticated)\\b`, "i"),
      );
    }
  });

  it("keeps PSP adapters out of direct DB and business-state mutation", () => {
    const adapterFiles = readFiles(join(repoRoot, "server/adapters"))
      .filter((file) => {
        const path = relativePath(file);
        return /^server\/adapters\/(?:noop_payment|stripe|tpay)\//.test(path)
          || path.startsWith("server/adapters/payment");
      })
      .filter((file) => /\.(ts|tsx)$/.test(file));

    const violations = adapterFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [
        /createClient/,
        /supabase/i,
        /commerce_orders/,
        /subscription_cycles/,
        /commerce_payment_control_apply_result/,
      ]
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relativePath(file)} -> ${pattern}`);
    });

    expect(violations).toEqual([]);
  });

  it("does not expose payment-control in the current production UI", () => {
    const uiFiles = [
      ...readFiles(join(repoRoot, "src/pages")),
      ...readFiles(join(repoRoot, "src/components")),
      join(repoRoot, "src/App.tsx"),
      join(repoRoot, "src/main.tsx"),
    ]
      // The application shell is adopter-owned and absent from this tree.
      .filter((file) => existsSync(file))
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => !/\.(test|spec)\./.test(file));

    const violations = uiFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const blockedPatterns = [
        /commerce_payment_control_/,
        /payment-control/,
        /paymentControl/i,
        ...(isHiddenAccountFile(file) || isHiddenStripeCheckoutFile(file)
          ? []
          : [/domains\/payment/]),
      ];
      const allowedHiddenAccountPaymentImports = [
        "paymentRecoveryClient",
        "components/Recovery",
        // The public cross-domain seam (architecture-guardrails convention:
        // contracts/ports/types are the sanctioned segments). It re-exports
        // client-safe capability reads only; payment-control stays blocked by
        // the patterns below either way.
        "contracts",
        ...(relativePath(file) === "src/pages/account/CompletePaymentPage.tsx"
          ? ["components/StripePaymentStep"]
          : []),
      ];
      const hiddenAccountPaymentImports =
        // W11.7 Wave D-4b + checkout-recovery — hidden account files may import
        // the recovery client and the neutral payment contracts (the Stripe
        // Elements wrappers live in `src/checkout/adapters/stripe/`); no
        // payment-control plane leakage.
        isHiddenAccountFile(file) &&
        !isHiddenAccountOrderTerminalFile(file) &&
        new RegExp(
          `domains/payment/(?!${allowedHiddenAccountPaymentImports.join("|")})`,
        ).test(source)
          ? ["hidden account payment import outside paymentRecoveryClient"]
          : [];

      return [
        ...hiddenAccountPaymentImports,
        ...blockedPatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relativePath(file)} -> ${pattern}`),
      ];
    });

    expect(violations).toEqual([]);
  });
});
