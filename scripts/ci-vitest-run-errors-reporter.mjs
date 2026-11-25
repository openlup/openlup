// Records run-level errors that no test file accounts for, so the hosted-CI file
// retry in ci-vitest-shard.mjs can refuse to retry them away.
import { writeFileSync } from "node:fs";
import { env as processEnvironment } from "node:process";

export const RUN_ERRORS_REPORT_ENV = "OPENLUP_VITEST_RUN_ERRORS_REPORT";

export default class RunErrorsReporter {
  onTestRunEnd(_testModules, unhandledErrors, reason) {
    const path = processEnvironment[RUN_ERRORS_REPORT_ENV];
    if (!path) return;
    writeFileSync(path, JSON.stringify({ unhandledErrors: unhandledErrors?.length ?? 0, reason: reason ?? null }));
  }
}
