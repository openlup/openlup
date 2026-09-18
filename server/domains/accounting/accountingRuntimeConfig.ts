import { deploymentStagingEnabled } from "#deployment-route-policy";

export type AccountingRuntimeConfig = {
  requestEnabled: boolean;
  createEnabled: boolean;
  b2cEmailEnabled: boolean;
  providerEmailEnabled: boolean;
  ksefPollEnabled: boolean;
  issueTrigger: "handoff" | "paid";
  b2bEmailRequiresKsefAcceptance: boolean;
};

export function readAccountingRuntimeConfig(env: Record<string, string | undefined>): AccountingRuntimeConfig {
  const b2cEmailEnabled = readFlag(env, "ACCOUNTING_B2C_EMAIL_ENABLED", "COMMERCE_ACCOUNTING_B2C_EMAIL_ENABLED");
  const issueTrigger = readText(env, "ACCOUNTING_ISSUE_TRIGGER", "COMMERCE_ACCOUNTING_ISSUE_TRIGGER") === "paid" ? "paid" : "handoff";
  return {
    requestEnabled: readFlag(env, "ACCOUNTING_REQUEST_ENABLED", "COMMERCE_ACCOUNTING_SHADOW_ENABLED"),
    createEnabled: readFlag(env, "ACCOUNTING_CREATE_ENABLED", "COMMERCE_ACCOUNTING_CREATE_ENABLED"),
    b2cEmailEnabled,
    providerEmailEnabled: readFlag(env, "ACCOUNTING_EMAIL_ENABLED", "COMMERCE_ACCOUNTING_PROVIDER_EMAIL_ENABLED") || b2cEmailEnabled,
    ksefPollEnabled: readFlag(env, "ACCOUNTING_GOV_POLL_ENABLED", "COMMERCE_ACCOUNTING_KSEF_POLL_ENABLED"),
    issueTrigger,
    b2bEmailRequiresKsefAcceptance: readText(
      env,
      "ACCOUNTING_B2B_EMAIL_REQUIRES_GOV_ACCEPTANCE",
      "COMMERCE_ACCOUNTING_B2B_EMAIL_REQUIRES_KSEF_ACCEPTANCE",
    ) !== "false",
  };
}

export function assertAccountingRuntimeConfigAllowed(env: Record<string, string | undefined>, config: AccountingRuntimeConfig): void {
  if (!deploymentStagingEnabled(env)) return;
  if (config.ksefPollEnabled) {
    throw new Error("staging_ksef_poll_forbidden");
  }
}

function readFlag(env: Record<string, string | undefined>, primary: string, legacy: string): boolean {
  return (env[primary] ?? env[legacy]) === "true";
}

function readText(env: Record<string, string | undefined>, primary: string, legacy: string): string | undefined {
  return env[primary] ?? env[legacy];
}
