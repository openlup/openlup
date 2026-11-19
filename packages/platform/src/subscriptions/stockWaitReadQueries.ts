// Project both generations to the same storage coordinates. Never pass frozen
// snapshots, idempotency keys or provider payloads through the reader DTO.
const caseColumns = `id, client_id, subscription_id, cycle_number, scheduled_at, state,
  deficits, order_id, cycle_id, fulfillment_id, opened_at, last_checked_at,
  stock_secured_at, resumed_at, closed_at, block_reason`;
const legacyCases = `SELECT 'legacy' AS kind, false AS superseded, NULL::uuid AS operation_id, ${caseColumns}
  FROM public.subscription_stock_wait_cases`;

export function stockWaitCasesSql(graph: "native" | "managed") {
  return `WITH wait_cases AS NOT MATERIALIZED (
    ${legacyCases}
    ${graph === "native" ? `UNION ALL
      SELECT 'successor' AS kind, superseded_by_proposal_id IS NOT NULL AS superseded, operation_id, ${caseColumns}
      FROM public.subscription_successor_wait_cases_v2` : ""}
  )`;
}

// Apply order and limit before checking current eligibility, as in the source
// reads. Admin preserves inactive and historical rows with their blocker.
export function stockWaitPageSql(graph: "native" | "managed", reader: "admin" | "evidence" | "customer") {
  const admin = reader === "admin";
  const customer = reader === "customer";
  const order = reader === "evidence" ? "last_checked_at" : "opened_at";
  // Preparation and settlement bind the generation before the wait resumes.
  const native = graph === "native";
  const generationField = (field: "order_id" | "cycle_id" | "fulfillment_id") =>
    native ? `CASE WHEN c.kind='successor' THEN g.${field} ELSE c.${field} END` : `c.${field}`;
  const account = customer ? `, account AS (
    SELECT id FROM public.clients WHERE id=$1::uuid AND ${graph === "native" ? "principal_id" : "auth_user_id"}=$2::uuid
  )` : "";
  const filter = admin ? "($1::text='all' OR state=$1)" : `state IN ('waiting','stock_secured') AND NOT superseded
    ${customer ? `AND client_id=(SELECT id FROM account) AND subscription_id=ANY($3::uuid[])
      AND EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.id=wait_cases.subscription_id AND s.client_id=wait_cases.client_id)` : ""}`;
  return `${stockWaitCasesSql(graph)}${account},
  selected AS (
    SELECT * FROM wait_cases WHERE ${filter}
    ORDER BY ${order},id,kind
    ${admin ? "LIMIT $2::integer OFFSET $3::bigint" : customer ? "LIMIT 100" : "LIMIT 2000"}
  ), projected AS (
    SELECT c.*, s.status AS subscription_status,
      ${native ? "c.kind='legacy' OR g.id IS NOT NULL" : "true"} AS carrier_available,
      ${generationField("order_id")} AS projected_order_id,
      ${generationField("cycle_id")} AS projected_cycle_id,
      ${generationField("fulfillment_id")} AS projected_fulfillment_id,
      coalesce(isfinite(s.next_cycle_at) AND s.next_cycle_at=c.scheduled_at,false) AS same_anchor
    FROM selected c LEFT JOIN public.subscriptions s ON s.id=c.subscription_id AND s.client_id=c.client_id
    ${native ? `LEFT JOIN public.subscription_successor_operations_v2 g ON g.id=c.operation_id
      AND g.subscription_id=c.subscription_id AND g.scheduled_at=c.scheduled_at AND g.cycle_number=c.cycle_number` : ""}
  )
  SELECT
    ${admin ? `(SELECT count(*) FROM wait_cases WHERE ${filter}) AS "totalCount",` : ""}
    ${customer ? 'EXISTS (SELECT 1 FROM account) AS allowed,' : ""}
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'schemaVersion',2,'caseKind',kind,'id',id,'clientId',client_id,'subscriptionId',subscription_id,
      'cycleNumber',cycle_number,'scheduledAt',scheduled_at,'state',state,'deficits',deficits,
      'carrierAvailable',carrier_available,'orderId',projected_order_id,'cycleId',projected_cycle_id,
      'fulfillmentId',projected_fulfillment_id,'openedAt',opened_at,
      'lastCheckedAt',last_checked_at,'stockSecuredAt',stock_secured_at,'resumedAt',resumed_at,
      'closedAt',closed_at,'blockReason',block_reason,
      'automaticRecoveryEligible',coalesce(subscription_status='active' AND same_anchor AND NOT superseded,false),
      'independentBlock', CASE WHEN state<>'waiting' THEN NULL
        WHEN subscription_status IS DISTINCT FROM 'active' THEN coalesce(subscription_status,'unknown')
        WHEN NOT same_anchor THEN 'schedule_changed'
        WHEN superseded THEN 'superseded_by_successor' END
    ) ORDER BY ${order},id,kind) FROM projected), '[]'::jsonb) AS cases`;
}

export function stockWaitSummarySql(graph: "native" | "managed") {
  const label = graph === "native" ? "sku.title" : 'line."productName"';
  return `${stockWaitCasesSql(graph)},
  matching AS (SELECT * FROM wait_cases WHERE $1::text='all' OR state=$1),
  facts AS (
    SELECT c.kind,c.id,line.sku,${label} AS label,line."missingUnits" AS missing
    FROM matching c CROSS JOIN LATERAL
      jsonb_to_recordset(c.deficits) AS line(sku text,"productName" text,"missingUnits" bigint)
    ${graph === "native" ? "LEFT JOIN public.catalog_skus sku ON sku.sku=line.sku" : ""}
  ), totals AS (
    SELECT sku, min(label) AS label, sum(missing) AS missing, count(DISTINCT (kind,id)) AS affected
    FROM facts WHERE missing>0 GROUP BY sku
  )
  SELECT (SELECT count(*) FROM matching) AS "totalCount",
    EXISTS (SELECT 1 FROM facts WHERE sku IS NULL OR sku='' OR label IS NULL OR label='' OR missing IS NULL OR missing<0) AS incomplete,
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'sku',sku,'displayName',label,'missingUnits',missing,'affectedCases',affected
    ) ORDER BY sku) FROM totals), '[]'::jsonb) AS "productTotals"`;
}

export function stockWaitNoticesSql(graph: "native" | "managed") {
  const requested = `SELECT id,kind FROM jsonb_to_recordset($1::jsonb) AS cases(id uuid,kind text)`;
  if (graph === "managed") return `
    WITH requested AS (${requested})
    SELECT c.id,c.kind,d.template_slug AS "templateSlug",d.status,d.last_error_code AS "lastErrorCode",
      to_jsonb(d.updated_at) AS "updatedAt"
    FROM requested c JOIN public.communication_email_deliveries d ON d.aggregate_id=c.id::text
    WHERE d.template_slug IN ('subscription-stock-wait-started','subscription-stock-wait-resumed')
    ORDER BY d.updated_at DESC,d.id`;
  // An opened event records a wait. Only an actual delivery event and
  // transactional receipt establish delivery progress or acceptance.
  return `
    WITH requested AS (${requested})
    SELECT c.id,c.kind,
      CASE WHEN e.event_type IN ('subscription_stock_wait.started','subscription_stock_wait.started.v2')
        THEN 'subscription-stock-wait-started' ELSE 'subscription-stock-wait-resumed' END AS "templateSlug",
      CASE WHEN r.state='accepted' THEN 'sent' WHEN r.state='failed' THEN 'failed'
        WHEN e.status='pending' THEN 'queued' WHEN e.status='processing' THEN 'processing'
        ELSE 'unknown' END AS status,
      r.error_code AS "lastErrorCode",
      to_jsonb(coalesce(r.updated_at,e.processed_at,e.created_at)) AS "updatedAt"
    FROM requested c JOIN public.outbox_events e ON e.aggregate_id=c.id AND e.aggregate_type='subscription_stock_wait'
    LEFT JOIN public.transactional_delivery_receipts r ON r.idempotency_key=e.idempotency_key
    WHERE (c.kind='legacy' AND e.event_type IN ('subscription_stock_wait.started','subscription_stock_wait.resumed'))
       OR (c.kind='successor' AND e.event_type IN ('subscription_stock_wait.started.v2','subscription_stock_wait.resumed.v2'))
    ORDER BY coalesce(r.updated_at,e.processed_at,e.created_at) DESC,e.id`;
}
