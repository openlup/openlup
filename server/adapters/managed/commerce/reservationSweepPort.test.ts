import { describe, expect, it, vi } from "vitest";
import {
  createManagedReservationSweepPort,
} from "./reservationSweepPort.js";

describe("createManagedReservationSweepPort", () => {
  it("calls the reservation sweep RPC and maps counts", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        sweep: {
          ordersChecked: 3,
          ordersExpired: 1,
          reservationsReleased: 2,
          skippedPaid: 1,
          skippedTerminal: 0,
          skippedSubscription: 1,
        },
      },
      error: null,
    }));

    await expect(createManagedReservationSweepPort({ rpc }).sweep({
      now: "2026-06-28T00:00:00.000Z",
      limit: 50,
    })).resolves.toEqual({
      ordersChecked: 3,
      ordersExpired: 1,
      reservationsReleased: 2,
      skippedPaid: 1,
      skippedTerminal: 0,
      skippedSubscription: 1,
    });

    expect(rpc).toHaveBeenCalledWith("commerce_sweep_expired_reservation_holds", {
      p_idempotency_prefix: "commerce-reservation-sweep-run",
      p_now: "2026-06-28T00:00:00.000Z",
      p_limit: 50,
    });
  });

  it("defaults missing counts to zero and throws RPC errors", async () => {
    await expect(createManagedReservationSweepPort({
      rpc: vi.fn(async () => ({ data: {}, error: null })),
    }).sweep({ now: "now", limit: 2 })).resolves.toEqual({
      ordersChecked: 0,
      ordersExpired: 0,
      reservationsReleased: 0,
      skippedPaid: 0,
      skippedTerminal: 0,
      skippedSubscription: 0,
    });

    await expect(createManagedReservationSweepPort({
      rpc: vi.fn(async () => ({ data: null, error: { message: "boom" } })),
    }).sweep({ now: "now", limit: 2 })).rejects.toThrow("rpc_sweep: boom");
  });
});
