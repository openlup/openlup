import { describe, expect, it, vi } from "vitest";
import type { PaymentMethodLifecycleEvent } from "@openlup/core/payment";
import type { NormalizedProviderPaymentWebhook } from "../../../domains/payment/paymentWebhookHandlers.js";
import {
  applyPaymentMethodLifecycleEvent,
  type PaymentMethodLifecycleClient,
} from "./paymentMethodLifecycle.js";
import {
  expiryForMethodRefWrite,
  methodFactSnapshotKeys,
  readMethodLifecycleEvent,
} from "../../../domains/payment/paymentMethodLifecycle.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION_ID = "22222222-2222-4222-8222-222222222222";
const REF_ID = "33333333-3333-4333-8333-333333333333";

function storedRef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REF_ID,
    client_id: CLIENT_ID,
    subscription_id: SUBSCRIPTION_ID,
    method_kind: "card",
    provider_customer_ref: "cus_1",
    provider_mandate_ref: null,
    status: "active",
    active: true,
    expires_at: null,
    consent_snapshot: { source: "rail_webhook", recurringModel: "O" },
    raw_provider_payload: { eventId: "evt_origin" },
    ...overrides,
  };
}

function lifecycleClient(row: Record<string, unknown> | null) {
  const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const builder = { select: () => builder, eq: () => builder, maybeSingle } as unknown as ReturnType<PaymentMethodLifecycleClient["from"]>;
  const from = vi.fn().mockReturnValue(builder);
  return { client: { rpc, from } as unknown as PaymentMethodLifecycleClient, rpc, from, maybeSingle };
}

function event(overrides: Partial<PaymentMethodLifecycleEvent> = {}): PaymentMethodLifecycleEvent {
  return {
    kind: "method_revoked",
    providerKind: "rail-a",
    providerMethodRef: "ref_1",
    providerEventId: "evt_1",
    occurredAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

describe("reading a lifecycle transition off a delivery", () => {
  it("returns the transition a delivery carries", () => {
    const carried = event();
    const webhook = { methodLifecycle: carried } as unknown as NormalizedProviderPaymentWebhook;
    expect(readMethodLifecycleEvent(webhook)).toBe(carried);
  });

  it.each([
    ["nothing at all", undefined],
    ["an explicit null", null],
    ["an unpublished kind", { ...event(), kind: "method_deleted" }],
    ["no method reference", { ...event(), providerMethodRef: "" }],
    ["no rail", { ...event(), providerKind: "  " }],
    ["no delivery identity", { ...event(), providerEventId: "" }],
    ["no instant", { ...event(), occurredAt: "" }],
  ])("refuses a delivery carrying %s", (_label, methodLifecycle) => {
    const webhook = { methodLifecycle } as unknown as NormalizedProviderPaymentWebhook;
    expect(readMethodLifecycleEvent(webhook)).toBeNull();
  });
});

describe("consuming a lifecycle transition", () => {
  it.each(["method_revoked", "method_expired", "method_suspended"] as const)(
    "deactivates the addressed method on %s",
    async (kind) => {
      const { client, rpc } = lifecycleClient(storedRef());
      const result = await applyPaymentMethodLifecycleEvent(client, event({ kind }));

      expect(result).toEqual({ outcome: "deactivated", reason: null });
      expect(rpc).toHaveBeenCalledWith("commerce_payment_method_ref_deactivate", {
        p_idempotency_key: "provider-webhook:rail-a:evt_1:method-lifecycle",
        p_method_ref_id: REF_ID,
        p_reason: kind,
        p_metadata: {
          lifecycleKind: kind,
          providerEventId: "evt_1",
          occurredAt: "2026-08-07T10:00:00.000Z",
        },
      });
    },
  );

  // ⛔ The rotation pin at the consumption end. An update must never reach the
  // deactivation RPC: the consent is unchanged and the subscription still
  // renews on this method.
  it("refreshes the facts of an updated method and leaves it active", async () => {
    const { client, rpc } = lifecycleClient(storedRef());
    const result = await applyPaymentMethodLifecycleEvent(client, event({
      kind: "method_updated",
      replacement: { schemeLabel: "visa", lastDigits: "8210", expiresAt: "2029-11-30T23:59:59.999Z" },
    }));

    expect(result).toEqual({ outcome: "metadata_refreshed", reason: null });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("commerce_payment_method_ref_upsert", {
      p_idempotency_key: "provider-webhook:rail-a:evt_1:method-lifecycle",
      p_client_id: CLIENT_ID,
      p_subscription_id: SUBSCRIPTION_ID,
      p_provider_kind: "rail-a",
      p_method_kind: "card",
      p_provider_customer_ref: "cus_1",
      p_provider_method_ref: "ref_1",
      p_provider_mandate_ref: null,
      p_status: "active",
      p_active: true,
      p_expires_at: "2029-11-30T23:59:59.999Z",
      p_consent_snapshot: {
        source: "rail_webhook",
        // The recorded consent evidence the health view classifies on survives
        // the refresh; a wholesale replace here would silently reclassify the
        // subscription.
        recurringModel: "O",
        methodScheme: "visa",
        methodLastDigits: "8210",
        methodExpiresAt: "2029-11-30T23:59:59.999Z",
      },
      p_raw_provider_payload: { eventId: "evt_origin" },
    });
  });

  it("keeps the stored expiry when the rail republishes only digits", async () => {
    const { client, rpc } = lifecycleClient(storedRef({ expires_at: "2030-01-31T23:59:59.999Z" }));
    await applyPaymentMethodLifecycleEvent(client, event({
      kind: "method_updated",
      replacement: { schemeLabel: null, lastDigits: "0001", expiresAt: null },
    }));

    expect(rpc).toHaveBeenCalledWith(
      "commerce_payment_method_ref_upsert",
      expect.objectContaining({ p_expires_at: "2030-01-31T23:59:59.999Z" }),
    );
  });

  // The storage invariant refuses an active row whose expiry is already past,
  // and a webhook that raises becomes a retry that can never succeed. A refresh
  // that arrives already dead is therefore consumed as the expiry it is.
  it("consumes a refresh whose fresh expiry is already past as an expiry", async () => {
    const { client, rpc } = lifecycleClient(storedRef());
    const result = await applyPaymentMethodLifecycleEvent(client, event({
      kind: "method_updated",
      replacement: { schemeLabel: "visa", lastDigits: "4242", expiresAt: "2026-07-31T23:59:59.999Z" },
    }));

    expect(result.outcome).toBe("deactivated");
    expect(rpc).toHaveBeenCalledWith(
      "commerce_payment_method_ref_deactivate",
      expect.objectContaining({ p_reason: "method_expired" }),
    );
  });

  it("is a no-op when the transition outran the registration it belongs to", async () => {
    const { client, rpc } = lifecycleClient(null);
    const result = await applyPaymentMethodLifecycleEvent(client, event());

    expect(result).toEqual({ outcome: "skipped", reason: "method_ref_absent" });
    expect(rpc).not.toHaveBeenCalled();
  });

  // Redelivery safety: the rail retries for days, and a second deactivation
  // must not re-stamp a deactivation instant or a reason.
  it("is a no-op when the addressed method is already inactive", async () => {
    const { client, rpc } = lifecycleClient(storedRef({ active: false, status: "inactive" }));
    const result = await applyPaymentMethodLifecycleEvent(client, event());

    expect(result).toEqual({ outcome: "skipped", reason: "method_ref_already_inactive" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("writes a redelivered refresh under the same idempotency key", async () => {
    const facts = { schemeLabel: "visa", lastDigits: "8210", expiresAt: "2029-11-30T23:59:59.999Z" };
    const first = lifecycleClient(storedRef());
    const second = lifecycleClient(storedRef());
    await applyPaymentMethodLifecycleEvent(first.client, event({ kind: "method_updated", replacement: facts }));
    await applyPaymentMethodLifecycleEvent(second.client, event({ kind: "method_updated", replacement: facts }));

    expect(first.rpc.mock.calls[0]).toEqual(second.rpc.mock.calls[0]);
  });

  it("does nothing for a transition that publishes no facts to refresh", async () => {
    const { client, rpc } = lifecycleClient(storedRef());
    const result = await applyPaymentMethodLifecycleEvent(client, event({ kind: "method_registered" }));

    expect(result).toEqual({ outcome: "skipped", reason: "no_published_facts" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("addresses the row by rail and method reference, which is the table's unique key", async () => {
    const eqCalls: Array<[string, unknown]> = [];
    const maybeSingle = vi.fn().mockResolvedValue({ data: storedRef(), error: null });
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => { eqCalls.push([column, value]); return builder; },
      maybeSingle,
    };
    const client = { rpc: vi.fn().mockResolvedValue({ data: {}, error: null }), from: () => builder } as unknown as PaymentMethodLifecycleClient;

    await applyPaymentMethodLifecycleEvent(client, event());

    expect(eqCalls).toEqual([["provider_kind", "rail-a"], ["provider_method_ref", "ref_1"]]);
  });

  it("surfaces a failed lookup rather than silently skipping the transition", async () => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: new Error("boom") }),
    };
    const client = { rpc: vi.fn(), from: () => builder } as unknown as PaymentMethodLifecycleClient;

    await expect(applyPaymentMethodLifecycleEvent(client, event())).rejects.toThrow("boom");
  });
});

describe("stored fact snapshot keys", () => {
  it("emits only the facts a rail actually published", () => {
    expect(methodFactSnapshotKeys(null)).toEqual({});
    expect(methodFactSnapshotKeys({ schemeLabel: null, lastDigits: "4242", expiresAt: null }))
      .toEqual({ methodLastDigits: "4242" });
    expect(methodFactSnapshotKeys({ schemeLabel: "visa", lastDigits: "4242", expiresAt: "2027-06-30T23:59:59.999Z" }))
      .toEqual({ methodScheme: "visa", methodLastDigits: "4242", methodExpiresAt: "2027-06-30T23:59:59.999Z" });
  });
});

describe("the expiry a method-ref write may claim", () => {
  const occurredAt = "2026-08-07T10:00:00.000Z";

  it("writes a future expiry", () => {
    expect(expiryForMethodRefWrite({ methodExpiresAt: "2027-06-30T23:59:59.999Z" }, occurredAt, true))
      .toBe("2027-06-30T23:59:59.999Z");
  });

  // The active row would be refused by storage, and the refusal would become a
  // provider retry that can never succeed.
  it("refuses a past expiry on an active write", () => {
    expect(expiryForMethodRefWrite({ methodExpiresAt: "2026-07-31T23:59:59.999Z" }, occurredAt, true)).toBeNull();
  });

  it("keeps a past expiry on a non-active write, where the invariant does not apply", () => {
    expect(expiryForMethodRefWrite({ methodExpiresAt: "2026-07-31T23:59:59.999Z" }, occurredAt, false))
      .toBe("2026-07-31T23:59:59.999Z");
  });

  it.each([
    ["an absent snapshot", undefined],
    ["a snapshot without the key", { source: "rail_webhook" }],
    ["a blank value", { methodExpiresAt: "   " }],
    ["an unparseable value", { methodExpiresAt: "not-a-date" }],
    ["a non-string value", { methodExpiresAt: 1800000000 }],
  ])("claims no expiry for %s", (_label, snapshot) => {
    expect(expiryForMethodRefWrite(snapshot as Record<string, unknown> | undefined, occurredAt, true)).toBeNull();
  });
});
