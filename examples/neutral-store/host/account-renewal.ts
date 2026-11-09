import { editCutoff, createPostgresAccountReadSources, createPostgresCustomerOrderHistoryReadStore } from '@openlup/platform/account-support';

interface Executor { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
const unavailable = async (): Promise<never> => { throw new Error('starter_account_section_unavailable'); };

/** A narrow owned projection, without synthesizing missing rich-account sections. */
export async function readAccountRenewal(executor: Executor, scope: { principalId: string; clientId: string }) {
  // SQL UUID equality admits equivalent spellings; canonical database identity is
  // passed to the existing source, whose client entrance compares string identity.
  const client = (await executor.query(`SELECT id FROM public.clients
    WHERE id=$1::uuid AND principal_id=$2::uuid`, [scope.clientId, scope.principalId])).rows[0];
  if (!client) throw new Error('starter_account_owner_required');
  const clientId = String(client.id);
  const sources = createPostgresAccountReadSources(executor, { ...scope, clientId,
    now: () => new Date().toISOString(),
    orders: createPostgresCustomerOrderHistoryReadStore(executor, { ...scope, clientId, readInvoiceSummaries: unavailable }),
    orderProjection: { automaticHoldSource: 'unavailable', automaticReleaseSource: 'unavailable',
      orderReference: () => { throw new Error('starter_account_section_unavailable'); },
      fulfillmentEvidence: () => { throw new Error('starter_account_section_unavailable'); },
      presentation: { display: () => { throw new Error('starter_account_section_unavailable'); } } },
    additional: { readExtension: unavailable, async readNextCharges(rows) {
      const result = await executor.query(`SELECT s.id,
        CASE WHEN op.id IS NULL THEN 'retained_terms' ELSE 'frozen_obligation' END AS source,
        COALESCE(op.cycle_snapshot->'pricingSnapshot'->>'totalAmountMinor',
          (SELECT sum(line.quantity::bigint*line.unit_amount_minor)::text FROM public.subscription_renewal_term_lines line
            WHERE line.subscription_id=s.id)) AS amount,
        COALESCE(op.cycle_snapshot->'pricingSnapshot'->>'currency',terms.currency_code) AS currency,
        to_char(COALESCE(op.scheduled_at,s.next_cycle_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS charge_at
        FROM public.subscriptions s JOIN public.clients c ON c.id=s.client_id
        JOIN public.subscription_renewal_terms terms ON terms.subscription_id=s.id
        LEFT JOIN LATERAL (SELECT operation.* FROM public.subscription_renewal_operations operation
          JOIN public.commerce_settlement_intents intent ON intent.renewal_operation_id=operation.id
          JOIN public.commerce_orders o ON o.id=intent.order_id
          JOIN public.subscription_cycles cycle ON cycle.id=o.subscription_cycle_id
          WHERE operation.subscription_id=s.id AND cycle.status='payment_pending'
          ORDER BY operation.created_at,operation.id LIMIT 1) op ON true
        WHERE s.id=ANY($1::uuid[]) AND c.id=$2::uuid AND c.principal_id=$3::uuid`,
      [rows.map(row => row.id), clientId, scope.principalId]);
      return new Map(result.rows.map(row => {
        const amountMinor = Number(row.amount);
        if (row.amount == null || !Number.isSafeInteger(amountMinor) || amountMinor < 0
          || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) throw new Error('starter_account_charge_unavailable');
        return [String(row.id), { source: row.source, amountMinor, currency: row.currency, chargeAt: row.charge_at }];
      }));
    } },
  });
  const rows = await sources.readSubscriptionRows(clientId, 50);
  const ids = rows.map(row => String(row.id));
  const nextCycles = new Map(rows.map(row => [String(row.id), typeof row.next_cycle_at === 'string' ? row.next_cycle_at : null]));
  const [actions, payments, alignments, charges, addressEvents, blockers, pauses, winback] = await Promise.all([
    sources.readActionStates(ids), sources.readPaymentEvidence(ids), sources.readDeliveryAlignments(nextCycles),
    sources.readNextCharges(rows), executor.query(`SELECT DISTINCT ON(e.subscription_id) e.subscription_id,e.payload
      FROM public.subscription_events e JOIN public.subscriptions s ON s.id=e.subscription_id
      JOIN public.clients c ON c.id=s.client_id
      WHERE s.id=ANY($1::uuid[]) AND c.id=$2::uuid AND c.principal_id=$3::uuid
        AND e.event_type='subscription.customer_self_service.change_shipping_address'
      ORDER BY e.subscription_id,e.occurred_at DESC,e.id DESC`, [ids, clientId, scope.principalId]),
    sources.readSubscriptionBlockers(ids, nextCycles), sources.readPauseWindows(ids),
    executor.query(`SELECT DISTINCT ON(i.subscription_id) i.subscription_id,i.status,i.refusal,i.delivery_reference
      FROM public.subscriber_retention_intents i JOIN public.subscriptions s ON s.id=i.subscription_id
      JOIN public.clients c ON c.id=s.client_id WHERE s.id=ANY($1::uuid[]) AND c.id=$2::uuid
        AND c.principal_id=$3::uuid AND i.kind='winback' ORDER BY i.subscription_id,i.created_at DESC,i.id DESC`,
    [ids, clientId, scope.principalId]),
  ]);
  return { subscriptions: rows.map(row => ({ subscriptionId: row.id, status: row.status,
    nextCycleAt: nextCycles.get(String(row.id)) ?? null, editCutoffAt: editCutoff(nextCycles.get(String(row.id)) ?? null, typeof row.edit_window_hours === 'number' ? row.edit_window_hours : null),
    blocker: blockers.get(String(row.id)) ?? null, pause: pauses.get(String(row.id)) ?? null,
    winback: winback.rows.find(intent => intent.subscription_id === row.id) ?? null,
    chargeAt: charges.get(String(row.id))?.chargeAt ?? null, nextCharge: charges.get(String(row.id)) ?? null,
    promisedArrival: { available: false as const }, action: actions.get(String(row.id)) ?? null,
    payment: payments.get(String(row.id)) ?? null, deliveryAlignment: alignments.get(String(row.id)) ?? null,
    effectiveAddress: addressEvents.rows.find(event => event.subscription_id === row.id)?.payload ?? null,
  })) };
}
