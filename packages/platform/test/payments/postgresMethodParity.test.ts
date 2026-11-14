import { describe, expect, it, vi } from "vitest";
import type { PaymentMethodLifecycleEvent } from "@openlup/core/payment";
import type { NormalizedProviderPaymentWebhook } from "../../src/payments/verifiedIngress.js";
import { applyPostgresPaymentMethodLifecycleEvent as applyPaymentMethodLifecycleEvent,
  schedulePostgresRetryOnDurableMethodUpdate as scheduleRetryOnDurableMethodUpdate } from "../../src/payments/postgresPaymentMethods.js";

// Trace the native SQL arguments as named RPC inputs, without changing adapter logic.
const upsertKeys = ["idempotency_key", "client_id", "subscription_id", "provider_kind", "method_kind", "provider_customer_ref", "provider_method_ref", "provider_mandate_ref", "status", "active", "expires_at", "consent_snapshot", "raw_provider_payload"];
function named(keys: string[], values: unknown[]) {
  return Object.fromEntries(keys.map((key, index) => [`p_${key}`, ["consent_snapshot", "raw_provider_payload", "metadata"].includes(key) && typeof values[index] === "string" ? JSON.parse(values[index] as string) : values[index]]));
}
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
  const rpc = vi.fn();
  const client = { async query(sql: string, values: unknown[] = []) {
    if (sql.includes("public.payment_method_ref_read(")) return { rows: [{ response: row ? { provider_kind: "rail-a", provider_method_ref: "ref_1", open_case_id: null, ...row } : null }] };
    if (sql.includes("public.payment_method_ref_upsert(")) {
      rpc("commerce_payment_method_ref_upsert", named(upsertKeys, values));
      return { rows: [{ response: { paymentMethodRef: { id: REF_ID, replayed: false } } }] };
    }
    if (sql.includes("public.payment_method_ref_deactivate(")) {
      rpc("commerce_payment_method_ref_deactivate", named(["idempotency_key", "method_ref_id", "reason", "metadata"], values));
      return { rows: [{ response: {} }] };
    }
    throw new Error(`Unexpected lifecycle SQL: ${sql}`);
  } };
  return { client, rpc };
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


});

const METHOD_REF = "method-ref-1", CASE_ID = "44444444-4444-4444-8444-444444444444";
const USABLE_REF = { subscription_id: SUBSCRIPTION_ID, status: "active", active: true }, OPEN_CASE = { id: CASE_ID };
function fakeClient(rows: Record<string, Record<string, unknown> | undefined>) {
  const rpc = vi.fn();
  const client = { async query(sql: string, values: unknown[] = []) {
    if (sql.includes("public.payment_method_ref_read(")) {
      const row = rows.commerce_payment_method_refs;
      return { rows: [{ response: row ? { ...storedRef(), provider_kind: RAIL, provider_method_ref: METHOD_REF,
        open_case_id: rows.subscription_dunning_cases?.id ?? null, ...row } : null }] };
    }
    if (sql.includes("public.subscription_try_schedule_recovery_retry(")) {
      rpc("subscription_try_schedule_recovery_retry", named(["case_id", "payment_method_ref", "requested_at", "entry"], values));
      return { rows: [{ response: { scheduled: true, reason: "ready" } }] };
    }
    throw new Error(`Unexpected retry SQL: ${sql}`);
  } };
  return { client, rpc };
}
describe("retry on a durable native method update", () => {
  it("schedules on a rotation exactly as on a registration", async () => {
    const { client, rpc } = fakeClient({
      commerce_payment_method_refs: USABLE_REF,
      subscription_dunning_cases: OPEN_CASE,
    });

    await expect(scheduleRetryOnDurableMethodUpdate(client, rotation("method_updated")))
      .resolves.toEqual({ outcome: "scheduled", reason: "ready" });

    expect(rpc).toHaveBeenCalledWith("subscription_try_schedule_recovery_retry", expect.objectContaining({
      p_payment_method_ref: METHOD_REF,
      p_entry: "method_ref_webhook",
    }));
  });

  // ⛔ A method that died must never start a charge against itself.
  it.each(["method_revoked", "method_expired", "method_suspended"])(
    "never schedules on %s",
    async (kind) => {
      const { client, rpc } = fakeClient({
        commerce_payment_method_refs: USABLE_REF,
        subscription_dunning_cases: OPEN_CASE,
      });

      await expect(scheduleRetryOnDurableMethodUpdate(client, rotation(kind)))
        .resolves.toEqual({ outcome: "skipped", reason: "no_usable_method_signal" });

      expect(rpc).not.toHaveBeenCalled();
    },
  );

  // The row, not the delivery, is the evidence: a death the lifecycle
  // consumption already applied leaves an inactive row, and that alone stops it.
  it("refuses a stored row that is no longer usable", async () => {
    const { client, rpc } = fakeClient({
      commerce_payment_method_refs: { ...USABLE_REF, status: "inactive", active: false },
      subscription_dunning_cases: OPEN_CASE,
    });

    await expect(scheduleRetryOnDurableMethodUpdate(client, registration()))
      .resolves.toEqual({ outcome: "skipped", reason: "method_ref_not_usable" });

    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a delivery whose method the webhook has not stored yet", async () => {
    const { client, rpc } = fakeClient({ subscription_dunning_cases: OPEN_CASE });

    await expect(scheduleRetryOnDurableMethodUpdate(client, registration()))
      .resolves.toEqual({ outcome: "skipped", reason: "method_ref_not_usable" });

    expect(rpc).not.toHaveBeenCalled();
  });

  it("leaves an account-scoped method alone", async () => {
    const { client, rpc } = fakeClient({
      commerce_payment_method_refs: { ...USABLE_REF, subscription_id: null },
      subscription_dunning_cases: OPEN_CASE,
    });

    await expect(scheduleRetryOnDurableMethodUpdate(client, registration()))
      .resolves.toEqual({ outcome: "skipped", reason: "method_ref_not_usable" });

    expect(rpc).not.toHaveBeenCalled();
  });

  it("leaves a subscription with no open case alone", async () => {
    const { client, rpc } = fakeClient({ commerce_payment_method_refs: USABLE_REF });

    await expect(scheduleRetryOnDurableMethodUpdate(client, registration()))
      .resolves.toEqual({ outcome: "skipped", reason: "no_open_case" });

    expect(rpc).not.toHaveBeenCalled();
  });

});
function registration(): NormalizedProviderPaymentWebhook {
  return {
    ...baseEvent(),
    eventType: "setup.succeeded",
    reusableMethod: {
      clientId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: SUBSCRIPTION_ID,
      providerCustomerRef: "customer-1",
      providerMethodRef: METHOD_REF,
      providerMandateRef: null,
      methodKind: "card",
      status: "active",
      consentSnapshot: { source: "account.card-update" },
    },
  };
}

function rotation(kind: string): NormalizedProviderPaymentWebhook {
  return {
    ...baseEvent(),
    eventType: kind === "method_updated" ? "setup.succeeded" : "setup.failed",
    methodLifecycle: {
      kind,
      providerKind: baseEvent().provider,
      providerMethodRef: METHOD_REF,
      providerEventId: "event-1",
      occurredAt: "2026-06-10T12:00:00.000Z",
      replacement: null,
    },
  } as unknown as NormalizedProviderPaymentWebhook;
}

const RAIL: NormalizedProviderPaymentWebhook["provider"] = "rail-a";

function baseEvent(): NormalizedProviderPaymentWebhook {
  return {
    provider: RAIL,
    providerEventId: "event-1",
    eventType: "setup.succeeded",
    providerPaymentId: "provider-payment-1",
    occurredAt: "2026-06-10T12:00:00.000Z",
    rawPayload: {},
    reusableMethod: null,
  };
}

