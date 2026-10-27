import type { ReadinessIssue } from "@openlup/core/readiness";
import { createMarketingPrivacyContributor, type MarketingPrivacyContributor, type MarketingPrivacyDependencies } from "./privacyContributor.js";

/** Select one fully bound privacy contributor; absent activation leaves the host registry unchanged. */
export function createMarketingPrivacyBindings<Context>(input: MarketingPrivacyDependencies<Context> & { enabled?: boolean }): {
  contributor: MarketingPrivacyContributor<Context> | null;
  issues: ReadinessIssue[];
  callables: Readonly<{
    exportPersonalData: MarketingPrivacyContributor<Context>["export"] | null;
    assessErasure: MarketingPrivacyContributor<Context>["assessErasure"] | null;
    eraseOrRetain: MarketingPrivacyContributor<Context>["eraseOrRetain"] | null;
  }>;
} {
  const acquisition = input.acquisition && [input.acquisition.export, input.acquisition.assessErasure, input.acquisition.eraseOrRetain].every(fn => typeof fn === "function") ? input.acquisition : null;
  const remoteErasure = input.remoteErasure && [input.remoteErasure.read, input.remoteErasure.openAndFence].every(fn => typeof fn === "function") ? input.remoteErasure : null;
  const issues: ReadinessIssue[] = [];
  for (const [name, port] of [["acquisition", acquisition], ["remoteErasure", remoteErasure]] as const) {
    if (!port) issues.push({ code: "OPENLUP_E_PORT_MISSING", package: "@openlup/platform", module: "marketing", subject: name, fix: `Bind the marketing ${name} owner port.` });
  }
  const selected = input.enabled === true && issues.length === 0
    ? createMarketingPrivacyContributor({ ...input, acquisition, remoteErasure }) : null;
  return { contributor: selected, issues, callables: Object.freeze({
    exportPersonalData: selected ? selected.export : null,
    assessErasure: selected ? selected.assessErasure : null,
    eraseOrRetain: selected ? selected.eraseOrRetain : null,
  }) };
}
