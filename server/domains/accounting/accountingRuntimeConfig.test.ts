import { describe, expect, it } from "vitest";
import {
  assertAccountingRuntimeConfigAllowed,
  readAccountingRuntimeConfig,
} from "./accountingRuntimeConfig.js";

describe("accounting runtime config", () => {
  it("keeps production-safe defaults", () => {
    expect(readAccountingRuntimeConfig({})).toMatchObject({
      requestEnabled: false,
      issueTrigger: "handoff",
      b2bEmailRequiresKsefAcceptance: true,
      createEnabled: false,
      providerEmailEnabled: false,
      ksefPollEnabled: false,
    });
  });

  it("reads staging paid invoice policy flags explicitly", () => {
    expect(readAccountingRuntimeConfig({
      COMMERCE_ACCOUNTING_ISSUE_TRIGGER: "paid",
      COMMERCE_ACCOUNTING_B2B_EMAIL_REQUIRES_KSEF_ACCEPTANCE: "false",
      COMMERCE_ACCOUNTING_PROVIDER_EMAIL_ENABLED: "true",
      COMMERCE_ACCOUNTING_SHADOW_ENABLED: "true",
    })).toMatchObject({
      requestEnabled: true,
      issueTrigger: "paid",
      b2bEmailRequiresKsefAcceptance: false,
      providerEmailEnabled: true,
    });
  });

  it("reads neutral OSS accounting aliases before openlup compatibility flags", () => {
    expect(readAccountingRuntimeConfig({
      ACCOUNTING_ISSUE_TRIGGER: "paid",
      ACCOUNTING_REQUEST_ENABLED: "true",
      ACCOUNTING_B2B_EMAIL_REQUIRES_GOV_ACCEPTANCE: "false",
      ACCOUNTING_CREATE_ENABLED: "true",
      ACCOUNTING_EMAIL_ENABLED: "true",
      ACCOUNTING_GOV_POLL_ENABLED: "true",
      COMMERCE_ACCOUNTING_ISSUE_TRIGGER: "handoff",
      COMMERCE_ACCOUNTING_SHADOW_ENABLED: "false",
      COMMERCE_ACCOUNTING_PROVIDER_EMAIL_ENABLED: "false",
    })).toMatchObject({
      issueTrigger: "paid",
      requestEnabled: true,
      b2bEmailRequiresKsefAcceptance: false,
      createEnabled: true,
      providerEmailEnabled: true,
      ksefPollEnabled: true,
    });
  });

  it("prefers neutral request switch over legacy shadow flag", () => {
    expect(readAccountingRuntimeConfig({
      ACCOUNTING_REQUEST_ENABLED: "false",
      COMMERCE_ACCOUNTING_SHADOW_ENABLED: "true",
    })).toMatchObject({ requestEnabled: false });
    expect(readAccountingRuntimeConfig({
      COMMERCE_ACCOUNTING_SHADOW_ENABLED: "true",
    })).toMatchObject({ requestEnabled: true });
  });

  it("forbids government status polling on staging", () => {
    for (const env of [
      { ACCOUNTING_GOV_POLL_ENABLED: "true" },
      { COMMERCE_ACCOUNTING_KSEF_POLL_ENABLED: "true" },
    ]) {
      const config = readAccountingRuntimeConfig({
        openlup_ENVIRONMENT: "staging",
        ...env,
      });
      expect(() => assertAccountingRuntimeConfigAllowed({ openlup_ENVIRONMENT: "staging" }, config)).toThrow("staging_ksef_poll_forbidden");
    }
  });
});
