import { describe, expect, it, vi } from "vitest";

import { createTpaySimulatorPaymentReadbackProvider } from "./tpaySimulatorPaymentReadbackProvider.js";

describe("Tpay simulator payment readback", () => {
  it.each(["expired", "failed"])(
    "maps durable %s simulator evidence to a terminal failure",
    async (status) => {
      const { client, query } = clientFor({
        status,
        amount_cents: 18_774,
        currency: "pln",
        failure_reason: `simulator_${status}`,
        updated_at: "2026-07-22T10:00:00.000Z",
      });

      await expect(createTpaySimulatorPaymentReadbackProvider(client).readPayment({
        providerPaymentId: "tpay_sim_attempt",
      })).resolves.toMatchObject({
        status: "failed",
        providerStatus: status,
        amountMinor: 18_774,
        currency: "PLN",
      });
      expect(query.eq).toHaveBeenCalledWith("provider", "tpay");
      expect(query.eq).toHaveBeenCalledWith("provider_attempt_id", "tpay_sim_attempt");
    },
  );

  it("maps durable succeeded evidence to provider success", async () => {
    const { client } = clientFor({
      status: "succeeded",
      amount_cents: 18_774,
      currency: "PLN",
      failure_reason: null,
      updated_at: "2026-07-22T10:00:00.000Z",
    });
    await expect(createTpaySimulatorPaymentReadbackProvider(client).readPayment({
      providerPaymentId: "tpay_sim_paid",
    })).resolves.toMatchObject({ status: "succeeded", providerStatus: "succeeded" });
  });

  it("keeps an open simulator attempt pending", async () => {
    const { client } = clientFor({
      status: "processing",
      amount_cents: 18_774,
      currency: "PLN",
      failure_reason: null,
      updated_at: "2026-07-22T10:00:00.000Z",
    });
    await expect(createTpaySimulatorPaymentReadbackProvider(client).readPayment({
      providerPaymentId: "tpay_sim_open",
    })).resolves.toMatchObject({ status: "pending", providerStatus: "processing" });
  });

  it("fails closed without querying for a non-simulator provider id", async () => {
    const { client, from } = clientFor(null);
    await expect(createTpaySimulatorPaymentReadbackProvider(client).readPayment({
      providerPaymentId: "real_tpay_attempt",
    })).resolves.toMatchObject({ status: "unknown", providerStatus: "simulator_provider_id_invalid" });
    expect(from).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "unexpected"])("fails closed for non-authoritative %s state", async (status) => {
    const { client } = clientFor({
      status,
      amount_cents: 18_774,
      currency: "PLN",
      failure_reason: null,
      updated_at: "2026-07-22T10:00:00.000Z",
    });
    await expect(createTpaySimulatorPaymentReadbackProvider(client).readPayment({
      providerPaymentId: "tpay_sim_ambiguous",
    })).resolves.toMatchObject({ status: "unknown", providerStatus: status });
  });

  it("fails closed when the simulator attempt is missing", async () => {
    const { client } = clientFor(null);
    await expect(createTpaySimulatorPaymentReadbackProvider(client).readPayment({
      providerPaymentId: "tpay_sim_missing",
    })).resolves.toMatchObject({ status: "unknown", providerStatus: "simulator_payment_not_found" });
  });

  it("propagates a durable read failure to the safety port", async () => {
    const { client } = clientFor(null, { message: "database unavailable" });
    await expect(createTpaySimulatorPaymentReadbackProvider(client).readPayment({
      providerPaymentId: "tpay_sim_query_error",
    })).rejects.toThrow("tpay_simulator_payment_readback: database unavailable");
  });
});

interface SimulatorAttemptFixture {
  status: string;
  amount_cents: number;
  currency: string;
  failure_reason: string | null;
  updated_at: string;
}

function clientFor(
  row: SimulatorAttemptFixture | null,
  error: { message?: string } | null = null,
) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data: row, error })),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const from = vi.fn(() => query);
  return { client: { from }, query, from };
}
