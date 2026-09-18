import { createFakturowniaAccountingDocumentProvider } from "../../adapters/fakturownia/accountingDocumentProvider.js";
import { createTestAccountingProvider } from "../../adapters/accounting/testAccountingProvider.js";
import { deploymentStagingEnabled } from "#deployment-route-policy";
import { createFakturowniaClient, readFakturowniaClientConfig } from "../fakturownia/client.js";

export const TEST_ACCOUNTING_PROVIDER_KIND = "fakturownia_test";
export const UNCONFIGURED_ACCOUNTING_PROVIDER_KIND = "unconfigured";

export type AccountingProviderMode = "test" | "fakturownia";

export function readAccountingProviderMode(env: Record<string, string | undefined>): AccountingProviderMode | null {
  const explicit = (env.ACCOUNTING_PROVIDER ?? env.COMMERCE_ACCOUNTING_PROVIDER_MODE)?.trim().toLowerCase();
  if (explicit === "test" || explicit === "fakturownia") return explicit;
  if (deploymentStagingEnabled(env) && env.COMMERCE_ACCOUNTING_PREVIEW_UI_ENABLED === "true") return "test";
  return null;
}

export function readAccountingLedgerProviderKind(env: Record<string, string | undefined>): string {
  const mode = readAccountingProviderMode(env);
  if (mode === "test") return TEST_ACCOUNTING_PROVIDER_KIND;
  return mode ?? UNCONFIGURED_ACCOUNTING_PROVIDER_KIND;
}

export function createAccountingProviderFromEnv(
  env: Record<string, string | undefined>,
) {
  const mode = readAccountingProviderMode(env);
  if (!mode) return null;
  if (mode === "test") {
    assertTestModeIsNotConflicting(env);
    return createTestAccountingProvider();
  }

  const providerConfig = readFakturowniaClientConfig(env);
  return providerConfig
    ? createFakturowniaAccountingDocumentProvider(createFakturowniaClient(providerConfig))
    : null;
}

function assertTestModeIsNotConflicting(env: Record<string, string | undefined>): void {
  if (env.ACCOUNTING_MUTATIONS_ENABLED === "true" || env.COMMERCE_ACCOUNTING_MUTATIONS_ENABLED === "true") {
    throw new Error("accounting_provider_mode_conflict_real_mutations_enabled");
  }
}
