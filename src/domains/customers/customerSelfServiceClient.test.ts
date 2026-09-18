import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestBff } from "@/lib/bff/client";
import {
  applyCustomerSubscriptionAction,
  createCustomerPet,
  downloadCustomerInvoicePdf,
  getCustomerAccount,
  previewCustomerSubscriptionAction,
  startCustomerPaymentRecovery,
  updateCustomerProfile,
  upsertCustomerAddress,
} from "./customerSelfServiceClient";

vi.mock("@/lib/bff/client", () => ({ requestBff: vi.fn() }));

describe("customer self-service client", () => {
  beforeEach(() => {
    vi.mocked(requestBff).mockReset();
  });

  it("calls account and profile BFF routes with the customer bearer token", async () => {
    vi.mocked(requestBff).mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await getCustomerAccount("token-1");
    await updateCustomerProfile("token-1", {
      idempotencyKey: "profile-update-1",
      firstName: "Ala",
    });

    expect(vi.mocked(requestBff).mock.calls[0]?.[0]).toBe("/api/bff/customers/account");
    expect(vi.mocked(requestBff).mock.calls[1]?.[0]).toBe("/api/bff/customers/profile");
    expect(vi.mocked(requestBff).mock.calls[1]?.[2]).toMatchObject({ method: "PATCH" });
  });

  it("routes pet, address, and subscription actions through typed BFF paths", async () => {
    vi.mocked(requestBff).mockResolvedValue({});

    await createCustomerPet("token-1", {
      idempotencyKey: "pet-create-1",
      petType: "dog",
      name: "Figa",
    });
    await upsertCustomerAddress("token-1", {
      idempotencyKey: "address-create-1",
      kind: "shipping",
      line1: "Testowa 1",
      city: "Warszawa",
      postalCode: "00-001",
    });
    await applyCustomerSubscriptionAction("token-1", {
      action: "skip_next_cycle",
      idempotencyKey: "skip-cycle-1",
      subscriptionId: "33333333-3333-4333-8333-333333333333",
    });
    await previewCustomerSubscriptionAction("token-1", {
      subscriptionAction: {
        action: "skip_next_cycle",
        idempotencyKey: "skip-cycle-preview-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
      },
    });
    await startCustomerPaymentRecovery("token-1", {
      idempotencyKey: "recovery-start-1",
      subscriptionId: "33333333-3333-4333-8333-333333333333",
    });

    expect(vi.mocked(requestBff).mock.calls.map((call) => call[0])).toEqual([
      "/api/bff/customers/pets",
      "/api/bff/customers/addresses",
      "/api/bff/customers/subscriptions/action",
      "/api/bff/customers/subscriptions/preview",
      "/api/bff/customers/payment-recovery/start",
    ]);
  });

  it("downloads invoice PDFs through the authenticated customer BFF route", async () => {
    const blob = new Blob(["pdf"], { type: "application/pdf" });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(blob, { status: 200 }));

    await expect(downloadCustomerInvoicePdf("token-1", "99999999-9999-9999-9999-999999999999", {
      fetcher: fetchMock as typeof fetch,
    })).resolves.toBeInstanceOf(Blob);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bff/customers/invoices/download?invoiceId=99999999-9999-9999-9999-999999999999",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer token-1");

    await downloadCustomerInvoicePdf(
      "token-1",
      "99999999-9999-9999-9999-999999999999",
      { fetcher: fetchMock as typeof fetch },
      "correction",
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/bff/customers/invoices/download?invoiceId=99999999-9999-9999-9999-999999999999&artifact=correction",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
