import { runPlatformWatchdog as runOperationsWatchdog } from "@openlup/platform/operations/server";
import type { PlatformWatchdogResult as OperationsWatchdogResult } from "@openlup/platform/operations/server";
import type { ObservabilitySnapshot, JobCatalogEntry, AlertChannel } from "../../../src/domains/platform/observabilityContracts.js";
import { evaluateObservability } from "../../../src/domains/platform/observabilityEvaluator.js";
export type PlatformWatchdogResult = OperationsWatchdogResult<AlertChannel>;

/** Reference default: domain evidence interpretation stays with its existing owners. */
export function runPlatformWatchdog(
  options: Omit<Parameters<typeof runOperationsWatchdog<ObservabilitySnapshot, JobCatalogEntry, AlertChannel>>[0], "evaluate">,
): Promise<PlatformWatchdogResult> {
  return runOperationsWatchdog({ ...options, evaluate: evaluateObservability });
}
