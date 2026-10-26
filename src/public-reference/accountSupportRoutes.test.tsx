import { useEffect, useState, type ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAccountReadFacade, createSelfServiceCommandFacade, type AccountSupportCapabilities } from "@openlup/platform/account-support";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { createM12AccountSupportReferenceBinding } from "../../server/runtime/public-reference/m12AccountSupportBinding.js";
import { createCustomerAccountHandler } from "../../server/domains/customers/customerAccountHandler.js";
import { createCustomerSubscriptionActionHandler, CustomerSubscriptionActionConflictError } from "../../server/domains/customers/customerSubscriptionActionHandler.js";
import { getCustomerAccount, applyCustomerSubscriptionAction } from "../domains/customers/customerSelfServiceClient.js";
import type { CustomerAccountV2Response } from "../domains/customers/accountV2Contracts.js";
import type { CustomerSubscriptionActionRequest, CustomerSubscriptionActionResponse } from "../domains/customers/selfServiceContracts.js";
import type { HttpRequest, HttpResponse } from "../../server/_lib/types/http.js";
import { ambientSettlementProfile } from "../lib/currency/platformCurrency.js";
import { AccountSupportRoutes } from "./accountSupportRoutes.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const principal = "11111111-1111-4111-8111-111111111111", client = "22222222-2222-4222-8222-222222222222", subscription = "33333333-3333-4333-8333-333333333333";
const unavailable = { supported: false as const, refusalCode: "host_binding_required" as const };
const capabilities: AccountSupportCapabilities = {
  graph: "native", accountRead: { supported: true }, customer360Read: unavailable, invoiceAccess: unavailable,
  commerceRecovery: unavailable, configuredPurchase: unavailable, paymentMethodSetup: { supported: false, refusalCode: "unsupported" },
  operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  subscriptions: NATIVE_SUBSCRIPTION_CAPABILITIES, communicationGifts: { supported: false, refusalCode: "unsupported_preference" },
};
function transport(handler: (req: HttpRequest, res: HttpResponse) => unknown) {
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    let status = 200, body: unknown;
    const response = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; return this; }, setHeader() {} } as unknown as HttpResponse;
    await handler({ method: init?.method, headers: Object.fromEntries(new Headers(init?.headers).entries()), query: {},
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined } as HttpRequest, response);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
}
function bind(handler: (req: HttpRequest, res: HttpResponse) => unknown, graph: "native" | "managed" = "native") {
  const binding = createM12AccountSupportReferenceBinding({ enabled: true, graph, capabilities: { ...capabilities, graph }, commerce: null,
    operations: { http: handler }, ownerSchemas: [], requiredObjects: [], dependsOn: [], routes: [{ id: "http", handle: handler }],
    version: "0.26.0", catalogue: { version: "full", migration: "host" },
    readiness: async () => ({ state: "ready", candidate: { artifact: "a", configuration: "c", environment: "local", database: "db", schema: "full" }, loadedPackages: [], issues: [] }) });
  transport(binding.routes["@openlup/platform/account-support:http"] as typeof handler);
}
const paths = { account: "/account", commands: "/account/subscription", customer360: "/admin/clients", recovery: "/admin/recovery" };
function mount(element: ReactElement, path: string, command = false) {
  render(<MemoryRouter initialEntries={[path]}><AccountSupportRoutes paths={paths} account={command ? <></> : element}
    commands={command ? element : <></>} customer360={<p>Operator auth remains separate</p>} recovery={<p>Recovery</p>} /></MemoryRouter>);
}

it("U1 crosses the browser client and authenticated HTTP handler to the selected read facade", async () => {
  const account: CustomerAccountV2Response = { contractVersion: "customer.account.v3", profile: { clientId: client, email: "buyer@example.invalid", firstName: "Synthetic", lastName: null, phone: null, lifecycleStage: "customer" },
    pets: [], subscriptions: [], addresses: [], ordererProfiles: [], billingProfiles: [], paymentPreferences: [], deliveryPreferences: [], events: [], actionRequired: [],
    recentOrders: [{ orderId: subscription, orderRef: `order_${subscription}`, orderNumber: "1001", subscriptionId: null, status: "paid", paymentStatus: "succeeded", fulfillmentStatus: null,
      total: { amountMinor: 2301, currency: ambientSettlementProfile.defaultCurrency }, trackingNumber: null, trackingNumbers: [], trackingUrl: null, carrierKind: null, service: null, trackingReferences: [], trackingTimeline: [],
      invoice: null, invoiceDocuments: [], deliverySelection: null, invoiceRequestStatus: "not_requested", createdAt: "2026-10-25T12:00:00Z", updatedAt: "2026-10-25T12:00:00Z" }] };
  const getAccount = vi.fn(async () => account);
  const facade = createAccountReadFacade({ account: { getAccount }, orders: { listOrders: async () => null, getOrderDetail: async () => null } });
  bind(createCustomerAccountHandler({ accountPort: facade, authenticateUser: async req => {
    expect(req.headers.authorization).toBe("Bearer synthetic-session"); return { ok: true, userId: principal };
  } }));
  function Account() {
    const [value, setValue] = useState<CustomerAccountV2Response>();
    const [error, setError] = useState("");
    useEffect(() => { void getCustomerAccount("synthetic-session").then(setValue, cause => setError(String(cause))); }, []);
    return <output>{error || (value ? JSON.stringify(value) : "Loading")}</output>;
  }
  mount(<Account />, paths.account);
  expect((await screen.findByText(/order_33333333/)).textContent).toContain('"amountMinor":2301');
  const received = JSON.parse(screen.getByRole("status").textContent!);
  expect(received.recentOrders[0].orderRef).toBe(`order_${subscription}`);
  expect(received.recentOrders[0].total).toEqual(account.recentOrders[0]!.total);
  expect(received.pets).toEqual([]); expect(received.recentOrders[0]).not.toHaveProperty("privateExtension");
  expect(getAccount).toHaveBeenCalledExactlyOnceWith(principal);
  expect(screen.queryByText("Operator auth remains separate")).toBeNull();
});

it.each(["applied", "refused"] as const)("U2 customer command carries its original key and owner %s through HTTP", async outcome => {
  const request: CustomerSubscriptionActionRequest = { subscriptionId: subscription, action: "pause", pausePreset: "indefinite", idempotencyKey: "original-command-key" };
  const receipt: CustomerSubscriptionActionResponse = { contractVersion: "customer.self_service.v1", subscriptionAction: {
    subscriptionId: subscription, action: "pause", status: "applied", subscriptionStatus: "paused", nextCycleAt: null, templateVersion: 7, eventId: null } };
  const applyAction = vi.fn(async (actor: string, input: CustomerSubscriptionActionRequest) => {
    expect(actor).toBe(principal); expect(input).toEqual(request);
    if (outcome === "refused") throw new CustomerSubscriptionActionConflictError("CONFLICT", "owner refused", { reason: "payment_blocked" });
    return receipt;
  });
  const facade = createSelfServiceCommandFacade({ context: { principalId: principal, clientId: client, graph: "managed" },
    capabilities: { ...capabilities, graph: "managed" }, managedSubscription: { applyAction, previewAction: async () => null } });
  const handler = createCustomerSubscriptionActionHandler({ authenticateUser: async () => ({ ok: true, userId: principal }),
    subscriptionActionPort: { applyAction: async (actor, input) => {
      const result = await facade.managedSubscription.applyAction(actor, input);
      if (result === null) return null;
      if ("contractVersion" in result) return result;
      throw Error("unexpected unavailable lane");
    } } });
  bind(handler, "managed");
  function Commands() {
    const [result, setResult] = useState("");
    return <><button onClick={() => { void applyCustomerSubscriptionAction("synthetic-session", request).then(value => setResult(JSON.stringify(value)), error => setResult(JSON.stringify(error.details))); }}>Pause</button><output>{result}</output></>;
  }
  mount(<Commands />, paths.commands, true); fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect((await screen.findByText(outcome === "applied" ? /"templateVersion":7/ : /payment_blocked/)).textContent)
    .toBe(JSON.stringify(outcome === "applied" ? receipt : { reason: "payment_blocked" }));
  expect(applyAction).toHaveBeenCalledTimes(1);
});
