import { expect, it, vi } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import type * as Local from "@openlup/platform/account-support/contracts";
import { mapCustomerOrderLines, type CustomerOrderHistoryReadStore, type ContactHealthDelivery, type CustomerJourneyAuditEvent } from "@openlup/platform/account-support";
import type {
  CustomerAccountV2Response,
  CustomerOrderDetailResponse,
  CustomerOrdersListResponse
} from "../../../src/domains/customers/accountV2Contracts.js";
import type {
  Customer360Subject,
  Customer360SearchResponse,
  Customer360SnapshotResponse,
  Customer360ContactHealth,
  Customer360Address
} from "../../../src/domains/support/customer360Contracts.js";
import type { ContactHealthDelivery as OwnerContactHealthDelivery } from "../../../src/domains/support/contactHealth.js";
import type { CustomerJourneyAuditEvent as OwnerAudit } from "../../domains/support/customerJourneyAudit.js";
import type { CustomerOrderHistoryReadStore as OwnerStore } from "../../adapters/supabase/customerOrderHistoryReadModels.js";
import { createM12SupportReadBinding } from "./m12SupportReadBinding.js";
import { m12ReferenceAccountProjection, m12ReferenceOrderProjection, createM12AccountReadSelection } from "./m12AccountReadBinding.js";
import { resolveCustomerSupportJourneyBinding, governCustomerSupportJourneyPort } from "../support/customerJourneyBinding.js";
import { createPostgresCustomerSupportJourneyPort } from "../../adapters/postgres/customerSupportJourney.js";
import type { CustomerDiagnosticHistoryBinding } from "../observability/customerDiagnosticHistoryBinding.js";
import type { CustomerDiagnosticHistoryPort, CustomerDiagnosticOverviewPort } from "../../domains/observability/customerDiagnosticHistory.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false)
  : false;
type Assert<T extends true> = T;
type Shape<T> = { [K in keyof T]: T[K] };
type Fits<A, B> = [A] extends [B] ? true : false;

/** Private line/profile fields remain host extensions; provider vocabularies specialize host generics. */
export type ReferenceEquality = [
  Assert<Equal<Local.AccountProfile, CustomerAccountV2Response["profile"]>>,
  Assert<Equal<Local.AccountAddress, CustomerAccountV2Response["addresses"][number]>>,
  Assert<Equal<Local.AccountBillingProfile, CustomerAccountV2Response["billingProfiles"][number]>>,
  Assert<
    Equal<
      Local.AccountPaymentPreference<CustomerAccountV2Response["paymentPreferences"][number]["methodKind"]>,
      CustomerAccountV2Response["paymentPreferences"][number]
    >
  >,
  Assert<
    Equal<
      Local.AccountDeliveryPreference<CustomerAccountV2Response["deliveryPreferences"][number]["providerKind"]>,
      CustomerAccountV2Response["deliveryPreferences"][number]
    >
  >,
  Assert<Equal<Local.AccountPickupPoint, NonNullable<CustomerAccountV2Response["deliveryPreferences"][number]["pickupPoint"]>>>,
  Assert<Equal<Local.AccountDeliverySelection, NonNullable<CustomerOrdersListResponse["orders"][number]["deliverySelection"]>>>,
  Assert<Equal<Local.AccountTrackingReference, CustomerOrdersListResponse["orders"][number]["trackingReferences"][number]>>,
  Assert<Equal<Local.AccountTrackingEvent, CustomerOrdersListResponse["orders"][number]["trackingTimeline"][number]>>,
  Assert<Equal<Local.AccountFulfillmentSummary, NonNullable<CustomerOrderDetailResponse["order"]["fulfillment"]>>>,
  Assert<Equal<Local.AccountOrderLine, Omit<CustomerOrderDetailResponse["order"]["lines"][number], "recipeName" | "flavourSlug">>>,
  Assert<Equal<Local.AccountInvoiceSummary, NonNullable<CustomerOrdersListResponse["orders"][number]["invoice"]>>>,
  Assert<Equal<Local.AccountInvoiceDocument, CustomerOrdersListResponse["orders"][number]["invoiceDocuments"][number]>>,
  Assert<Equal<Local.AccountOrderList, CustomerOrdersListResponse>>,
  Assert<Equal<Local.AccountActionMessage, CustomerAccountV2Response["actionRequired"][number]["messageCode"]>>,
  Assert<
    Equal<
      Local.CustomerDocumentDeliveryStatus,
      NonNullable<CustomerOrdersListResponse["orders"][number]["invoice"]>["documentDeliveryStatus"]
    >
  >,
  Assert<Equal<Local.CustomerInvoiceDocumentRole, CustomerOrdersListResponse["orders"][number]["invoiceDocuments"][number]["role"]>>,
  Assert<
    Equal<
      Local.CustomerInvoiceDownloadArtifact,
      CustomerOrdersListResponse["orders"][number]["invoiceDocuments"][number]["artifact"]
    >
  >,
  Assert<Equal<Local.Customer360LifecycleStage, Customer360Subject["lifecycleStage"]>>,
  Assert<Equal<Local.Customer360Order, Customer360SnapshotResponse["orders"][number]>>,
  // The older strict reference codec lacks these optional donor enrichments;
  // the neutral DTO is its structural superset, with no private profile pointer.
  Assert<
    Equal<
      Local.Customer360Subscription,
      Shape<Customer360SnapshotResponse["subscriptions"][number] & {
        paymentMethodKind?: string | null;
        paymentMethodStatus?: string | null
      }>
    >
  >,
  Assert<Equal<Local.Customer360PaymentTruth, Customer360SnapshotResponse["payment"][number]>>,
  Assert<Equal<Local.Customer360DunningCase, Customer360SnapshotResponse["dunningCases"][number]>>,
  Assert<Equal<Local.Customer360Recovery, Customer360SnapshotResponse["recovery"][number]>>,
  Assert<Equal<Local.Customer360AuditEvent, Customer360SnapshotResponse["auditTrail"][number]>>,
  Assert<Equal<Local.Customer360LookupResult, Customer360SnapshotResponse["lookup"]>>,
  Assert<Equal<Local.AccountEvent, CustomerAccountV2Response["events"][number]>>,
  Assert<Equal<Local.AccountActionRequired, CustomerAccountV2Response["actionRequired"][number]>>,
  Assert<Equal<Local.AccountOrderSummary, CustomerOrdersListResponse["orders"][number]>>,
  Assert<
    Equal<
      Local.AccountSubscriptionLine,
      Omit<CustomerAccountV2Response["subscriptions"][number]["lines"][number], "recipeName" | "flavourSlug">
    >
  >,
  Assert<
    Equal<
      Local.AccountSubscription,
      Shape<
        Omit<CustomerAccountV2Response["subscriptions"][number], "petId" | "lines"> & { lines: Local.AccountSubscriptionLine[] }
      >
    >
  >,
  Assert<Fits<CustomerOrderDetailResponse["order"], Local.AccountOrderDetail>>,
  Assert<Fits<OwnerStore, CustomerOrderHistoryReadStore>>,
  Assert<Equal<Local.Customer360Subject, Customer360Subject>>,
  Assert<Equal<Local.Customer360SearchResponse, Customer360SearchResponse>>,
  Assert<Fits<Customer360SnapshotResponse, Local.Customer360Snapshot>>,
  Assert<Equal<Local.Customer360ContactHealth, Customer360ContactHealth>>,
  Assert<Equal<Local.Customer360Address, Customer360Address>>,
  Assert<Equal<ContactHealthDelivery, OwnerContactHealthDelivery>>,
  Assert<Equal<CustomerJourneyAuditEvent, OwnerAudit>>,
];
const actor = { operatorId: "operator-a", isMachineActor: false };
const search = {
  contractVersion: "support.customer_360.v2",
  query: "s",
  candidates: [{
    subjectId: "s",
    displayName: null,
    email: "s@example.invalid",
    lifecycleStage: "customer",
    matchedBy: "subject_id",
    confidence: "exact",
    lastActivityAt: null,
    snapshotLookup: { subjectId: "s" }
  }],
  warnings: []
};

function nativePort(trace: string[]) {
  return createPostgresCustomerSupportJourneyPort(
    { connectionString: "postgres://synthetic", operatorId: actor.operatorId },
    {
      createLane: () => ({
        run: async work => work({
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string) => {
            trace.push(sql);
            const result = sql.includes("customer_support_journey") ? null : {
              contractVersion: "clients.portable.v1",
              query: "s",
              page: 0,
              pageSize: 10,
              total: 0,
              candidates: []
            };
            return { rows: [{ result }] as unknown as Row[], rowCount: 1 };
          }
        }),
        close: async () => {
          trace.push("closed");
        },
      })
    }
  );
}

function managedPort(trace: string[]) {
  return resolveCustomerSupportJourneyBinding(
      { PLATFORM_BUNDLE: "node-supabase" },
      {
        managedScopeFactory: () => ({
          async run(scoped, work) {
            trace.push(scoped.operatorId);
            const port = nativePort(trace);
            const readPort = { ...port, searchCustomerJourney: async () => search as Customer360SearchResponse };
            try {
              return await work(governCustomerSupportJourneyPort(readPort, scoped));
            } finally {
              await port.close();
            }
          },
          identityMove: () => {
            throw new Error("unselected");
          },
        })
      }
    ).binding!;

}
it.each(["denied", "authorized", "governed machine", "ungoverned machine"] as const)(
  "governs a managed journey before reads: %s", async state => {
    const trace: string[] = [];
    const managed = managedPort(trace);
    const authorize = vi.fn(async () => {
      trace.push("authorize");
      if (state === "denied") return null;
      if (state === "authorized") return actor;
      return { ...actor, isMachineActor: true, ...(state === "governed machine" ? { governance: { flagEnabled: true } } : {}) };
    });
    const binding = createM12SupportReadBinding({ enabled: true, graph: "managed", authorize, managed });
    const request = { subjectId: "s", pageSize: 10 };
    if (state === "denied") {
      expect(await binding.getCustomerJourney(request)).toEqual({ kind: "denied" });
      expect(trace).toEqual(["authorize"]);
    } else if (state === "ungoverned machine") {
      await expect(binding.getCustomerJourney(request)).rejects.toThrow("customer_support_agent_read_disabled");
      expect(trace).toEqual(["authorize"]);
    } else {
      const result = await binding.searchCustomerJourney(request);
      if (state === "authorized") expect(result).toEqual(search);
      else expect(result).toMatchObject({ candidates: [{ email: null }] });
      expect(trace).toEqual(["authorize", "operator-a", "closed"]);
    }
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(binding).not.toHaveProperty("issueRecovery");
  }
);
it("selects the existing next-charge projection", () => {
  const policy = m12ReferenceAccountProjection(() => null);
  expect(policy.withNextCharge(null, undefined)).toEqual({ recurringPrice: null, nextCharge: null });
});
it("selects only declared line presentation fields", () => {
  const presentation = m12ReferenceOrderProjection().presentation;
  const row = {
    id: "line", sku_id: "sku", quantity: 1, unit_price_cents: 100, total_cents: 100,
    product_snapshot: { title: "Captured item", recipeName: "Private label" }
  };
  expect(presentation.display(row)).toEqual({
    title: "Captured item", variantName: null, productSlug: null, displayLabel: null, accentColor: null
  });
  const [line] = mapCustomerOrderLines([row], [], "EUR", presentation);
  expect(line).not.toHaveProperty("recipeName");
  expect(line).not.toHaveProperty("flavourSlug");
  expect(line).toMatchObject({ title: "Captured item", total: { amountMinor: 100, currency: "EUR" } });
});
function diagnosticSelection() {
    type Diagnostics = CustomerDiagnosticHistoryPort & CustomerDiagnosticOverviewPort;
    const metadata = {
      sourceHealth: { read: "available", delivery: "unknown" },
      loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
      retainedFrom: null, truncated: false, nextCursor: null
    } as const;
    const diagnosticPort: Diagnostics = {
      ingest: vi.fn(async () => { throw new Error("unselected_ingest"); }),
      prune: vi.fn(async () => { throw new Error("unselected_prune"); }),
      search: vi.fn<Diagnostics["search"]>().mockResolvedValue({
        ...metadata, contractVersion: "customer-diagnostic-history.v1", coverageVersion: "purchase-auth-account.v1",
        groups: [], segments: []
      }),
      readSegment: vi.fn<Diagnostics["readSegment"]>().mockResolvedValue(null),
      overview: vi.fn<Diagnostics["overview"]>().mockResolvedValue({
        ...metadata, contractVersion: "customer-diagnostic-history.v2", groups: [],
        windowCoverage: "full", evidencePresence: "empty"
      })
    };
    const diagnosticTrace: string[] = [];
    const diagnostics: Pick<CustomerDiagnosticHistoryBinding, "run"> = {
      async run(work) {
        diagnosticTrace.push("diagnostics");
        return work(diagnosticPort);
      }
    };
    const selection = {
      enabled: true, graph: "managed" as const, diagnostics,
      authorize: async () => { diagnosticTrace.push("authorize"); return actor; }
    };

  return { selection, diagnosticPort, diagnosticTrace };
}
const segmentRequest = { contractVersion: "customer-diagnostic-history.v1", segmentId: "segment", pageSize: 7, cursor: "segment-cursor" } as const;
const searchRequest = {
  contractVersion: "customer-diagnostic-history.v1", windowStart: "2030-01-01T00:00:00Z",
  windowEnd: "2030-01-02T00:00:00Z", subjectId: "s", pageSize: 3, cursor: "search-cursor"
} as const;
const overviewRequest = {
  contractVersion: "customer-diagnostic-history.v2", windowStart: searchRequest.windowStart,
  windowEnd: searchRequest.windowEnd, pageSize: 5, cursor: "10"
} as const;
it.each(["history", "searchDiagnostics", "overview"] as const)(
  "forwards independent diagnostics without a journey selection: %s", async method => {
    const { selection, diagnosticPort, diagnosticTrace } = diagnosticSelection();
    const binding = createM12SupportReadBinding(selection);
    if (method === "history") {
      expect(await binding.history(segmentRequest)).toBeNull();
      expect(diagnosticPort.readSegment).toHaveBeenCalledExactlyOnceWith({ ...segmentRequest, operatorId: actor.operatorId });
    } else if (method === "searchDiagnostics") {
      expect(await binding.searchDiagnostics(searchRequest)).toBe(await vi.mocked(diagnosticPort.search).mock.results[0]!.value);
      expect(diagnosticPort.search).toHaveBeenCalledExactlyOnceWith({ ...searchRequest, operatorId: actor.operatorId });
    } else {
      expect(await binding.overview(overviewRequest)).toBe(await vi.mocked(diagnosticPort.overview).mock.results[0]!.value);
      expect(diagnosticPort.overview).toHaveBeenCalledExactlyOnceWith({ ...overviewRequest, operatorId: actor.operatorId });
    }
    expect(diagnosticTrace).toEqual(["authorize", "diagnostics"]);
    expect(diagnosticPort.ingest).not.toHaveBeenCalled();
    expect(diagnosticPort.prune).not.toHaveBeenCalled();
  }
);
it.each(["disabled", "denied", "ungoverned machine", "governed machine"] as const)(
  "governs independent diagnostics: %s", async state => {
    const { selection, diagnosticPort, diagnosticTrace } = diagnosticSelection();
    const binding = createM12SupportReadBinding({ ...selection,
      enabled: state !== "disabled",
      authorize: async () => state === "denied" ? null : { ...actor, isMachineActor: true,
        ...(state === "governed machine" ? { governance: { flagEnabled: true } } : {}) }
    });
    if (state === "disabled") expect(await binding.history(segmentRequest)).toEqual({ supported: false, refusalCode: "host_binding_required" });
    else if (state === "denied") expect(await binding.history(segmentRequest)).toEqual({ kind: "denied" });
    else if (state === "ungoverned machine") await expect(binding.history(segmentRequest)).rejects.toThrow("customer_support_agent_read_disabled");
    else expect(await binding.history(segmentRequest)).toBeNull();
    expect(diagnosticTrace).toEqual(state === "governed machine" ? ["diagnostics"] : []);
    expect(diagnosticPort.ingest).not.toHaveBeenCalled();
    expect(diagnosticPort.prune).not.toHaveBeenCalled();
  }
);
it("executes reference type-fit checks", () => {
    const file = fileURLToPath(import.meta.url),
      program = ts.createProgram(
        [file],
        {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          allowImportingTsExtensions: true,
          types: ["node"]
        }
      );
    expect(ts.formatDiagnosticsWithColorAndContext(
      program.getSemanticDiagnostics(program.getSourceFile(file)!),
      { getCanonicalFileName: p => p, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }
    )).toBe("");
  },
  30_000
);

it("keeps a disabled native support selection inert", async () => {
  const authorize = vi.fn(async () => actor);
  expect(await createM12SupportReadBinding({ graph: "native", authorize }).getCustomerJourney({ subjectId: "s", pageSize: 10 }))
    .toEqual({ supported: false, refusalCode: "host_binding_required" });
  expect(authorize).not.toHaveBeenCalled();
});
it.each([false, true])("closes a native support scope on failure=%s", async fails => {
  const trace: string[] = [], authorize = vi.fn(async () => actor);
  const native = createM12SupportReadBinding({ enabled: true, graph: "native", authorize,
    native: { connectionString: "postgres://synthetic", options: {
      createPostgresPort: env => fails ? createPostgresCustomerSupportJourneyPort(env, {
        createLane: () => ({ run: async () => { throw new Error("query_failed"); }, close: async () => { trace.push("failed-closed"); } })
      }) : nativePort(trace)
    } }
  });
  if (fails) await expect(native.getCustomerJourney({ subjectId: "s", pageSize: 10 })).rejects.toThrow();
  else expect(await native.getCustomerJourney({ subjectId: "s", pageSize: 10 })).toBeNull();
  expect(trace.at(-1)).toBe(fails ? "failed-closed" : "closed");
});
it("keeps a disabled account selection inert", async () => {
  const open = vi.fn(async () => ({ client: async () => null, close: async () => {} }));
  expect(await createM12AccountReadSelection({ graph: "native", open }).getAccount("p"))
    .toEqual({ supported: false, refusalCode: "host_binding_required" });
  expect(open).not.toHaveBeenCalled();
});
it.each(["getAccount", "listOrders", "getOrderDetail", "history", "download"] as const)(
  "refuses a missing native capability and closes the scope: %s", async method => {
    const close = vi.fn(async () => {}), client = vi.fn(async () => ({ id: "owned" }));
    const selection = createM12AccountReadSelection({ graph: "native", enabled: true, open: async () => ({ client, close }) });
    const requests = {
      getAccount: () => selection.getAccount("p"), listOrders: () => selection.listOrders("p", { limit: 20 }),
      getOrderDetail: () => selection.getOrderDetail("p", "o"), history: () => selection.history("p", "o"),
      download: () => selection.download("p", "o", "child")
    };
    expect(await requests[method]()).toEqual(method === "history" || method === "download"
      ? { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false }
      : { supported: false, refusalCode: "host_binding_required" });
    expect(close).toHaveBeenCalledOnce();
  }
);
it("denies an unlinked native invoice history and closes the scope", async () => {
  const close = vi.fn(async () => {});
  const missing = createM12AccountReadSelection({ graph: "native", enabled: true,
    open: async () => ({ client: async () => null, close }) });
  expect(await missing.history("p", "o")).toEqual({ kind: "denied" });
  expect(close).toHaveBeenCalledOnce();
});
it("refuses an unlinked managed account before every source and closes the scope", async () => {
  const trace: string[] = [];
    const unexpected = vi.fn(async (): Promise<never> => {
      throw new Error("foreign_read");
    });
    const unlinked = createM12AccountReadSelection({
      graph: "managed",
      enabled: true,
      open: async () => ({
        client: async () => null,
        close: async () => {
          trace.push("unlinked-closed");
        },
        account: {
          sources: {
            readExtension: unexpected,
            readSubscriptionRows: unexpected,
            readAddresses: unexpected,
            readOrdererProfiles: unexpected,
            readPaymentPreferences: unexpected,
            readDeliveryPreferences: unexpected,
            readOrders: unexpected,
            readEvents: unexpected,
            readSubscriptionLines: unexpected,
            readSubscriptionBlockers: unexpected,
            readPauseWindows: unexpected,
            readPaymentEvidence: unexpected,
            readDeliveryAlignments: unexpected,
            readNextCharges: unexpected,
            readActionStates: unexpected
          },
          policy: {
            paymentMethodStatus: () => "missing",
            canUsePaymentMethodForRenewal: () => false,
            packageSummary: () => null,
            withNextCharge: () => ({ recurringPrice: null })
          }
        }
      })
    });
    expect(await unlinked.getAccount("foreign")).toBeNull();
    expect(unexpected).not.toHaveBeenCalled();
    expect(trace.at(-1)).toBe("unlinked-closed");

});

const hostRequired = { supported: false, refusalCode: "host_binding_required" } as const;
it.each(["native"] as const)("sweeps enabled account without an opener: %s", async graph => {
  expect(await createM12AccountReadSelection({ graph, enabled: true }).getAccount("actor")).toEqual(hostRequired);
});
function accountScope() {
  const empty = async () => new Map();
  const sources = {
    readExtension: async () => ({ host: "selected" }), readSubscriptionRows: async () => [], readAddresses: async () => [],
    readOrdererProfiles: async () => [], readPaymentPreferences: async () => [], readDeliveryPreferences: async () => [],
    readOrders: async () => ({ orders: [] }), readEvents: async () => [], readSubscriptionLines: empty,
    readSubscriptionBlockers: empty, readPauseWindows: empty, readPaymentEvidence: empty, readDeliveryAlignments: empty,
    readNextCharges: empty, readActionStates: empty
  };
  const orders: CustomerOrderHistoryReadStore = {
    readCustomerOrders: vi.fn(async () => []), readCustomerOrder: vi.fn(async () => null), readOrderLines: async () => [],
    readPaymentStatuses: empty, readFulfillments: async () => [], readTracking: empty, readFulfillmentOperations: empty,
    readStatusEvidence: empty, readReleasedProviderExceptionHolds: empty, readReleasedProviderExceptionEvidence: empty,
    readActiveHoldOrderIds: async () => new Set(), readInvoiceSummaries: empty
  };
  const client = vi.fn(async (_userId: string): Promise<Record<string, unknown> | null> => ({ id: "owned" }));
  const close = vi.fn(async () => {});
  const read = vi.fn<Local.InvoiceAccessPort["read"]>().mockResolvedValue({ kind: "denied" });
  return { client, close, orders, account: { sources, policy: m12ReferenceAccountProjection(() => null) },
    invoices: { artifacts: { download: vi.fn(async () => ({ kind: "unknown" as const, code: "unknown" as const })) }, accountHistory: { read, resolveDownload: vi.fn<Local.InvoiceAccessPort["resolveDownload"]>().mockResolvedValue({ kind: "denied" }) } } };
}
const accountMethods = ["getAccount", "listOrders", "getOrderDetail", "history", "download"] as const;
it.each(accountMethods.map(method => ({ method, state: "selected" })).concat(
  ["listOrders", "getOrderDetail", "download"].map(method => ({ method: method as typeof accountMethods[number], state: "unlinked" })),
  [{ method: "getAccount", state: "source throws" }]
))(
  "sweeps account selection: $method / $state", async ({ method, state }) => {
    const scope = accountScope();
    if (state === "selected" && method === "download") scope.invoices.accountHistory.read.mockResolvedValue({
      kind: "found", accountRef: "owned", orderId: "target", documents: [{ documentRef: "child", invoiceRef: "parent",
        parentDocumentRef: "parent", role: "correction", status: "issued", issuedAt: null, clearance: null,
        documentKind: null, artifact: "correction", providerDocumentNumber: null, totalGrossMinor: -50, currency: "EUR",
        emailState: "not_requested", isCurrent: true, createdAt: "2030-01-01", downloadAvailable: true }]
    });
    if (state === "unlinked") scope.client.mockResolvedValue(null);
    if (state === "source throws") scope.client.mockRejectedValue(new Error("client_read_failed"));
    const open = vi.fn(async () => scope);
    const binding = createM12AccountReadSelection({ graph: "managed", enabled: true, open });
    const requests = { getAccount: () => binding.getAccount("principal"), listOrders: () => binding.listOrders("principal", { limit: 7 }),
      getOrderDetail: () => binding.getOrderDetail("principal", "target"), history: () => binding.history("principal", "target"),
      download: () => binding.download("principal", "target", "child") };
    if (state === "source throws") await expect(requests[method]()).rejects.toThrow("client_read_failed");
    else {
      const result = await requests[method]();
      if (state === "unlinked") expect(result).toEqual(method === "history" || method === "download" ? { kind: "denied" } : null);
      else if (method === "getAccount") expect(result).toMatchObject({ contractVersion: "customer.account.v3", extension: { host: "selected" }, profile: { clientId: "owned" } });
      else if (method === "listOrders") expect(result).toEqual({ contractVersion: "customer.orders.v2", orders: [] });
      else if (method === "getOrderDetail") expect(result).toBeNull();
      else expect(result).toEqual({ kind: "denied" });
    }
    expect(open).toHaveBeenCalledOnce();
    expect(scope.client).toHaveBeenCalledExactlyOnceWith("principal");
    expect(scope.close).toHaveBeenCalledOnce();
    if (state === "selected" && method === "listOrders") expect(scope.orders.readCustomerOrders).toHaveBeenCalledExactlyOnceWith("owned", ["cancelled", "expired"], 7);
    else expect(scope.orders.readCustomerOrders).not.toHaveBeenCalled();
    if (state === "selected" && method === "getOrderDetail") expect(scope.orders.readCustomerOrder).toHaveBeenCalledExactlyOnceWith("owned", "target");
    else expect(scope.orders.readCustomerOrder).not.toHaveBeenCalled();
    if (state === "selected" && (method === "history" || method === "download")) expect(scope.invoices.accountHistory.read).toHaveBeenCalledExactlyOnceWith({ accountRef: "owned", orderId: "target" });
    else expect(scope.invoices.accountHistory.read).not.toHaveBeenCalled();
    if (state === "selected" && method === "download") expect(scope.invoices.accountHistory.resolveDownload).toHaveBeenCalledExactlyOnceWith({ accountRef: "owned", orderId: "target", documentRef: "child" });
  }
);
it.each(["searchCustomerJourney", "getCustomerJourney", "getPortableSummary"] as const)(
  "sweeps missing support graph capability: %s", async method => {
    const authorize = vi.fn(async () => actor);
    const binding = createM12SupportReadBinding({ enabled: true, graph: "native", authorize });
    expect(await (method === "getPortableSummary" ? binding.getPortableSummary({}) : binding[method]({ subjectId: "s", pageSize: 7 }))).toEqual(hostRequired);
    expect(authorize).toHaveBeenCalledOnce();
  }
);
it.each(["history", "searchDiagnostics", "overview"] as const)(
  "sweeps missing diagnostics scope: %s", async method => {
    const binding = createM12SupportReadBinding({ enabled: true, graph: "managed", authorize: async () => actor });
    const requests = { history: () => binding.history(segmentRequest), searchDiagnostics: () => binding.searchDiagnostics(searchRequest), overview: () => binding.overview(overviewRequest) };
    expect(await requests[method]()).toEqual(hostRequired);
  }
);
it.each(["getCustomerJourney", "getPortableSummary"] as const)(
  "sweeps managed support forwarding: %s", async method => {
    const read = vi.fn(async () => null), actors: unknown[] = [];
    const managed: NonNullable<Parameters<typeof createM12SupportReadBinding>[0]["managed"]> = {
      async run(scoped, work) {
        actors.push(scoped);
        return work({ [method]: read } as unknown as Parameters<typeof work>[0]);
      }
    };
    const binding = createM12SupportReadBinding({ enabled: true, graph: "managed", authorize: async () => actor,
      managed });
    const request = { subjectId: "s", pageSize: 7 };
    expect(await (method === "getPortableSummary" ? binding.getPortableSummary({}) : binding[method](request))).toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith(method === "getPortableSummary" ? {} : request);
    expect(actors[0]).toEqual({ ...actor, intent: "read" });
  }
);
it.each(["legacy pointers", "non-string pointers"])("sweeps reference payment projection: %s", name => {
  const selected = m12ReferenceAccountProjection(() => null);
  expect(selected.paymentMethodStatus({ clientId: "owned", clientEmail: null,
    row: name === "legacy pointers" ? { payment_method_kind: "card", payment_method_ref: "legacy" } : { payment_method_kind: 1, payment_method_ref: 2 },
    evidence: undefined })).toBe(name === "legacy pointers" ? "invalid" : "missing");
});
