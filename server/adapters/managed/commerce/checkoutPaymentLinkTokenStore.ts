/**
 * Durable writes for an operator-minted checkout payment link.
 *
 * The customer-facing rail mints its own tokens through a SECURITY DEFINER
 * routine that only admits a `pending_payment` order and never revokes what it
 * replaces. The operator surface needs the opposite of both: it mints for an
 * order the customer could not pay (expired or technically expired too), and
 * every mint must leave exactly ONE live link behind, because a bearer link that
 * outlives its replacement is a second key to the same door.
 *
 * Hence the revoke-then-insert shape: revoke what is live, then insert the new
 * row. Storage stays hash-only — the raw token never reaches THIS table, only its
 * digest — so a leak of it leaks nothing redeemable.
 *
 * The third method is the delivery half of the same command. When the operator
 * asks for the link to be MAILED rather than copied, the raw token has to reach
 * the durable delivery rail, and the only durable handover this deployment has is
 * an outbox row. So the raw token appears in this file exactly once, in a payload
 * written to `outbox_events` — the same place the customer-facing recovery cron
 * already puts it — and nowhere else.
 *
 * The client is typed STRUCTURALLY, by the calls this store makes, rather
 * than by a named client type from a hosted SDK. That keeps the adapter portable
 * to any deployment whose data layer offers the same shape, and keeps the module
 * free of deployment-specific vocabulary.
 */

/** Only the four columns both schema lineages declare NOT NULL and undefaulted. */
export interface CheckoutPaymentLinkTokenInsert {
  orderId: string;
  clientId: string;
  tokenHash: string;
  expiresAt: string;
}

/**
 * What the delivery rail needs to send the freshly minted link, and nothing else.
 * `tokenId` is the row the mint just wrote: it makes the enqueue idempotent per
 * MINT rather than per order, so a regenerate mails the new link exactly once and
 * a double-click on the same mint mails nothing twice.
 */
export interface CheckoutRecoveryEmailEnqueue {
  orderId: string;
  tokenId: string;
  rawToken: string;
  mode: string;
  expiresAt: string;
}

export interface CheckoutPaymentLinkTokenStore {
  /**
   * Retire every link that is still live for this order. Idempotent: an order
   * with no live link is a no-op, not an error.
   */
  revokeActive(orderId: string): Promise<void>;
  /** Returns the id of the row just written; the enqueue keys its idempotency on it. */
  insert(input: CheckoutPaymentLinkTokenInsert): Promise<string>;
  /**
   * Hand the minted link to the durable delivery rail. Duplicate-tolerant: the
   * table's `(event_type, idempotency_key)` uniqueness makes a replay a success,
   * not an error, because the row that is already there IS the outcome asked for.
   */
  enqueueRecoveryEmail(input: CheckoutRecoveryEmailEnqueue): Promise<void>;
}

interface WriteError {
  message?: string;
}

interface WriteResult {
  error: WriteError | null;
}

interface ReadBackResult extends WriteResult {
  data?: ReadonlyArray<{ id?: unknown }> | null;
}

interface PaymentLinkTokenInsert extends PromiseLike<WriteResult> {
  /** Read the identity of the row just written back out of the same statement. */
  select(columns: string): PromiseLike<ReadBackResult>;
}

interface PaymentLinkTokenQuery extends PromiseLike<WriteResult> {
  update(values: Record<string, unknown>): PaymentLinkTokenQuery;
  insert(values: Record<string, unknown>): PaymentLinkTokenInsert;
  upsert(
    values: Record<string, unknown>,
    options: { onConflict: string; ignoreDuplicates: boolean },
  ): PromiseLike<WriteResult>;
  eq(column: string, value: unknown): PaymentLinkTokenQuery;
  is(column: string, value: unknown): PaymentLinkTokenQuery;
}

export interface CheckoutPaymentLinkTokenClient {
  from(table: string): PaymentLinkTokenQuery;
}

const TOKEN_TABLE = "commerce_checkout_recovery_tokens";
const OUTBOX_TABLE = "outbox_events";

/**
 * Written as literals rather than imported from the event-contract module on
 * purpose. This adapter has no imports at all: it is typed by the calls it makes
 * and carries no dependency edge into the domain tree, and one import for one
 * string would trade that property away. The delivery side asserts the same three
 * values, so a drift shows up as a failing test rather than a silent no-send.
 */
const CHECKOUT_RECOVERY_EVENT_TYPE = "commerce.checkout_recovery";
const OPERATOR_IDEMPOTENCY_PREFIX = "checkout_recovery:operator:";
const OPERATOR_EVENT_SOURCE = "admin_payment_link";

export function createCheckoutPaymentLinkTokenStore(
  client: CheckoutPaymentLinkTokenClient,
  options: { now?: () => Date } = {},
): CheckoutPaymentLinkTokenStore {
  const now = options.now ?? (() => new Date());

  return {
    async revokeActive(orderId: string): Promise<void> {
      const { error } = await client
        .from(TOKEN_TABLE)
        .update({ revoked_at: now().toISOString() })
        .eq("order_id", orderId)
        // `revoked_at IS NULL` is the whole definition of "live" in this table,
        // and it is also the predicate of the partial unique index one lineage
        // carries, so retiring the live row is what makes the next insert legal.
        .is("revoked_at", null);
      if (error) throw new Error(`checkout_payment_link_revoke_failed: ${error.message ?? "write failed"}`);
    },

    async insert(input: CheckoutPaymentLinkTokenInsert): Promise<string> {
      const { data, error } = await client.from(TOKEN_TABLE).insert({
        order_id: input.orderId,
        client_id: input.clientId,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt,
      }).select("id");
      if (error) throw new Error(`checkout_payment_link_insert_failed: ${error.message ?? "write failed"}`);
      const id = data?.[0]?.id;
      // A write that reports no error but hands back no identity is not a success
      // this caller can build on: the delivery key would be `...:undefined`, which
      // collides across every mint and would mail exactly one customer ever.
      if (typeof id !== "string" || id === "") {
        throw new Error("checkout_payment_link_insert_failed: no row identity returned");
      }
      return id;
    },

    async enqueueRecoveryEmail(input: CheckoutRecoveryEmailEnqueue): Promise<void> {
      const { error } = await client.from(OUTBOX_TABLE).upsert(
        {
          aggregate_type: "commerce_order",
          aggregate_id: input.orderId,
          event_type: CHECKOUT_RECOVERY_EVENT_TYPE,
          idempotency_key: `${OPERATOR_IDEMPOTENCY_PREFIX}${input.tokenId}`,
          payload: {
            orderId: input.orderId,
            recoveryToken: input.rawToken,
            mode: input.mode,
            // The marker the delivery side keys its eligibility on. Without it an
            // operator link for an order that has left `pending_payment` would be
            // skipped as a stale cron nudge and silently never sent.
            operatorIssued: true,
            expiresAt: input.expiresAt,
          },
          metadata: { source: OPERATOR_EVENT_SOURCE },
        },
        // A replay of the same mint must be a no-op, not a second email and not a
        // refusal: the row that already exists is the outcome the caller asked for.
        { onConflict: "event_type,idempotency_key", ignoreDuplicates: true },
      );
      if (error) {
        throw new Error(`checkout_payment_link_enqueue_failed: ${error.message ?? "write failed"}`);
      }
    },
  };
}

/**
 * The buyer's own half of the same rail, and deliberately a SECOND factory rather
 * than a branch inside the store above.
 *
 * When a buyer stuck on a payment step asks for the link themselves, the durable
 * handover is the same table, the same event type and the same duplicate-tolerant
 * upsert. What differs is everything the operator's `enqueueRecoveryEmail` encodes
 * about WHO asked: its key is per operator mint, and its payload carries
 * `operatorIssued: true`, the marker the delivery side keys operator eligibility
 * on and the operator surface reads its ledger by. Reusing it would file a
 * buyer's own request as an operator action in both places at once.
 *
 * So the caller composes the row — its ten-minute bucket key, its `buyerRequested`
 * payload and its own `source` — and this factory owns exactly one thing: the
 * write, and the fact that a duplicate of it is a success. That split is why the
 * row type is declared here: it is the shape this table accepts, not a shape the
 * route invented.
 */
export interface BuyerCheckoutRecoveryOutboxRow {
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  idempotency_key: string;
  payload: {
    orderId: string;
    recoveryToken: string;
    mode: string;
    buyerRequested: true;
  };
  metadata: { source: string };
}

interface BuyerOutboxUpsertQuery {
  upsert(
    values: BuyerCheckoutRecoveryOutboxRow,
    options: { onConflict: string; ignoreDuplicates: boolean },
  ): PromiseLike<WriteResult>;
}

export interface BuyerCheckoutRecoveryOutboxClient {
  from(table: string): BuyerOutboxUpsertQuery;
}

export function createBuyerCheckoutRecoveryEnqueue(client: BuyerCheckoutRecoveryOutboxClient) {
  return async function enqueue(row: BuyerCheckoutRecoveryOutboxRow): Promise<void> {
    const { error } = await client.from(OUTBOX_TABLE).upsert(row, {
      // A second tap inside the bucket must be a no-op, not an error and not a
      // second email: the row already there IS the outcome the buyer asked for.
      onConflict: "event_type,idempotency_key",
      ignoreDuplicates: true,
    });
    if (error) {
      throw new Error(`checkout_payment_link_enqueue_failed: ${error.message ?? "write failed"}`);
    }
  };
}
