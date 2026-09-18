import { describe, expect, it, vi } from "vitest";
import { createSupabaseSubscriptionRecoveryPort } from "./subscriptionRecovery.js";

const recoveryToken = ["01234567", "89abcdef"].join("").repeat(4);

describe("supabase payment recovery port", () => {
  it("looks up token evidence and customer auth ownership without exposing raw tokens", async () => {
    const client = fakeClient({
      subscription_payment_recovery_tokens: {
        id: "token-row-1",
        case_id: "case-row-1",
        client_id: "client-1",
        purpose: "repair_payment",
        expires_at: "2026-06-06T13:00:00.000Z",
        used_at: null,
        revoked_at: null,
      },
      clients: {
        id: "client-1",
        auth_user_id: "auth-user-1",
      },
    });
    const port = createSupabaseSubscriptionRecoveryPort(client);

    const evidence = await port.findTokenEvidenceByHash("hashed-token");

    expect(client.from).toHaveBeenCalledWith("subscription_payment_recovery_tokens");
    expect(client.calls).toContainEqual({
      table: "subscription_payment_recovery_tokens",
      columns: "id, case_id, client_id, purpose, expires_at, used_at, revoked_at",
      column: "token_hash",
      value: "hashed-token",
    });
    expect(client.calls).toContainEqual({
      table: "clients",
      columns: "id, auth_user_id",
      column: "id",
      value: "client-1",
    });
    expect(evidence).toEqual({
      tokenId: "token-row-1",
      caseId: "case-row-1",
      clientId: "client-1",
      authUserId: "auth-user-1",
      purpose: "repair_payment",
      expiresAt: "2026-06-06T13:00:00.000Z",
      usedAt: null,
      revokedAt: null,
    });
  });

  it("delegates redemption to the existing subscription recovery RPC", async () => {
    const client = fakeClient({});
    client.rpc.mockResolvedValue({
      data: {
        contractVersion: "commerce.v0",
        subscriptionPaymentRecovery: {
          caseId: "11111111-1111-4111-8111-111111111111",
          subscriptionId: "22222222-2222-4222-8222-222222222222",
          cycleId: "33333333-3333-4333-8333-333333333333",
          orderId: "44444444-4444-4444-8444-444444444444",
          purpose: "repair_payment",
          nextAction: "retry_existing_cycle",
          replayed: false,
        },
      },
      error: null,
    });
    const port = createSupabaseSubscriptionRecoveryPort(client);

    await port.recordSubscriptionPaymentRecovery({
      idempotencyKey: "recovery-submit-1",
      recoveryToken,
      paymentMethodRef: "pm_provider_reusable",
      paymentMethodKind: "stripe_payment_method",
      requestedAt: "2026-06-06T12:00:00.000Z",
    });

    expect(client.rpc).toHaveBeenCalledWith("subscription_record_payment_recovery_request", {
      p_idempotency_key: "recovery-submit-1",
      p_recovery_token: recoveryToken,
      p_payment_method_ref: "pm_provider_reusable",
      p_payment_method_kind: "stripe_payment_method",
      p_requested_at: "2026-06-06T12:00:00.000Z",
    });
  });

  // Every raise the redeem RPC can answer with, including the ones the
  // expired-dunning resume rail contributes: the resume runs inside this same
  // RPC, and its raises are customer-actionable outcomes rather than server
  // faults. A not-yet-durable method ref is the webhook race and the redeem
  // rolled back, so the page may re-submit; a case that moved on is terminal.
  // Left unmapped they surface as a 500 with dead-end copy.
  it.each([
    ["subscription_payment_recovery_token_invalid", "token_invalid_or_expired"],
    ["subscription_payment_recovery_idempotency_conflict", "idempotency_conflict"],
    ["subscription_resume_after_expired_method_not_chargeable", "resume_method_not_chargeable"],
    ["subscription_resume_after_expired_case_not_expired", "resume_case_state_changed"],
  ])("maps the %s raise to a domain conflict", async (message, reason) => {
    const port = recoveryPortRejecting(message);

    await expect(port.recordSubscriptionPaymentRecovery(recoveryInput()))
      .rejects.toMatchObject({ name: "PaymentRecoveryRecordError", reason });
  });

  it("leaves an unrelated RPC failure as a generic error", async () => {
    const port = recoveryPortRejecting("deadlock detected");

    await expect(port.recordSubscriptionPaymentRecovery(recoveryInput()))
      .rejects.toThrow(/subscription_record_payment_recovery_request: deadlock detected/);
    await expect(port.recordSubscriptionPaymentRecovery(recoveryInput()))
      .rejects.toMatchObject({ name: "Error" });
  });

  it("resolves a recovery case for a subscription/client that has multiple method refs", async () => {
    // Regression for CJ01-O Defect 2: a subscription (and its client) can own more
    // than one method ref — the active card plus the declined/replaced ones. The
    // `.maybeSingle()`-on-a-lone-filter lookups used to error ("multiple rows"),
    // nulling the resolution so the recovery page reported "not actionable". The
    // ordered `.limit(1)` lookup must instead return the active card's customer ref.
    const client = fakeClient({
      subscription_dunning_cases: [
        { id: "case-1", subscription_id: "sub-1", status: "open" },
      ],
      commerce_payment_method_refs: [
        { subscription_id: "sub-1", client_id: "client-1", provider_kind: "stripe", provider_customer_ref: "cus_declined", active: false, created_at: "2026-06-01T00:00:00.000Z" },
        { subscription_id: "sub-1", client_id: "client-1", provider_kind: "stripe", provider_customer_ref: "cus_active", active: true, created_at: "2026-06-05T00:00:00.000Z" },
      ],
    });
    const port = createSupabaseSubscriptionRecoveryPort(client);

    const resolution = await port.resolveRecoveryCaseSubscription({
      tokenEvidence: {
        tokenId: "token-1",
        caseId: "case-1",
        clientId: "client-1",
        authUserId: "auth-user-1",
        purpose: "repair_payment",
        expiresAt: "2026-06-06T13:00:00.000Z",
        usedAt: null,
        revokedAt: null,
      },
    });

    expect(resolution).toEqual({
      caseId: "case-1",
      subscriptionId: "sub-1",
      providerCustomerRef: "cus_active",
    });
  });

  it("does not pass a Tpay PAYID to Stripe when recovery has no Stripe customer yet", async () => {
    const client = fakeClient({
      subscription_dunning_cases: [
        { id: "case-1", subscription_id: "sub-1", status: "open" },
      ],
      commerce_payment_method_refs: [
        {
          subscription_id: "sub-1",
          client_id: "client-1",
          provider_kind: "tpay",
          provider_customer_ref: "tpay-payer-ref",
          active: true,
          created_at: "2026-06-05T00:00:00.000Z",
        },
      ],
    });
    const port = createSupabaseSubscriptionRecoveryPort(client);

    const resolution = await port.resolveRecoveryCaseSubscription({
      tokenEvidence: {
        tokenId: "token-1",
        caseId: "case-1",
        clientId: "client-1",
        authUserId: "auth-user-1",
        purpose: "repair_payment",
        expiresAt: "2026-06-06T13:00:00.000Z",
        usedAt: null,
        revokedAt: null,
      },
    });

    expect(resolution).toEqual({
      caseId: "case-1",
      subscriptionId: "sub-1",
      providerCustomerRef: null,
    });
  });
});

/** A port whose only stubbed behaviour is the RPC failing with `message`. */
function recoveryPortRejecting(message: string) {
  const client = fakeClient({});
  client.rpc.mockResolvedValue({ data: null, error: { message } });
  return createSupabaseSubscriptionRecoveryPort(client);
}

function recoveryInput() {
  return {
    idempotencyKey: "recovery-submit-1",
    recoveryToken,
    paymentMethodRef: "pm_provider_reusable",
    paymentMethodKind: "stripe_payment_method",
    requestedAt: "2026-06-06T12:00:00.000Z",
  };
}

// Faithful-enough Supabase query mock: `.maybeSingle()` errors on >1 matching row
// (as PostgREST does) UNLESS the query narrowed to a single row via `.limit(1)`,
// so the mock actually reproduces the CJ01-O Defect 2 failure and proves the fix.
function fakeClient(rows: Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  const rowsForTable = (table: string): Array<Record<string, unknown>> => {
    const value = rows[table];
    if (value == null) return [];
    return (Array.isArray(value) ? value : [value]) as Array<Record<string, unknown>>;
  };
  const client = {
    calls,
    from: vi.fn((table: string) => ({
      select: (columns: string) => {
        const filters: Array<{ column: string; value: unknown }> = [];
        const orderings: Array<{ column: string; ascending: boolean }> = [];
        let limitCount: number | null = null;
        const builder = {
          eq(column: string, value: unknown) {
            filters.push({ column, value });
            return builder;
          },
          order(column: string, options?: { ascending?: boolean }) {
            orderings.push({ column, ascending: options?.ascending !== false });
            return builder;
          },
          limit(count: number) {
            limitCount = count;
            return builder;
          },
          async maybeSingle() {
            calls.push({ table, columns, column: filters[0]?.column, value: filters[0]?.value });
            // Lenient filter: a configured row that omits a filtered column is
            // treated as matching (keeps the single-row fixtures terse); rows that
            // DO carry the column are filtered for real (the multi-ref case).
            let result = rowsForTable(table).filter((row) =>
              filters.every((f) => !(f.column in row) || row[f.column] === f.value),
            );
            for (const ordering of [...orderings].reverse()) {
              result = [...result].sort((a, b) => compare(a[ordering.column], b[ordering.column], ordering.ascending));
            }
            if (limitCount != null) result = result.slice(0, limitCount);
            if (result.length > 1) {
              return { data: null, error: { code: "PGRST116", message: "Cannot coerce the result to a single JSON object" } };
            }
            return { data: result[0] ?? null, error: null };
          },
        };
        return builder;
      },
    })),
    rpc: vi.fn(),
  };
  return client;
}

function compare(a: unknown, b: unknown, ascending: boolean): number {
  const dir = ascending ? 1 : -1;
  const av = a === true ? 1 : a === false ? 0 : a;
  const bv = b === true ? 1 : b === false ? 0 : b;
  if (av === bv) return 0;
  return (av! < bv! ? -1 : 1) * dir;
}
