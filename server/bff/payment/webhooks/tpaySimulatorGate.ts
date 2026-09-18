import {
  providerPaymentsEnabled,
  providerWebhooksEnabled,
  tpayEnabled,
  tpaySandboxEnabled,
  tpaySimulatorEnabled,
} from "../../../_lib/config/featureFlags.js";

/**
 * The staging-only Tpay-simulator gate shared by the on-session settle webhook and the
 * off-session recurring-settle sweep. `!tpaySandboxEnabled()` (plus the simulator flag)
 * keeps both endpoints inert anywhere the real/sandbox Tpay rail is active — production is
 * never in simulator mode, so neither can touch a real charge.
 */
export function tpaySimulatorWebhookEnabled(): boolean {
  return providerPaymentsEnabled() &&
    providerWebhooksEnabled() &&
    tpayEnabled() &&
    tpaySimulatorEnabled() &&
    !tpaySandboxEnabled();
}
