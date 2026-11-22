/** @experimental Offline carrier rate-quote adapter conformance and scripted transport fake. */
export { runShippingRateAdapterConformance } from "./adapterConformance.js";
export type {
  ShippingRateAdapterTestSubject,
  ShippingRateConformanceEvidence,
  ShippingRateConformanceOptions,
  ShippingRateFullCertificationScenarios,
  ShippingRateLedgerEntry,
  ShippingRateQualification,
  ShippingRateScenarioHarness,
  ShippingRateTransportFaultScenario,
} from "./adapterConformance.js";
export {
  createScriptedShippingRateFake,
  ScriptedShippingRateTransportError,
} from "./scriptedFake.js";
export type {
  ScriptedShippingRateFake,
  ScriptedShippingRateOutcome,
} from "./scriptedFake.js";
