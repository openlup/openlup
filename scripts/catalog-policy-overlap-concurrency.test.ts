import { describe, it } from "vitest";

import {
  runCatalogPolicyOverlapConcurrencyProof,
  runCatalogPolicyOverlapIsolationRefusalProof,
} from "./catalog-policy-overlap-concurrency.js";

const connectionString = process.env.CATALOG_POLICY_CONCURRENCY_DATABASE_URL;
const bundle = process.env.CATALOG_POLICY_CONCURRENCY_BUNDLE;

describe("catalog policy overlap concurrency", () => {
  if (!connectionString || (bundle !== "managed" && bundle !== "portable")) {
    it.skip("requires CATALOG_POLICY_CONCURRENCY_DATABASE_URL and CATALOG_POLICY_CONCURRENCY_BUNDLE");
    return;
  }

  it(`refuses two concurrent overlapping ${bundle} policy writes`, async () => {
    await runCatalogPolicyOverlapConcurrencyProof({ connectionString, bundle });
  }, 15_000);

  it(`refuses ${bundle} policy writes under REPEATABLE READ before overlap evaluation`, async () => {
    await runCatalogPolicyOverlapIsolationRefusalProof({ connectionString, bundle });
  }, 15_000);
});
