import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseCustomerSubscriptionFacadePort } from "./customerSubscriptionFacade.js";

describe("createSupabaseCustomerSubscriptionFacadePort", () => {
  it("records line-edit preview quotes in the durable quote ledger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));
    const rpc = vi.fn(async () => ({ data: { quotePreview: { id: "quote-line-1" } }, error: null }));
    const customerClient = fakeClient({
      clients: { id: "client-1" },
      subscriptions: {
        id: "5b000000-0000-0000-0000-000000000001",
        status: "active",
        next_cycle_at: "2026-09-01T00:00:00.000Z",
        edit_window_hours: 72,
        payment_method_kind: "card",
        payment_method_ref: "pm_1",
        template_version: 4,
      },
    });
    const serviceClient = fakeClient({
      commerce_payment_method_refs: [activeMethodRef()],
      subscription_dunning_cases: [],
      subscription_cycles: [],
      commerce_orders: [],
    }, rpc);
    const repricedLines = [
      { lineId: "33333333-3333-4333-8333-333333333333", quoteLine: { sku: "SNACK", quantity: 2 } },
    ];
    const port = createSupabaseCustomerSubscriptionFacadePort({
      customerClient,
      serviceClient,
      subscriptionRepricer: {
        repriceForEdit: vi.fn(async () => ({
          quoteHash: "b".repeat(64),
          expectedTemplateVersion: 4,
          repricedLines,
        })),
      } as never,
    });

    try {
      const result = await port.previewAction("user-1", {
        subscriptionAction: {
          action: "update_addon_quantity",
          idempotencyKey: "preview-addon-1",
          subscriptionId: "5b000000-0000-0000-0000-000000000001",
          variantId: "22222222-2222-4222-8222-222222222222",
          qty: 2,
        },
      });

      expect(result?.preview.quoteHash).toBe("b".repeat(64));
      expect(result?.preview.quoteExpiresAt).toBe("2026-07-10T10:15:00.000Z");
      expect(rpc).toHaveBeenCalledWith(
        "customer_self_service_record_subscription_quote_preview",
        expect.objectContaining({
          p_auth_user_id: "user-1",
          p_subscription_id: "5b000000-0000-0000-0000-000000000001",
          p_action: "update_addon_quantity",
          p_quote_hash: "b".repeat(64),
          p_template_version: 4,
          p_request_payload: expect.objectContaining({
            action: "update_addon_quantity",
            variantId: "22222222-2222-4222-8222-222222222222",
            qty: 2,
          }),
          p_quote_snapshot: { repricedLines },
          p_totals: {},
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records recipe-set preview quotes in the durable quote ledger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));
    const rpc = vi.fn(async () => ({ data: { quotePreview: { id: "quote-recipe-1" } }, error: null }));
    const customerClient = fakeClient({
      clients: { id: "client-1" },
      subscriptions: {
        id: "5b000000-0000-0000-0000-000000000001",
        status: "active",
        next_cycle_at: "2026-09-01T00:00:00.000Z",
        edit_window_hours: 72,
        payment_method_kind: "card",
        payment_method_ref: "pm_1",
        template_version: 6,
      },
    });
    const serviceClient = fakeClient({
      commerce_payment_method_refs: [activeMethodRef()],
      subscription_dunning_cases: [],
      subscription_cycles: [],
      commerce_orders: [],
    }, rpc);
    const recipeLines = [
      { variantId: "11111111-1111-4111-8111-111111111111", qty: 5, quoteLine: { sku: "LAMB" } },
    ];
    const addonLines = [
      { lineId: "33333333-3333-4333-8333-333333333333", quoteLine: { sku: "SNACK" } },
    ];
    const port = createSupabaseCustomerSubscriptionFacadePort({
      customerClient,
      serviceClient,
      subscriptionRepricer: {
        repriceRecipeSet: vi.fn(async () => ({
          quoteHash: "c".repeat(64),
          expectedTemplateVersion: 6,
          recipeLines,
          addonLines,
        })),
      } as never,
    });

    try {
      const result = await port.previewAction("user-1", {
        subscriptionAction: {
          action: "update_plan_length",
          idempotencyKey: "preview-plan-1",
          subscriptionId: "5b000000-0000-0000-0000-000000000001",
          planDays: 21,
        },
      });

      expect(result?.preview.quoteHash).toBe("c".repeat(64));
      expect(result?.preview.quoteExpiresAt).toBe("2026-07-10T10:15:00.000Z");
      expect(rpc).toHaveBeenCalledWith(
        "customer_self_service_record_subscription_quote_preview",
        expect.objectContaining({
          p_action: "update_plan_length",
          p_quote_hash: "c".repeat(64),
          p_template_version: 6,
          p_request_payload: expect.objectContaining({
            action: "update_plan_length",
            planDays: 21,
          }),
          p_quote_snapshot: { recipeLines, addonLines },
          p_totals: {},
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records package-template preview quotes in the durable quote ledger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));
    const rpc = vi.fn(async () => ({ data: { quotePreview: { id: "quote-1" } }, error: null }));
    const money = { amountMinor: 5000, currency: "PLN" as const };
    const newMoney = { amountMinor: 6200, currency: "PLN" as const };
    const delta = { amountMinor: 1200, currency: "PLN" as const };
    const customerClient = fakeClient({
      clients: { id: "client-1" },
      subscriptions: {
        id: "5b000000-0000-0000-0000-000000000001",
        status: "active",
        next_cycle_at: "2026-09-01T00:00:00.000Z",
        edit_window_hours: 72,
        payment_method_kind: "card",
        payment_method_ref: "pm_1",
        template_version: 3,
      },
    });
    const serviceClient = fakeClient({
      commerce_payment_method_refs: [activeMethodRef()],
      subscription_dunning_cases: [],
      subscription_cycles: [],
      commerce_orders: [],
    }, rpc);
    const port = createSupabaseCustomerSubscriptionFacadePort({
      customerClient,
      serviceClient,
      subscriptionRepricer: {
        previewPackageEdit: vi.fn(async () => ({
          currentRecurringPrice: money,
          newRecurringPrice: newMoney,
          delta,
          quoteHash: "a".repeat(64),
          expectedTemplateVersion: 3,
          recipeLines: [{ variantId: "11111111-1111-4111-8111-111111111111", qty: 4, quoteLine: { sku: "LAMB" } }],
          addonLines: [{ variantId: "22222222-2222-4222-8222-222222222222", qty: 1, quoteLine: { sku: "SNACK" } }],
        })),
      } as never,
    });

    try {
      const result = await port.previewAction("user-1", {
        subscriptionAction: {
          action: "update_package_template",
          idempotencyKey: "preview-package-1",
          subscriptionId: "5b000000-0000-0000-0000-000000000001",
          planDays: 28,
          recipes: [{ variantId: "11111111-1111-4111-8111-111111111111", qty: 4 }],
          addons: [{ variantId: "22222222-2222-4222-8222-222222222222", qty: 1 }],
        },
      });

      expect(result?.preview.quoteHash).toBe("a".repeat(64));
      expect(result?.preview.quoteExpiresAt).toBe("2026-07-10T10:15:00.000Z");
      expect(rpc).toHaveBeenCalledWith(
        "customer_self_service_record_subscription_quote_preview",
        expect.objectContaining({
          p_auth_user_id: "user-1",
          p_subscription_id: "5b000000-0000-0000-0000-000000000001",
          p_action: "update_package_template",
          p_quote_hash: "a".repeat(64),
          p_template_version: 3,
          p_quote_expires_at: "2026-07-10T10:15:00.000Z",
          p_request_payload: expect.objectContaining({
            action: "update_package_template",
            idempotencyKey: "preview-package-1",
          }),
          p_quote_snapshot: {
            recipeLines: [{ variantId: "11111111-1111-4111-8111-111111111111", qty: 4, quoteLine: { sku: "LAMB" } }],
            addonLines: [{ variantId: "22222222-2222-4222-8222-222222222222", qty: 1, quoteLine: { sku: "SNACK" } }],
          },
          p_totals: {
            currentRecurringPrice: money,
            newRecurringPrice: newMoney,
            delta,
          },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches packageEdit to the preview when the generic-bundle flag rewrites update_package_template (CJ57-A)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));
    const rpc = vi.fn(async () => ({ data: { quotePreview: { id: "quote-pkg-generic" } }, error: null }));
    const currentRecurringPrice = { amountMinor: 61640, currency: "PLN" as const };
    const newRecurringPrice = { amountMinor: 58200, currency: "PLN" as const };
    const recipeSetHash = "d".repeat(64);
    const customerClient = fakeClient({
      clients: { id: "client-1" },
      subscriptions: {
        id: "5b000000-0000-0000-0000-000000000001",
        status: "active",
        next_cycle_at: "2026-09-01T00:00:00.000Z",
        edit_window_hours: 72,
        payment_method_kind: "card",
        payment_method_ref: "pm_1",
        template_version: 7,
      },
    });
    const serviceClient = fakeClient({
      commerce_payment_method_refs: [activeMethodRef()],
      subscription_dunning_cases: [],
      subscription_cycles: [],
      commerce_orders: [],
    }, rpc);
    const repriceRecipeSet = vi.fn(async () => ({
      quoteHash: recipeSetHash,
      expectedTemplateVersion: 7,
      recipeLines: [{ variantId: "11111111-1111-4111-8111-111111111111", qty: 4, quoteLine: { sku: "LAMB" } }],
      addonLines: [],
      currentRecurringPrice,
      newRecurringPrice,
    }));
    const port = createSupabaseCustomerSubscriptionFacadePort({
      customerClient,
      serviceClient,
      genericBundleActionsEnabled: true,
      subscriptionRepricer: { repriceRecipeSet } as never,
    });

    try {
      const result = await port.previewAction("user-1", {
        subscriptionAction: {
          action: "update_package_template",
          idempotencyKey: "preview-package-generic",
          subscriptionId: "5b000000-0000-0000-0000-000000000001",
          planDays: 28,
          recipes: [{ variantId: "11111111-1111-4111-8111-111111111111", qty: 4 }],
          addons: [],
        },
      });

      // The flag rewrote update_package_template → update_bundle, so the recipe-set
      // repricer runs (not previewPackageEdit) with the source action threaded through.
      expect(repriceRecipeSet).toHaveBeenCalledWith(
        expect.objectContaining({ action: "update_bundle", sourceAction: "update_package_template" }),
      );
      // packageEdit must be populated (the editor hard-requires it) and its quoteHash
      // must be the SAME canonical recipe-set hash the apply path validates.
      expect(result?.preview.packageEdit).toEqual({
        currentRecurringPrice,
        newRecurringPrice,
        delta: { amountMinor: newRecurringPrice.amountMinor - currentRecurringPrice.amountMinor, currency: "PLN" },
        quoteHash: recipeSetHash,
        effectiveCycleAt: "2026-09-01T00:00:00.000Z",
        priceAgreementPolicy: "lock_until_edit",
      });
      expect(result?.preview.quoteHash).toBe(recipeSetHash);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start account reads before ownership and fans out payment, blockers, and address reads after it", async () => {
    const clientOwnership = deferredResult<{ id: string; email: string | null }>();
    const subscriptionOwnership = deferredResult<Record<string, unknown>>();
    const customerFrom = vi.fn((table: string) => {
      if (table === "clients") return deferredSingleBuilder(clientOwnership.promise);
      if (table === "subscriptions") return deferredSingleBuilder(subscriptionOwnership.promise);
      if (table === "addresses") return tableResponse({ id: "address-1" });
      throw new Error(`unexpected customer table ${table}`);
    });
    const serviceFrom = vi.fn((table: string) => tableResponse(
      table === "commerce_payment_method_refs" ? [activeMethodRef()] : [],
    ));
    const port = createSupabaseCustomerSubscriptionFacadePort({
      customerClient: { from: customerFrom } as unknown as SupabaseClient,
      serviceClient: { from: serviceFrom } as unknown as SupabaseClient,
    });

    const pending = port.previewAction("user-1", {
      subscriptionAction: {
        action: "change_shipping_address",
        idempotencyKey: "preview-address-fanout",
        subscriptionId: "sub-1",
        shippingAddressId: "address-1",
      },
    });
    await Promise.resolve();
    expect(customerFrom).toHaveBeenCalledWith("clients");
    expect(customerFrom).not.toHaveBeenCalledWith("subscriptions");
    expect(serviceFrom).not.toHaveBeenCalled();

    clientOwnership.resolve({ data: { id: "client-1", email: "customer@example.test" }, error: null });
    await vi.waitFor(() => expect(customerFrom).toHaveBeenCalledWith("subscriptions"));
    expect(serviceFrom).not.toHaveBeenCalled();

    subscriptionOwnership.resolve({
      data: {
        id: "sub-1",
        status: "active",
        next_cycle_at: "2026-09-01T00:00:00.000Z",
        edit_window_hours: 72,
        payment_method_kind: "card",
        payment_method_ref: "pm_1",
        template_version: 1,
      },
      error: null,
    });
    await vi.waitFor(() => {
      expect(serviceFrom).toHaveBeenCalledWith("commerce_payment_method_refs");
      expect(serviceFrom).toHaveBeenCalledWith("subscription_dunning_cases");
      expect(serviceFrom).toHaveBeenCalledWith("subscription_cycles");
      expect(serviceFrom).toHaveBeenCalledWith("commerce_orders");
      expect(customerFrom).toHaveBeenCalledWith("addresses");
    });
    await expect(pending).resolves.toMatchObject({
      preview: { subscriptionId: "sub-1", canApply: true, blockedReason: null },
    });
  });

  it("starts payment recovery by minting a customer-safe token URL and requeueing dunning notification", async () => {
    const tokenRotate = vi.fn(async () => ({ data: "token-1", error: null }));
    const notificationKind = vi.fn(async () => ({ error: null }));
    const notificationUpdate = vi.fn(() => ({
      eq: vi.fn(() => ({ eq: vi.fn(() => ({ in: notificationKind })) })),
    }));
    const customerClient = fakeClient({
      clients: { id: "client-1" },
      subscriptions: {
        id: "sub-1",
        status: "active",
        next_cycle_at: "2026-07-10T10:00:00.000Z",
        edit_window_hours: 72,
        payment_method_kind: "card",
        payment_method_ref: "pm_1",
        template_version: 1,
      },
    });
    const serviceClient = fakeClient({
      subscription_dunning_cases: {
        id: "case-1",
        subscription_id: "sub-1",
        cycle_id: "cycle-1",
        order_id: "order-1",
        client_id: "client-1",
        status: "open",
        next_retry_at: "2026-07-02T10:00:00.000Z",
      },
      subscription_dunning_notifications: { update: notificationUpdate },
    }, tokenRotate);
    const port = createSupabaseCustomerSubscriptionFacadePort({ customerClient, serviceClient });

    const result = await port.startPaymentRecovery("user-1", {
      idempotencyKey: "recover-payment-1",
      subscriptionId: "sub-1",
    });

    expect(result).toEqual({
      recoverable: true,
      recoveryUrlPath: expect.stringMatching(/^\/konto\/platnosc\/napraw\?token=rcv_/),
      caseId: "case-1",
      expiresAt: expect.any(String),
      nextRetryAt: "2026-07-02T10:00:00.000Z",
    });
    expect(tokenRotate).toHaveBeenCalledWith("subscription_rotate_payment_recovery_token", expect.objectContaining({
      p_case_id: "case-1",
      p_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_source: "customer_payment_recovery_start",
    }));
    expect(notificationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: "queued",
      provider_error: null,
      send_attempts: 0,
    }));
    expect(notificationKind).toHaveBeenCalledWith("notification_kind", ["payment_failed", "payment_expired"]);
  });

  it("returns a safe non-recoverable reason when the subscription is not owned", async () => {
    const port = createSupabaseCustomerSubscriptionFacadePort({
      customerClient: fakeClient({ clients: { id: "client-1" }, subscriptions: null }),
      serviceClient: fakeClient({}),
    });

    await expect(port.startPaymentRecovery("user-1", {
      idempotencyKey: "recover-payment-2",
      subscriptionId: "sub-2",
    })).resolves.toEqual({ recoverable: false, reason: "subscription_not_found" });
  });
});

function fakeClient(rows: Record<string, unknown>, rpc?: ReturnType<typeof vi.fn>): SupabaseClient {
  return {
    rpc: rpc ?? vi.fn(async () => ({ data: null, error: null })),
    from(table: string) {
      const row = rows[table];
      return {
        select: vi.fn(() => queryBuilder(row)),
        update: vi.fn((payload: unknown) => {
          const updater = row as { update?: (payload: unknown) => unknown };
          return updater.update?.(payload) ?? queryBuilder(null);
        }),
        insert: vi.fn((payload: unknown) => {
          const inserter = row as { insert?: (payload: unknown) => unknown };
          return inserter.insert?.(payload) ?? Promise.resolve({ error: null });
        }),
      };
    },
  } as unknown as SupabaseClient;
}

function activeMethodRef() {
  return {
    client_id: "client-1",
    provider_kind: "stripe",
    provider_customer_ref: "cus_1",
    provider_method_ref: "pm_1",
    method_kind: "card",
    status: "active",
    active: true,
    expires_at: null,
  };
}

function queryBuilder(row: unknown) {
  const resultRows = Array.isArray(row) ? row : row == null ? [] : [row];
  const builder = {
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: Array.isArray(row) ? row[0] ?? null : row, error: null })),
    then: (
      onFulfilled?: (value: { data: unknown[]; error: null }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: resultRows, error: null }).then(onFulfilled, onRejected),
  };
  return builder;
}

function tableResponse(row: unknown) {
  return { select: vi.fn(() => queryBuilder(row)) };
}

function deferredResult<T>() {
  let resolve!: (value: { data: T; error: null }) => void;
  const promise = new Promise<{ data: T; error: null }>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deferredSingleBuilder(result: Promise<{ data: unknown; error: null }>) {
  const builder = {
    eq: vi.fn(() => builder),
    select: vi.fn(() => builder),
    maybeSingle: vi.fn(() => result),
  };
  return builder;
}
