type Graph = "native" | "managed";

const waitCases = `WITH wait_cases AS NOT MATERIALIZED (
  SELECT 'legacy' AS kind,id,state,deficits FROM public.subscription_stock_wait_cases
)`;
const stateFilter = "($1::text='all' OR state=$1)";

export function stockWaitAccountSql(graph: Graph) {
  return `SELECT EXISTS (SELECT 1 FROM public.clients WHERE id=$1::uuid
    AND ${graph === "native" ? "principal_id" : "auth_user_id"}=$2::uuid)
    AND NOT EXISTS (SELECT 1 FROM unnest($3::uuid[]) AS requested(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.id=requested.id AND s.client_id=$1::uuid)) AS allowed`;
}

// Use the operation's artifacts, including the order before the wait row binds it at resumption.
const nativeLinks = `LEFT JOIN public.subscription_renewal_operations op ON op.id=c.renewal_operation_id
    AND (op.subscription_id,op.scheduled_at,op.cycle_number)=(c.subscription_id,c.scheduled_at,c.cycle_number)
    AND op.operation_fingerprint=c.fingerprint
  LEFT JOIN public.subscription_cycles cycle ON cycle.renewal_operation_id=op.id
    AND (cycle.subscription_id,cycle.scheduled_at,cycle.renewal_operation_fingerprint)=
        (op.subscription_id,op.scheduled_at,op.operation_fingerprint)
  LEFT JOIN public.commerce_orders ord ON ord.renewal_operation_id=op.id
    AND ord.client_id=c.client_id AND ord.renewal_operation_fingerprint=op.operation_fingerprint
  LEFT JOIN public.fulfillment_shipments shipment ON shipment.id=c.fulfillment_id AND shipment.order_id=ord.id`;

// Apply order and limit before checking current eligibility, as in the source reads.
export function stockWaitPageSql(graph: Graph, reader: "admin" | "evidence" | "customer") {
  const admin = reader === "admin";
  const customer = reader === "customer";
  const order = reader === "evidence" ? "last_checked_at" : "opened_at";
  const native = graph === "native";
  const filter = admin ? stateFilter : `state IN ('waiting','stock_secured') AND NOT superseded
    ${customer ? "AND client_id=$1::uuid AND subscription_id=ANY($2::uuid[])" : ""}`;
  return `WITH wait_cases AS NOT MATERIALIZED (
    SELECT 'legacy' AS kind,id,client_id,subscription_id,cycle_number,scheduled_at,state,deficits,
      order_id,cycle_id,fulfillment_id,opened_at,last_checked_at,stock_secured_at,resumed_at,closed_at,block_reason,
      coalesce(block_reason IN ('schedule_superseded','cancelled_or_superseded'),false) AS superseded
      ${native ? ",renewal_operation_id,fingerprint" : ""}
    FROM public.subscription_stock_wait_cases
  ), selected AS (
    SELECT * FROM wait_cases WHERE ${filter} ORDER BY ${order},id,kind
    ${admin ? "LIMIT $2::integer OFFSET $3::bigint" : customer ? "LIMIT 100" : "LIMIT 2000"}
  ), projected AS (
    SELECT c.*, s.status AS subscription_status,
      ${native ? "op.id IS NOT NULL" : "true"} AS carrier_available,
      ${native ? "ord.id" : "c.order_id"} AS projected_order_id,
      ${native ? "cycle.id" : "c.cycle_id"} AS projected_cycle_id,
      ${native ? "shipment.id" : "c.fulfillment_id"} AS projected_fulfillment_id,
      coalesce(isfinite(s.next_cycle_at) AND s.next_cycle_at=c.scheduled_at,false) AS same_anchor
    FROM selected c LEFT JOIN public.subscriptions s ON s.id=c.subscription_id AND s.client_id=c.client_id
    ${native ? nativeLinks : ""}
  )
  SELECT
    ${admin ? `(SELECT count(*) FROM wait_cases WHERE ${filter}) AS "totalCount",` : ""}
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'schemaVersion',2,'caseKind',kind,'id',id,'clientId',client_id,'subscriptionId',subscription_id,
      'cycleNumber',cycle_number,'scheduledAt',scheduled_at,'state',state,'deficits',deficits,
      'carrierAvailable',carrier_available,'orderId',projected_order_id,'cycleId',projected_cycle_id,
      'fulfillmentId',projected_fulfillment_id,'openedAt',opened_at,
      'lastCheckedAt',last_checked_at,'stockSecuredAt',stock_secured_at,'resumedAt',resumed_at,
      'closedAt',closed_at,'blockReason',block_reason,
      'automaticRecoveryEligible',coalesce(subscription_status='active' AND same_anchor AND NOT superseded AND carrier_available,false),
      'independentBlock', CASE WHEN superseded THEN block_reason WHEN state<>'waiting' THEN NULL
        WHEN subscription_status IS DISTINCT FROM 'active' THEN coalesce(subscription_status,'unknown')
        WHEN NOT same_anchor THEN 'schedule_changed' END
    ) ORDER BY ${order},id,kind) FROM projected), '[]'::jsonb) AS cases`;
}

export function stockWaitPaymentSql(graph: Graph) {
  const requested = `WITH requested AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS cases(id uuid,kind text,"orderId" uuid,"cycleId" uuid,
      "clientId" uuid,"subscriptionId" uuid,"scheduledAt" timestamptz)
  )`;
  if (graph === "managed") return `${requested}
    SELECT c.id,c.kind,i.status FROM requested c
    JOIN public.commerce_orders o ON (o.id,o.client_id,o.subscription_id,o.subscription_cycle_id)=
      (c."orderId",c."clientId",c."subscriptionId",c."cycleId")
    JOIN public.subscription_cycles cycle ON (cycle.id,cycle.subscription_id,cycle.scheduled_at,cycle.order_id)=
      (c."cycleId",c."subscriptionId",c."scheduledAt",o.id)
    JOIN public.commerce_payments payment ON payment.id=cycle.payment_id AND payment.order_id=o.id
    JOIN public.commerce_payment_intents i ON (i.order_id,i.subscription_id,i.subscription_cycle_id,i.payment_id)=
      (o.id,c."subscriptionId",cycle.id,payment.id) AND i.target_kind='subscription_cycle'`;
  return `${requested}
    SELECT c.id,c.kind,i.status FROM requested c
    JOIN public.commerce_orders o ON o.id=c."orderId" AND o.subscription_cycle_id=c."cycleId"
    JOIN public.commerce_settlement_intents i ON (i.order_id,i.renewal_operation_id,i.renewal_operation_fingerprint)=
      (o.id,o.renewal_operation_id,o.renewal_operation_fingerprint)`;
}

export function stockWaitSummarySql(graph: Graph) {
  const label = graph === "native" ? "sku.title" :
    "CASE WHEN jsonb_typeof(line->'productName')='string' THEN line->>'productName' END";
  return `${waitCases},
  matching AS (SELECT * FROM wait_cases WHERE ${stateFilter}),
  facts AS (
    SELECT c.kind,c.id,CASE WHEN jsonb_typeof(line->'sku')='string' THEN line->>'sku' END AS sku,${label} AS label,
      CASE WHEN jsonb_typeof(line->'missingUnits')='number' AND line->>'missingUnits' ~ '^[0-9]+$'
        THEN (line->>'missingUnits')::numeric END AS missing
    FROM matching c CROSS JOIN LATERAL jsonb_array_elements(c.deficits) AS lines(line)
    ${graph === "native" ? "LEFT JOIN public.catalog_skus sku ON sku.sku=line->>'sku'" : ""}
  ), totals AS (
    SELECT sku, min(label) AS label, sum(missing) AS missing, count(DISTINCT (kind,id)) AS affected
    FROM facts WHERE missing>0 GROUP BY sku
  )
  SELECT (SELECT count(*) FROM matching) AS "totalCount",
    EXISTS (SELECT 1 FROM facts WHERE sku IS NULL OR btrim(sku)='' OR label IS NULL OR btrim(label)='' OR missing IS NULL) AS incomplete,
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'sku',sku,'displayName',label,'missingUnits',missing,'affectedCases',affected
    ) ORDER BY sku) FROM totals), '[]'::jsonb) AS "productTotals"`;
}

export function stockWaitNoticesSql(graph: Graph) {
  const requested = `SELECT id,kind FROM jsonb_to_recordset($1::jsonb) AS cases(id uuid,kind text)`;
  if (graph === "managed") return `
    WITH requested AS (${requested})
    SELECT c.id,'legacy' AS kind,d.template_slug AS "templateSlug",d.status,d.last_error_code AS "lastErrorCode",
      to_jsonb(d.updated_at) AS "updatedAt"
    FROM requested c JOIN public.communication_email_deliveries d ON d.aggregate_id=c.id::text
      AND c.kind='legacy' AND d.aggregate_type='subscription_stock_wait'
    WHERE d.template_slug IN ('subscription-stock-wait-started','subscription-stock-wait-resumed')
    ORDER BY d.updated_at DESC,d.id`;
  // Processing without a receipt uses the outbox's latest claim.
  const updatedAt = `coalesce(r.updated_at, CASE WHEN e.status='processing'
    THEN coalesce((e.metadata->>'lastClaimedAt')::timestamptz,e.created_at)
    ELSE coalesce(e.processed_at,e.created_at) END)`;
  return `
    WITH requested AS (${requested})
    SELECT c.id,c.kind,
      CASE WHEN e.event_type='subscription_stock_wait.started'
        THEN 'subscription-stock-wait-started' ELSE 'subscription-stock-wait-resumed' END AS "templateSlug",
      CASE WHEN r.state='accepted' THEN 'sent' WHEN r.state='failed' THEN 'failed'
        WHEN e.status='pending' THEN 'queued' WHEN e.status='processing' THEN 'processing'
        ELSE 'unknown' END AS status,
      r.error_code AS "lastErrorCode",
      to_jsonb(${updatedAt}) AS "updatedAt"
    FROM requested c JOIN public.outbox_events e ON e.aggregate_id=c.id AND e.aggregate_type='subscription_stock_wait'
      AND c.kind='legacy' AND e.event_type IN ('subscription_stock_wait.started','subscription_stock_wait.resumed')
      AND e.idempotency_key='subscription_stock_wait:'||c.id::text||':'||split_part(e.event_type,'.',2)
    LEFT JOIN public.transactional_delivery_receipts r ON r.idempotency_key=e.idempotency_key
    ORDER BY ${updatedAt} DESC,e.id`;
}
