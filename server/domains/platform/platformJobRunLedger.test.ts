import { describe, expect, it } from "vitest";
import type {
  PlatformJobInvocation,
  PlatformJobRunLedgerPort,
} from "./platformJobRunLedger.js";

describe("platform job run ledger port", () => {
  it("expresses claim, finish and readback without binding a persistence client", async () => {
    const calls: PlatformJobInvocation[] = [];
    const port: PlatformJobRunLedgerPort = {
      async claimJobRun(_jobName, invocation) {
        calls.push(invocation);
        return { acquired: true, runId: "run-1", reason: "acquired" };
      },
      async finishJobRun(_jobName, _runId, invocation) {
        calls.push(invocation);
        return true;
      },
      async readJobBackstopState() {
        return { lastStatus: "success", lastSuccessAt: "2026-08-12T10:00:00.000Z" };
      },
      async readLatestTerminalRunMetadata() {
        return { invocationSource: "worker" };
      },
    };

    const invocation = { triggerKind: "worker", invocationSource: "node_worker" } as const;
    await expect(port.claimJobRun("stock-sync", invocation)).resolves.toEqual({
      acquired: true,
      runId: "run-1",
      reason: "acquired",
    });
    await expect(port.finishJobRun("stock-sync", "run-1", invocation, "success", {
      checked: 1,
      updated: 1,
      failures: 0,
      skipped: false,
    })).resolves.toBe(true);
    await expect(port.readJobBackstopState("stock-sync")).resolves.toEqual({
      lastStatus: "success",
      lastSuccessAt: "2026-08-12T10:00:00.000Z",
    });
    await expect(port.readLatestTerminalRunMetadata("stock-sync")).resolves.toEqual({
      invocationSource: "worker",
    });
    expect(calls).toEqual([invocation, invocation]);
  });
});
