import { describe, expect, it, vi } from "vitest";
import { createSupabaseOmnipackWebhookGateway } from "./omnipackWebhookGateway.js";

describe("supabase OmniPack webhook gateway", () => {
  it("returns null before constructing a DB client when service-role env is missing", () => {
    const clientFactory = vi.fn();

    expect(createSupabaseOmnipackWebhookGateway(
      { SUPABASE_URL: "https://supabase.test" },
      { clientFactory: clientFactory as never },
    )).toBeNull();

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("constructs the service-role webhook port with Supabase client hardening options", () => {
    const client = fakeClient();
    const clientFactory = vi.fn(() => client);

    const gateway = createSupabaseOmnipackWebhookGateway(
      { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
      { clientFactory: clientFactory as never },
    );

    expect(gateway?.port).toBeTruthy();
    expect(clientFactory).toHaveBeenCalledWith("https://supabase.test", "service", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it("wires accounting handoff invoice requests only when the runtime policy enables them", async () => {
    const client = fakeClient();
    const accountingPort = {
      requestInvoiceIssueFromFulfillmentHandoff: vi.fn(async () => accountingIssueResponse()),
      requestInvoiceIssueFromPaidOrder: vi.fn(async () => accountingIssueResponse()),
    };
    const accountingPortFactory = vi.fn(() => accountingPort);

    const gateway = createSupabaseOmnipackWebhookGateway(
      { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
      {
        accountingEnabled: true,
        accountingPortFactory,
        accountingProviderKind: "fakturownia",
        clientFactory: vi.fn(() => client) as never,
      },
    );

    await gateway?.port.issueAccountingInvoice?.({
      idempotencyKey: "omnipack:webhook:ful-1:accounting-invoice",
      fulfillmentOrderId: "ful-1",
    });

    expect(accountingPortFactory).toHaveBeenCalledWith(client);
    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).toHaveBeenCalledWith({
      idempotencyKey: "omnipack:webhook:ful-1:accounting-invoice",
      fulfillmentOrderId: "ful-1",
      providerKind: "fakturownia",
    });
  });

  it("leaves accounting invoice requests unwired when the runtime policy is disabled", () => {
    const accountingPortFactory = vi.fn();

    const gateway = createSupabaseOmnipackWebhookGateway(
      { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
      {
        accountingEnabled: false,
        accountingPortFactory,
        clientFactory: vi.fn(() => fakeClient()) as never,
      },
    );

    expect(gateway?.port.issueAccountingInvoice).toBeUndefined();
    expect(accountingPortFactory).not.toHaveBeenCalled();
  });
});

function fakeClient() {
  return {
    from: vi.fn(),
    rpc: vi.fn(),
  };
}

function accountingIssueResponse() {
  return {
    invoice: {
      id: "invoice-1",
      invoiceRef: "order-1:base",
      status: "requested",
      replayed: false,
    },
  };
}
