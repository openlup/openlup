import { describe, expect, it, vi } from "vitest";
import { WATCHDOG_HEARTBEAT_JOB_NAME, recordWatchdogHeartbeat } from "./watchdogHeartbeat.js";
import type { SupabaseAlertLedgerClient } from "./alertLedgerPort.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");
const SUMMARY = { health: "healthy", firingCount: 0, maxSeverity: null, promotionReady: true };

function clientWith(result: { error: { message?: string } | null }) {
  const upsert = vi.fn((_value: Record<string, unknown>, _options?: Record<string, unknown>) =>
    Promise.resolve({ data: null, ...result }),
  );
  const from = vi.fn(() => ({ upsert }));
  return { client: { from } as unknown as SupabaseAlertLedgerClient, from, upsert };
}

describe("recordWatchdogHeartbeat", () => {
  it("stamps the control row that the health pill reads", async () => {
    const { client, from, upsert } = clientWith({ error: null });

    await expect(recordWatchdogHeartbeat(client, SUMMARY, NOW)).resolves.toBe(true);
    expect(from).toHaveBeenCalledWith("platform_job_controls");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        job_name: WATCHDOG_HEARTBEAT_JOB_NAME,
        last_success_at: NOW.toISOString(),
        last_status: "success",
      }),
      { onConflict: "job_name" },
    );
  });

  it("carries the run summary so an operator can see what the tick found", async () => {
    const { client, upsert } = clientWith({ error: null });

    await recordWatchdogHeartbeat(client, {
      health: "firing", firingCount: 3, maxSeverity: "p0", promotionReady: false,
    }, NOW);

    expect(upsert.mock.calls[0][0]).toMatchObject({
      metadata: {
        health: "firing", firingCount: 3, maxSeverity: "p0", promotionReady: false,
      },
    });
  });

  it("reports failure instead of throwing — a bad heartbeat must not fail the run", async () => {
    const { client } = clientWith({ error: { message: "permission denied" } });

    await expect(recordWatchdogHeartbeat(client, SUMMARY, NOW)).resolves.toBe(false);
  });

  it("swallows a thrown transport error the same way", async () => {
    const client = {
      from: () => ({
        upsert: () => {
          throw new Error("network down");
        },
      }),
    } as unknown as SupabaseAlertLedgerClient;

    await expect(recordWatchdogHeartbeat(client, SUMMARY, NOW)).resolves.toBe(false);
  });
});
