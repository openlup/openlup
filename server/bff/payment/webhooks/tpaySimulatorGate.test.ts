import { afterEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({
  providerPaymentsEnabled: vi.fn(() => true),
  providerWebhooksEnabled: vi.fn(() => true),
  tpayEnabled: vi.fn(() => true),
  tpaySimulatorEnabled: vi.fn(() => true),
  tpaySandboxEnabled: vi.fn(() => false),
}));

vi.mock("../../../_lib/config/featureFlags.js", () => flags);

import { tpaySimulatorWebhookEnabled } from "./tpaySimulatorGate.js";

describe("tpaySimulatorWebhookEnabled", () => {
  afterEach(() => {
    flags.providerPaymentsEnabled.mockReturnValue(true);
    flags.providerWebhooksEnabled.mockReturnValue(true);
    flags.tpayEnabled.mockReturnValue(true);
    flags.tpaySimulatorEnabled.mockReturnValue(true);
    flags.tpaySandboxEnabled.mockReturnValue(false);
  });

  it("is enabled only with all simulator flags on and sandbox off", () => {
    expect(tpaySimulatorWebhookEnabled()).toBe(true);
  });

  it("is disabled when the Tpay SANDBOX rail is active (prod/sandbox fence)", () => {
    flags.tpaySandboxEnabled.mockReturnValue(true);
    expect(tpaySimulatorWebhookEnabled()).toBe(false);
  });

  it("is disabled when the simulator flag is off", () => {
    flags.tpaySimulatorEnabled.mockReturnValue(false);
    expect(tpaySimulatorWebhookEnabled()).toBe(false);
  });

  it("is disabled when provider payments or webhooks are off", () => {
    flags.providerPaymentsEnabled.mockReturnValue(false);
    expect(tpaySimulatorWebhookEnabled()).toBe(false);
    flags.providerPaymentsEnabled.mockReturnValue(true);
    flags.providerWebhooksEnabled.mockReturnValue(false);
    expect(tpaySimulatorWebhookEnabled()).toBe(false);
  });
});
