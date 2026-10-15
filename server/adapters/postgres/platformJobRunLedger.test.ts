import { describe, expect, it, vi } from "vitest";

import { createPostgresPlatformJobRunLedger } from "./platformJobRunLedger.js";

describe("reference PostgreSQL job-run ledger binding", () => {
  it("records this application's release correlation and default failure reason", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ released: true }] }));
    const ledger = createPostgresPlatformJobRunLedger({ query }, {});
    await ledger.finishJobRun(
      "nightly-report",
      "00000000-0000-4000-8000-000000000001",
      { triggerKind: "scheduler", invocationSource: "node_cron" },
      "failed",
      { checked: 0, updated: 0, failures: 1, skipped: false },
    );
    const values = query.mock.calls[0]![1]!;
    expect(values[5]).toBe("accounting_job_failed");
    expect(values[7]).toMatchObject({ releaseSha: null, deploymentUrl: null });
  });
});
