import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectStandaloneGraph, packageRoot, packageSmokeFiles, packageSourceFiles, repoRel } from "./standaloneImportGraph.js";

const graphEntrypoints = [
  "smoke/catalogStandalone.test.ts",
  "smoke/checkoutStandalone.test.ts",
  "smoke/companyIdentityStandalone.test.ts",
  "smoke/fulfillmentStandalone.test.ts",
  "smoke/inventoryStandalone.test.ts",
  "smoke/marketingResearchStandalone.test.ts",
  "smoke/partnersStandalone.test.ts",
  "smoke/paymentStandalone.test.ts",
  "smoke/platformRuntimeStandalone.test.ts",
  "smoke/pricingStandalone.test.ts",
  "smoke/promoStandalone.test.ts",
  "smoke/riskStandalone.test.ts",
  "smoke/shippingStandalone.test.ts",
  "smoke/standaloneGraph.test.ts",
  "smoke/subscriptionBundleStandalone.test.ts",
  "smoke/testingStandalone.test.ts",
];

const expectedSmokeFiles = [
  ...graphEntrypoints,
  "smoke/nullAdapters.ts",
  "smoke/standaloneImportGraph.ts",
  "smoke/stubBrand.ts",
].sort();

const expectedCoreFiles = [
  "src/bundle/contracts.ts",
  "src/bundle/ports.ts",
  "src/catalog/identifiers.ts",
  "src/catalog/index.ts",
  "src/checkout/index.ts",
  "src/checkout/idempotency.ts",
  "src/company-identity/contracts.ts",
  "src/company-identity/index.ts",
  "src/company-identity/ports.ts",
  "src/fulfillment/facts.ts",
  "src/fulfillment/index.ts",
  "src/inventory/atp.ts",
  "src/inventory/index.ts",
  "src/marketing/research/contracts.ts",
  "src/marketing/research/index.ts",
  "src/marketing/research/ports.ts",
  "src/partners/index.ts",
  "src/partners/ports.ts",
  "src/partners/status.ts",
  "src/payment/index.ts",
  "src/payment/executionBaseContracts.ts",
  "src/payment/paymentControlTypes.ts",
  "src/payment/paymentStateMachine.ts",
  "src/payment/providerAttemptIdempotency.ts",
  "src/platform-runtime/contracts.ts",
  "src/platform-runtime/index.ts",
  "src/platform-runtime/platformKernel.ts",
  "src/platform-runtime/ports.ts",
  "src/pricing/index.ts",
  "src/pricing/ports.ts",
  "src/pricing/pricingBreakdown.ts",
  "src/pricing/types.ts",
  "src/promo/index.ts",
  "src/promo/promoEvaluator.ts",
  "src/promo/types.ts",
  "src/risk/core/evaluator.ts",
  "src/risk/core/rules.ts",
  "src/risk/core/types.ts",
  "src/risk/index.ts",
  "src/risk/types.ts",
  "src/shipping/index.ts",
  "src/shipping/shippingResolver.ts",
  "src/shipping/types.ts",
  "src/subscription/subscriptionEngineCore.ts",
  "src/subscription/subscriptionEngineLifecycle.ts",
  "src/subscription/subscriptionEnginePayment.ts",
];

describe("standalone core import graph", () => {
  it("keeps the smoke graph free of provider, brand, and env coupling", () => {
    const { files, violations } = inspectStandaloneGraph(graphEntrypoints);
    const relFiles = files.map(repoRel);

    expect(packageSmokeFiles().map(repoRel).sort()).toEqual(expectedSmokeFiles);
    expect(relFiles).toEqual(expect.arrayContaining(expectedCoreFiles));
    expect(violations).toEqual([]);
  });

  it("keeps every package source file standalone-safe for a future split", () => {
    const sourceEntryPoints = packageSourceFiles().map(repoRel).sort();
    const { files, violations } = inspectStandaloneGraph(sourceEntryPoints);

    expect(files.map(repoRel).sort()).toEqual(sourceEntryPoints);
    expect(violations).toEqual([]);
  });

  it("fails closed when core imports a provider SDK, app accounting, or a deep self path", () => {
    const fixture = join(packageRoot, "src/subscription/reviewerLeak.ts");
    const appAccountingPath = [
      "..",
      "..",
      "..",
      "..",
      "server",
      "domains",
      "accounting",
      "accountingInvoiceDeliveryJob",
    ].join("/");
    const resolvedAccountingPath = [
      "..",
      "..",
      "server",
      "domains",
      "accounting",
      "accountingInvoiceDeliveryJob.ts",
    ].join("/");
    const importKeyword = "im" + "port";
    const fromKeyword = "fr" + "om";
    const [providerIdentifier, providerSpecifier] = [["Str", "ipe"], ["str", "ipe"]].map((parts) => parts.join(""));
    const deepSelfSpecifier = "@openlup/core/subscription/internal";
    const accountingTargetExists = existsSync(join(
      packageRoot,
      "..",
      "..",
      "server",
      "domains",
      "accounting",
      "accountingInvoiceDeliveryJob.ts",
    ));
    const accountingViolation = accountingTargetExists
      ? `src/subscription/reviewerLeak.ts imports outside standalone graph ${appAccountingPath} -> ${resolvedAccountingPath}`
      : `src/subscription/reviewerLeak.ts imports unresolved specifier ${appAccountingPath}`;
    const { violations } = inspectStandaloneGraph(
      [repoRel(fixture)],
      new Map([
        [
          fixture,
          [
            `${importKeyword} { createInvoice } ${fromKeyword} '${appAccountingPath}';`,
            `${importKeyword} ${providerIdentifier} ${fromKeyword} '${providerSpecifier}';`,
            `${importKeyword} { hidden } ${fromKeyword} '${deepSelfSpecifier}';`,
            `export const leak = [createInvoice, ${providerIdentifier}, hidden];`,
          ].join("\n"),
        ],
      ]),
    );

    expect(violations).toEqual([
      accountingViolation,
      `src/subscription/reviewerLeak.ts imports disallowed bare specifier ${providerSpecifier}`,
      `src/subscription/reviewerLeak.ts imports disallowed bare specifier ${deepSelfSpecifier}`,
    ]);
  });
});
