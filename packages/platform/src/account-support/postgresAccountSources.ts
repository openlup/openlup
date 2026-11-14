import { customerCauseForFailureClass } from "@openlup/core/payment";
import type { AccountReadSources, SubscriptionActionState } from "./accountReadModels.js";
import type { AccountSnapshot, AccountSubscription } from "./contracts/account.js";
import type { CustomerOrderHistoryProjectionPort, CustomerOrderHistoryReadStore } from "./orderHistory.js";
import { readCustomerOrderSummaries } from "./orderHistory.js";
import type { OperatorQueryExecutor } from "./postgresOperatorAuthority.js";
import { accountRows, minor, nullableText, text, readOwnedPaidActivationGaps, type NativeAccountReadScope, type NativePaidActivationGapReadSource } from "./postgresAccountReadScope.js";

/** Native health is evidence for the selected projection policy, not a provider instrument. */
export interface NativeAccountPaymentEvidence {
  healthState: string | null;
  unattendedChargeAuthorizedAt: string | null;
  stockWaitState: string | null;
}
/** Host policies are required; missing profile/event sources refuse their section. */
export type NativeAccountAdditionalSources<Extension, ChargeEvidence> = Pick<
  AccountReadSources<Extension, ChargeEvidence, NativeAccountPaymentEvidence>,
  "readExtension" | "readNextCharges"
> & Partial<Pick<AccountReadSources<Extension, ChargeEvidence, NativeAccountPaymentEvidence>,
  "readAddresses" | "readOrdererProfiles" | "readPaymentPreferences" | "readDeliveryPreferences" | "readEvents"
>>;
export interface NativeAccountSourcesOptions<Extension, ChargeEvidence> extends NativeAccountReadScope {
  additional: NativeAccountAdditionalSources<Extension, ChargeEvidence>;
  orders: CustomerOrderHistoryReadStore;
  orderProjection: CustomerOrderHistoryProjectionPort;
  now(): string;
}

/** Compose the existing account assembler with native owned persistence reads. */
export function createPostgresAccountReadSources<Extension, ChargeEvidence = AccountSubscription["nextCharge"]>(
  executor: OperatorQueryExecutor, options: NativeAccountSourcesOptions<Extension, ChargeEvidence>,
): AccountReadSources<Extension, ChargeEvidence, NativeAccountPaymentEvidence> & NativePaidActivationGapReadSource {
  const rows = accountRows(executor, options), clientId = options.clientId;
  const { additional, orders, orderProjection, now } = options;
  const ownedIds = async (ids: string[]) => (await rows("SELECT id FROM owned_subscriptions WHERE id=ANY($3::uuid[])", [ids])).map(row => text(row.id));
  const requireClient = async (id: string) => {
    if (id !== clientId || !(await rows("SELECT id FROM owned_clients")).length) throw new Error("native_account_owner_mismatch");
  };
  return {
    readPaidActivationGaps(ids) { return readOwnedPaidActivationGaps(rows, ids); },
    async readExtension(id) { await requireClient(id); return additional.readExtension(id); },
    async readAddresses(id) { await requireClient(id);
      if (!additional.readAddresses) hostBindingRequired("addresses");
      return additional.readAddresses(id); },
    async readOrdererProfiles(id) { await requireClient(id);
      if (!additional.readOrdererProfiles) hostBindingRequired("billingProfiles");
      return additional.readOrdererProfiles(id); },
    async readPaymentPreferences(id) { await requireClient(id);
      if (!additional.readPaymentPreferences) hostBindingRequired("paymentPreferences");
      return additional.readPaymentPreferences(id); },
    async readDeliveryPreferences(id) { await requireClient(id);
      if (!additional.readDeliveryPreferences) hostBindingRequired("deliveryPreferences");
      return additional.readDeliveryPreferences(id); },
    async readEvents(id) { await requireClient(id);
      if (!additional.readEvents) hostBindingRequired("events");
      return additional.readEvents(id); },
    async readSubscriptionRows(id, limit) {
      await requireClient(id);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("native_account_subscription_limit_invalid");
      return rows(`SELECT s.*,s.composition_constraint AS size_constraint,CASE WHEN EXISTS(SELECT 1 FROM public.subscription_events event
        WHERE event.subscription_id=s.id AND event.event_type='subscription.customer_self_service.cancel' AND event.occurred_at=s.ended_at
        AND COALESCE(event.payload#>>'{payload,actorKind}','customer')='customer')
        THEN 'customer_self_service' ELSE NULL END AS cancellation_source
        FROM owned_subscriptions s ORDER BY s.created_at DESC,s.id DESC LIMIT $3`, [limit]);
    },
    async readOrders(id, limit) { await requireClient(id); return readCustomerOrderSummaries(orders, id, limit, orderProjection); },
    async readSubscriptionLines(ids) {
      const result = await rows(`SELECT line.*,sku.sku,sku.title,product.slug FROM public.subscription_lines line
        JOIN owned_subscriptions s ON s.id=line.subscription_id JOIN public.catalog_skus sku ON sku.id=line.variant_id
        JOIN public.catalog_products product ON product.id=sku.product_id WHERE s.id=ANY($3::uuid[])
        ORDER BY line.sort_order,line.id`, [ids]);
      const map = new Map<string, AccountSnapshot["subscriptions"][number]["lines"]>();
      for (const row of result) {
        const id = text(row.subscription_id), group = map.get(id) ?? [];
        const unit = minor(row.unit_price_minor), qty = minor(row.quantity), total = unit * qty;
        if (!Number.isSafeInteger(total)) throw new Error("native_account_money_invalid");
        group.push({ lineId: text(row.id), variantId: text(row.variant_id), qty, sortOrder: minor(row.sort_order),
          isAddon: row.is_addon === true, title: nullableText(row.title), sku: nullableText(row.sku), productSlug: nullableText(row.slug),
          unitPrice: { amountMinor: unit, currency: text(row.currency_code) }, lineSubtotal: { amountMinor: total, currency: text(row.currency_code) } });
        map.set(id, group);
      }
      return map;
    },
    async readSubscriptionBlockers(ids, nextCycles) {
      const [dunning, cycles, orderRows] = await Promise.all([
        rows(`SELECT d.subscription_id FROM public.subscription_dunning_cases d JOIN owned_subscriptions s ON s.id=d.subscription_id
          WHERE s.id=ANY($3::uuid[]) AND d.status='open'`, [ids]),
        rows(`SELECT cycle.id,cycle.subscription_id,cycle.scheduled_at FROM public.subscription_cycles cycle
          JOIN owned_subscriptions s ON s.id=cycle.subscription_id WHERE s.id=ANY($3::uuid[]) AND cycle.status IN('payment_pending','paid')
          AND (($4::jsonb->>s.id::text) IS NULL OR cycle.scheduled_at=($4::jsonb->>s.id::text)::timestamptz)`, [ids, JSON.stringify(Object.fromEntries(nextCycles))]),
        rows(`SELECT cycle.id AS cycle_id,cycle.subscription_id FROM owned_orders o JOIN public.subscription_cycles cycle ON cycle.id=o.subscription_cycle_id
          JOIN owned_subscriptions s ON s.id=cycle.subscription_id WHERE s.id=ANY($3::uuid[]) AND o.status IN('paid','fulfillment_pending','fulfilled')`, [ids]),
      ]);
      const result = new Map<string, NonNullable<AccountSubscription["editBlockedReason"]>>();
      for (const row of dunning) result.set(text(row.subscription_id), "payment_blocked");
      const locked = new Set<string>();
      for (const row of cycles) {
        const id = text(row.subscription_id);
        locked.add(text(row.id)); if (!result.has(id)) result.set(id, "cycle_locked");
      }
      for (const row of orderRows) {
        const id = text(row.subscription_id);
        if (!result.has(id) && (!nextCycles.get(id) || locked.has(text(row.cycle_id)))) result.set(id, "cycle_locked");
      }
      return result;
    },
    async readPauseWindows(ids) {
      const result = await rows(`SELECT DISTINCT ON(pause.subscription_id) pause.subscription_id,pause.pause_preset,pause.starts_at,pause.ends_at
        FROM public.subscription_pause_windows pause JOIN owned_subscriptions s ON s.id=pause.subscription_id
        WHERE s.id=ANY($3::uuid[]) AND pause.resumed_at IS NULL ORDER BY pause.subscription_id,pause.starts_at DESC,pause.id DESC`, [ids]);
      return new Map(result.map(row => [text(row.subscription_id), { pausePreset: row.pause_preset as AccountSubscription["pausePreset"],
        pauseStartedAt: text(row.starts_at), pauseEndsAt: nullableText(row.ends_at) }]));
    },
    async readPaymentEvidence(ids) {
      const result = await rows(`SELECT s.id,CASE WHEN public.subscription_method_uses_recorded_refs(s.id)
        THEN public.subscription_method_health_read(s.id)->>'health_state' ELSE method.health_state END AS health_state,terms.unattended_charge_authorized_at,
        (SELECT wait.state FROM public.subscription_stock_wait_cases wait WHERE wait.subscription_id=s.id
          AND wait.scheduled_at=s.next_cycle_at AND wait.state IN('waiting','stock_secured')
          ORDER BY wait.opened_at DESC,wait.id DESC LIMIT 1) AS stock_wait_state
        FROM owned_subscriptions s LEFT JOIN public.subscription_method_states method ON method.subscription_id=s.id
        LEFT JOIN public.subscription_renewal_terms terms ON terms.subscription_id=s.id WHERE s.id=ANY($3::uuid[])`, [ids]);
      return new Map(result.map(row => [text(row.id), { healthState: nullableText(row.health_state),
        unattendedChargeAuthorizedAt: nullableText(row.unattended_charge_authorized_at), stockWaitState: nullableText(row.stock_wait_state) }]));
    },
    async readDeliveryAlignments(nextCycles) {
      const result = await rows(`SELECT alignment.subscription_id,alignment.state,alignment.aligned_next_cycle_at
        FROM public.subscription_delivery_alignment_cases alignment JOIN owned_subscriptions s ON s.id=alignment.subscription_id
        WHERE s.id=ANY($3::uuid[]) AND (alignment.state='protected' OR alignment.state='aligned'
          AND alignment.aligned_next_cycle_at=($4::jsonb->>s.id::text)::timestamptz)
        ORDER BY alignment.subscription_id,(alignment.state='protected') DESC,alignment.created_at DESC,alignment.id DESC`, [[...nextCycles.keys()], JSON.stringify(Object.fromEntries(nextCycles))]);
      const map = new Map<string, { state: "protected" | "aligned" }>();
      for (const row of result) {
        const id = text(row.subscription_id);
        if (!map.has(id) && (row.state === "protected" || row.state === "aligned")) {
          map.set(id, { state: row.state });
        }
      }
      return map;
    },
    async readNextCharges(subscriptionRows) {
      const allowed = new Set(await ownedIds(subscriptionRows.map(row => text(row.id))));
      return additional.readNextCharges(subscriptionRows.filter(row => allowed.has(text(row.id))));
    },
    async readActionStates(ids) {
      const allowed = await ownedIds(ids);
      const result = new Map<string, SubscriptionActionState>();
      const at = now();
      if (!Number.isFinite(Date.parse(at))) throw new Error("native_account_now_invalid");
      const cases = await rows(`SELECT d.*,obligation.order_id,EXISTS(SELECT 1 FROM public.commerce_checkout_recovery_tokens token
        WHERE token.order_id=obligation.order_id AND token.revoked_at IS NULL AND token.expires_at>$4::timestamptz) AS recovery_eligible
        FROM public.subscription_dunning_cases d JOIN owned_subscriptions s ON s.id=d.subscription_id
        LEFT JOIN public.subscription_retry_obligations obligation ON obligation.case_id=d.id
        WHERE s.id=ANY($3::uuid[]) AND d.status IN('open','expired')
        ORDER BY (d.status='open') DESC,d.updated_at DESC,d.id DESC`, [allowed, at]);
      for (const row of cases) {
        const id = text(row.subscription_id), open = row.status === "open";
        if (!result.has(id)) result.set(id, { subscriptionId: id, orderId: nullableText(row.order_id),
          blockedReason: open ? "payment_blocked" : "payment_expired", failureCause: customerCauseForFailureClass(nullableText(row.failure_class)),
          recoveryEligible: row.recovery_eligible === true, nextRetryAt: open ? nullableText(row.next_retry_at) : null,
          dueAt: nullableText(open ? row.next_retry_at : row.expired_at) ?? nullableText(row.updated_at) ?? nullableText(row.opened_at) });
      }
      const cycles = await rows(`SELECT cycle.* FROM public.subscription_cycles cycle JOIN owned_subscriptions s ON s.id=cycle.subscription_id
        WHERE s.id=ANY($3::uuid[]) AND cycle.status IN('payment_failed','retry_scheduled') ORDER BY cycle.updated_at DESC,cycle.id DESC`, [allowed]);
      for (const row of cycles) {
        const id = text(row.subscription_id);
        if (!result.has(id)) result.set(id, { subscriptionId: id, orderId: null, blockedReason: "payment_failed", failureCause: "unknown",
          recoveryEligible: false, nextRetryAt: nullableText(row.next_retry_at),
          dueAt: nullableText(row.next_retry_at) ?? nullableText(row.updated_at) ?? nullableText(row.scheduled_at) });
      }
      return result;
    },
  };
}

function hostBindingRequired(section: string): never {
  throw Object.assign(new Error("host_binding_required"), { code: "host_binding_required", section });
}
