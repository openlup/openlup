import { describe, expect, it } from "vitest";
import {
  createBuyerCheckoutRecoveryEnqueue,
  createCheckoutPaymentLinkTokenStore,
  type BuyerCheckoutRecoveryOutboxRow,
  type CheckoutPaymentLinkTokenClient,
} from "./checkoutPaymentLinkTokenStore.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-20T12:00:00.000Z");
const TOKEN_ROW_ID = "33333333-3333-4333-8333-333333333333";
const EXPIRES_AT = "2026-06-27T12:00:00.000Z";

type Call = [string, ...unknown[]];

/**
 * Records the chain instead of executing it. The store's whole contract is which
 * table it addresses and which predicates it narrows by, so the stub asserts the
 * shape of the call rather than a database result.
 */
function stubClient(
  error: { message?: string } | null = null,
  insertedRows: ReadonlyArray<{ id?: unknown }> | null = [{ id: TOKEN_ROW_ID }],
) {
  const calls: Call[] = [];
  const query = {
    update(values: Record<string, unknown>) {
      calls.push(["update", values]);
      return query;
    },
    insert(values: Record<string, unknown>) {
      calls.push(["insert", values]);
      return {
        select(columns: string) {
          calls.push(["select", columns]);
          return Promise.resolve({ data: insertedRows, error });
        },
        then<T>(resolve: (result: { error: { message?: string } | null }) => T) {
          return Promise.resolve({ error }).then(resolve);
        },
      };
    },
    upsert(values: Record<string, unknown>, options: Record<string, unknown>) {
      calls.push(["upsert", values, options]);
      return Promise.resolve({ error });
    },
    eq(column: string, value: unknown) {
      calls.push(["eq", column, value]);
      return query;
    },
    is(column: string, value: unknown) {
      calls.push(["is", column, value]);
      return query;
    },
    then<T>(resolve: (result: { error: { message?: string } | null }) => T) {
      return Promise.resolve({ error }).then(resolve);
    },
  };
  const client: CheckoutPaymentLinkTokenClient = {
    from(table: string) {
      calls.push(["from", table]);
      return query as unknown as ReturnType<CheckoutPaymentLinkTokenClient["from"]>;
    },
  };
  return { client, calls };
}

function store(
  error: { message?: string } | null = null,
  insertedRows: ReadonlyArray<{ id?: unknown }> | null = [{ id: TOKEN_ROW_ID }],
) {
  const { client, calls } = stubClient(error, insertedRows);
  return { store: createCheckoutPaymentLinkTokenStore(client, { now: () => NOW }), calls };
}

describe("checkout payment link token store", () => {
  it("retires only the live links of the one order", async () => {
    const { store: subject, calls } = store();
    await subject.revokeActive(ORDER_ID);
    expect(calls).toEqual([
      ["from", "commerce_checkout_recovery_tokens"],
      ["update", { revoked_at: NOW.toISOString() }],
      ["eq", "order_id", ORDER_ID],
      ["is", "revoked_at", null],
    ]);
  });

  // Only the four columns both schema lineages declare NOT NULL and undefaulted.
  // A fifth would be a column one lineage does not have. The trailing read-back is
  // the identity the email enqueue keys its idempotency on, taken from the same
  // statement rather than a second round trip that could see a different row.
  it("inserts exactly the four shared columns and reads the new row's identity", async () => {
    const { store: subject, calls } = store();
    const id = await subject.insert({
      orderId: ORDER_ID,
      clientId: CLIENT_ID,
      tokenHash: "d1e2f3",
      expiresAt: EXPIRES_AT,
    });
    expect(id).toBe(TOKEN_ROW_ID);
    expect(calls).toEqual([
      ["from", "commerce_checkout_recovery_tokens"],
      ["insert", {
        order_id: ORDER_ID,
        client_id: CLIENT_ID,
        token_hash: "d1e2f3",
        expires_at: EXPIRES_AT,
      }],
      ["select", "id"],
    ]);
  });

  // A write that reports no error but returns no row would leave the enqueue key
  // as `checkout_recovery:operator:undefined` — one key for every mint the
  // deployment will ever make, so exactly one customer would ever be mailed.
  it("refuses an insert that reports success without a row identity", async () => {
    const { store: subject } = store(null, []);
    await expect(subject.insert({
      orderId: ORDER_ID,
      clientId: CLIENT_ID,
      tokenHash: "d1e2f3",
      expiresAt: EXPIRES_AT,
    })).rejects.toThrow("checkout_payment_link_insert_failed: no row identity returned");
  });

  it("throws a neutral message when the revoke is refused", async () => {
    const { store: subject } = store({ message: "permission denied" });
    await expect(subject.revokeActive(ORDER_ID)).rejects.toThrow(
      "checkout_payment_link_revoke_failed: permission denied",
    );
  });

  it("throws a neutral message when the insert is refused", async () => {
    const { store: subject } = store({ message: "duplicate key" });
    await expect(subject.insert({
      orderId: ORDER_ID,
      clientId: CLIENT_ID,
      tokenHash: "d1e2f3",
      expiresAt: "2026-06-27T12:00:00.000Z",
    })).rejects.toThrow("checkout_payment_link_insert_failed: duplicate key");
  });

  // The whole delivery contract in one assertion: which rail carries the link
  // (the existing recovery event type), which key makes it once-per-mint, and the
  // marker the delivery side reads to know a human asked for this one.
  it("hands the minted link to the existing recovery rail, keyed once per mint", async () => {
    const { store: subject, calls } = store();
    await subject.enqueueRecoveryEmail({
      orderId: ORDER_ID,
      tokenId: TOKEN_ROW_ID,
      rawToken: "rcv_operator_token",
      mode: "one_time",
      expiresAt: EXPIRES_AT,
    });
    expect(calls).toEqual([
      ["from", "outbox_events"],
      ["upsert", {
        aggregate_type: "commerce_order",
        aggregate_id: ORDER_ID,
        event_type: "commerce.checkout_recovery",
        idempotency_key: `checkout_recovery:operator:${TOKEN_ROW_ID}`,
        payload: {
          orderId: ORDER_ID,
          recoveryToken: "rcv_operator_token",
          mode: "one_time",
          operatorIssued: true,
          expiresAt: EXPIRES_AT,
        },
        metadata: { source: "admin_payment_link" },
      }, { onConflict: "event_type,idempotency_key", ignoreDuplicates: true }],
    ]);
  });

  // A replay of the same mint must be a no-op rather than a second email or a
  // refusal, so the duplicate is absorbed by the statement, not by a catch here.
  it("treats a replayed enqueue as success", async () => {
    const { store: subject } = store(null, []);
    await expect(subject.enqueueRecoveryEmail({
      orderId: ORDER_ID,
      tokenId: TOKEN_ROW_ID,
      rawToken: "rcv_operator_token",
      mode: "one_time",
      expiresAt: EXPIRES_AT,
    })).resolves.toBeUndefined();
  });

  it("throws a neutral message when the enqueue is refused", async () => {
    const { store: subject } = store({ message: "permission denied" });
    await expect(subject.enqueueRecoveryEmail({
      orderId: ORDER_ID,
      tokenId: TOKEN_ROW_ID,
      rawToken: "rcv_operator_token",
      mode: "one_time",
      expiresAt: EXPIRES_AT,
    })).rejects.toThrow("checkout_payment_link_enqueue_failed: permission denied");
  });

  it("still throws when the failure carries no message", async () => {
    const { store: subject } = store({});
    await expect(subject.revokeActive(ORDER_ID)).rejects.toThrow(
      "checkout_payment_link_revoke_failed: write failed",
    );
  });
});

describe("buyer checkout-recovery enqueue", () => {
  // Composed by the caller, asserted whole here: the row's bucketed key and its
  // `buyerRequested` marker are what keep a buyer's own request out of the
  // operator's ledger, and this factory must pass them through untouched.
  const row: BuyerCheckoutRecoveryOutboxRow = {
    aggregate_type: "commerce_order",
    aggregate_id: ORDER_ID,
    event_type: "commerce.checkout_recovery",
    idempotency_key: `checkout_recovery:buyer:${ORDER_ID}:2980710`,
    payload: {
      orderId: ORDER_ID,
      recoveryToken: "rcv_first",
      mode: "one_time",
      buyerRequested: true,
    },
    metadata: { source: "buyer_payment_link" },
  };

  it("upserts the row unchanged on the event-type/key pair and tolerates the duplicate", async () => {
    const calls: Array<{ table: string; values: unknown; options: unknown }> = [];
    const enqueue = createBuyerCheckoutRecoveryEnqueue({
      from: (table) => ({
        upsert: async (values, options) => {
          calls.push({ table, values, options });
          return { error: null };
        },
      }),
    });
    await enqueue(row);
    expect(calls).toEqual([
      {
        table: "outbox_events",
        values: row,
        options: { onConflict: "event_type,idempotency_key", ignoreDuplicates: true },
      },
    ]);
  });

  // Never `operatorIssued`: the delivery side keys operator eligibility on that
  // marker and the operator surface reads its ledger by it, so a buyer's row
  // carrying it would be misfiled in both places at once.
  it("carries the buyer marker and never the operator's", async () => {
    const written: BuyerCheckoutRecoveryOutboxRow[] = [];
    const enqueue = createBuyerCheckoutRecoveryEnqueue({
      from: () => ({
        upsert: async (values) => {
          written.push(values);
          return { error: null };
        },
      }),
    });
    await enqueue(row);
    expect(written[0].payload.buyerRequested).toBe(true);
    expect(written[0].payload).not.toHaveProperty("operatorIssued");
    expect(written[0].idempotency_key.startsWith("checkout_recovery:buyer:")).toBe(true);
  });

  it("throws a prefixed error when the write fails", async () => {
    const enqueue = createBuyerCheckoutRecoveryEnqueue({
      from: () => ({ upsert: async () => ({ error: { message: "permission denied" } }) }),
    });
    await expect(enqueue(row)).rejects.toThrow(
      "checkout_payment_link_enqueue_failed: permission denied",
    );
  });

  it("still throws when the failure carries no message", async () => {
    const enqueue = createBuyerCheckoutRecoveryEnqueue({
      from: () => ({ upsert: async () => ({ error: {} }) }),
    });
    await expect(enqueue(row)).rejects.toThrow(
      "checkout_payment_link_enqueue_failed: write failed",
    );
  });
});
