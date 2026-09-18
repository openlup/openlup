import type { Pool } from "pg";

import type { SubscriberRetentionMessaging } from "../server/domains/subscription/subscriberRetentionMessaging.js";

const SUBJECT = "client:20202020-2020-4020-8020-202020202020";
const RECIPIENT = "435647c1dcdfb9ec4abcef59f02eb320fddb2204e56cb3e68c5825a6df3098f5";

export async function assertCapturedReviewGrant(
  pool: Pool, captured: { idempotencyKey: string; accessGrantReference?: string } | undefined,
  activeOrder: string,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT intent.status,intent.source_reference,intent.access_grant_reference AS intent_reference,
            access_grant.grant_reference,access_grant.order_id,access_grant.kind
     FROM public.subscriber_retention_intents AS intent
     JOIN public.subscriber_review_access_grants AS access_grant
       ON intent.access_grant_reference=access_grant.grant_reference
     WHERE intent.idempotency_key=$1 AND intent.access_grant_reference=$2`,
    [captured?.idempotencyKey, captured?.accessGrantReference],
  );
  assert(rows.length === 1 && captured?.idempotencyKey === `retention.review_request.${activeOrder}`
      && captured.accessGrantReference === rows[0]?.intent_reference
      && captured.accessGrantReference === rows[0]?.grant_reference
      && rows[0]?.status === "accepted" && rows[0]?.source_reference === `order:${activeOrder}`
      && rows[0]?.order_id === activeOrder && rows[0]?.kind === "review_request",
    "review access grant did not reach the delivery command", { captured, ledger: rows[0] });
}

export async function proveMissingProfileRefusal(
  messaging: SubscriberRetentionMessaging, orderId: string,
): Promise<void> {
  await expectLabel(() => messaging.deliverIntent({
    idempotencyKey: `retention.review_request.${orderId}`,
    subjectReference: SUBJECT, subscriptionId: null, sourceReference: `order:${orderId}`,
    kind: "review_request", templateReference: "subscriber-review-request-v1",
    expectedRevision: 1, recipientFingerprint: RECIPIENT,
    controlKey: "subscriber-retention", consentPurpose: "retention_marketing",
  }), "subscriber_profile_not_found");
}

export async function proveReviewEffectsAuthorization(
  messaging: SubscriberRetentionMessaging, pool: Pool, requestOrder: string, effectsOrder: string,
): Promise<void> {
  const common = {
    subjectReference: SUBJECT, subscriptionId: null, expectedRevision: 1,
    recipientFingerprint: RECIPIENT, controlKey: "subscriber-retention",
    consentPurpose: "retention_marketing",
  };
  const effect = (idempotencyKey: string, sourceReference: string) => ({
    ...common, idempotencyKey, sourceReference, kind: "review_effects" as const,
    templateReference: "subscriber-review-effects-v1",
  });
  await pool.query(
    "INSERT INTO public.communication_delivery_controls(control_key,enabled) VALUES ('alternate-retention',true)",
  );
  for (const [input, refusal] of [
    [effect("retention-review-effects-kind-1", "subscription:21212121-2121-4121-8121-212121212121"), "source_kind_ineligible"],
    [effect("retention-review-effects-missing-source-1", "order:26262626-2626-4626-8626-262626262626"), "source_not_found"],
    [{ ...effect("retention-review-effects-mismatch-1", `order:${effectsOrder}`),
      subjectReference: "client:30303030-3030-4030-8030-303030303030",
      recipientFingerprint: "ceaf42fcf6cfce0776ad6200aef065c5d51fade42533f0dc9eb32f888f416b11" }, "source_subject_mismatch"],
    [{ ...effect("retention-review-effects-subscription-1", `order:${effectsOrder}`),
      subscriptionId: "21212121-2121-4121-8121-212121212121" }, "source_subscription_mismatch"],
    [{ ...effect("retention-review-effects-consent-1", `order:${effectsOrder}`), consentPurpose: null }, "authorization_contract_invalid"],
    [{ ...effect("retention-review-effects-control-1", `order:${effectsOrder}`), controlKey: "alternate-retention" }, "authorization_contract_invalid"],
    [{ ...effect("retention-review-effects-template-1", `order:${effectsOrder}`), templateReference: "review-effects-v2" }, "authorization_contract_invalid"],
    [effect("retention-review-effects-no-request-1", `order:${effectsOrder}`), "review_request_not_accepted"],
  ] as const) {
    const result = await messaging.deliverIntent(input);
    assert(result.status === "refused" && result.refusal === refusal,
      "review effects source/request refusal changed", { refusal, result });
  }
  const before = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM public.subscriber_review_access_grants WHERE order_id=$1) AS grants,
       (SELECT count(*)::int FROM public.transactional_delivery_receipts
        WHERE idempotency_key LIKE 'retention-review-effects-%') AS receipts`, [effectsOrder],
  );
  assert(before.rows[0]?.grants === 0 && before.rows[0]?.receipts === 0,
    "refused review effects minted a grant or reached delivery", before.rows[0]);
  const otherOrder = await messaging.deliverIntent(effect(
    "retention-review-effects-other-order-1", `order:${effectsOrder}`,
  ));
  assert(otherOrder.refusal === "review_request_not_accepted",
    "accepted request for another order authorized effects", { requestOrder, otherOrder });
  const request = await messaging.deliverIntent({
    ...common, idempotencyKey: `retention.review_request.${effectsOrder}`,
    sourceReference: `order:${effectsOrder}`, kind: "review_request",
    templateReference: "subscriber-review-request-v1",
  });
  assert(request.status === "accepted", "same-order review request was not accepted", request);
  const duplicate = await messaging.deliverIntent({
    ...common, idempotencyKey: "retention-review-effects-request-duplicate-1",
    sourceReference: `order:${effectsOrder}`, kind: "review_request",
    templateReference: "subscriber-review-request-v1",
  });
  assert(duplicate.status === "refused" && duplicate.refusal === "idempotency_contract_invalid",
    "alternate idempotency key duplicated source/kind delivery", duplicate);
  const legalInput = effect(`retention.review_effects.${effectsOrder}`, `order:${effectsOrder}`);
  const failed = await messaging.deliverIntent(legalInput);
  assert(failed.status === "failed", "same-order effects did not reach delivery", failed);
  await pool.query(
    `UPDATE public.subscriber_retention_intents SET
       status='refused',refusal='consent_missing',delivery_reference=NULL,updated_at=now()
     WHERE id=$1`, [request.intentId],
  );
  const retry = await messaging.deliverIntent(legalInput);
  const after = await pool.query(
    `SELECT intent.status,intent.refusal,receipt.attempt_count,access_grant.revoked_at
     FROM public.subscriber_retention_intents AS intent
     JOIN public.transactional_delivery_receipts AS receipt USING (idempotency_key)
     JOIN public.subscriber_review_access_grants AS access_grant
       ON access_grant.grant_reference=intent.access_grant_reference
     WHERE intent.id=$1`, [retry.intentId],
  );
  assert(retry.status === "refused" && retry.refusal === "review_request_not_accepted"
      && after.rows[0]?.attempt_count === 1 && after.rows[0]?.revoked_at,
    "effects reclaim ignored request-first authorization", { retry, readback: after.rows[0] });
  await pool.query("DELETE FROM public.communication_delivery_controls WHERE control_key='alternate-retention'");
}

export async function proveSourceReauthorization(
  pool: Pool, sourceOrder: string, timeOrder: string,
): Promise<void> {
  const planned = await pool.query(
    "SELECT public.subscriber_retention_plan_due('review_request',20) AS result",
  );
  assert(planned.rows[0]?.result?.planned === 2,
    "source reauthorization fixtures did not plan", planned.rows[0]);
  await pool.query("UPDATE public.commerce_orders SET status='refunded' WHERE id=$1", [sourceOrder]);
  for (const [orderId, claimAt] of [
    [sourceOrder, "now()"], [timeOrder, "now()+interval '31 days'"],
  ] as const) {
    await pool.query(
      `SELECT public.subscriber_retention_claim_intent(
         intent.idempotency_key,intent.fingerprint,${claimAt}
       ) FROM public.subscriber_retention_intents AS intent
       WHERE intent.idempotency_key='retention.review_request.' || $1`, [orderId],
    );
  }
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE intent.status='refused' AND intent.refusal='source_ineligible')::int AS refused,
            count(*) FILTER (WHERE access_grant.revoked_at IS NOT NULL)::int AS revoked,
            (SELECT count(*)::int FROM public.transactional_delivery_receipts
             WHERE idempotency_key IN ('retention.review_request.' || $1,'retention.review_request.' || $2)) AS receipts
     FROM public.subscriber_retention_intents AS intent
     JOIN public.subscriber_review_access_grants AS access_grant
       ON access_grant.grant_reference=intent.access_grant_reference
     WHERE intent.idempotency_key IN ('retention.review_request.' || $1,'retention.review_request.' || $2)`,
    [sourceOrder, timeOrder],
  );
  assert(rows[0]?.refused === 2 && rows[0]?.revoked === 2 && rows[0]?.receipts === 0,
    "source/time reauthorization reached delivery", rows[0]);
}

export async function assertPlannerRevisionStable(
  pool: Pool, clientId: string, recapOrder: string, reviewOrder: string,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT profile.revision,profile.fingerprint,
            recap.expected_revision AS recap_revision,review.expected_revision AS review_revision
     FROM public.subscriber_profiles AS profile
     JOIN public.subscriber_retention_intents AS recap
       ON recap.idempotency_key='retention.paid_cycle_recap.' || $2
     JOIN public.subscriber_retention_intents AS review
       ON review.idempotency_key='retention.review_request.' || $3
     WHERE profile.subject_reference='client:' || $1`, [clientId, recapOrder, reviewOrder],
  );
  assert(rows[0]?.revision === 4 && rows[0]?.fingerprint === "1".repeat(64)
      && rows[0]?.recap_revision === 4 && rows[0]?.review_revision === 4,
    "another-kind planner mutated personalization revision", rows[0]);
}

export async function assertExplicitProfileUpsertOwnsRevision(pool: Pool, clientId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT public.subscriber_profile_upsert(
       subject_reference,display_name,locale,revision+1,display_facts,capabilities,$2
     ) AS result FROM public.subscriber_profiles WHERE subject_reference='client:' || $1`,
    [clientId, "2".repeat(64)],
  );
  assert(rows[0]?.result?.replayed === false,
    "explicit profile upsert lost revision ownership", rows[0]);
}

export async function proveWinbackIdempotency(
  messaging: SubscriberRetentionMessaging, pool: Pool,
): Promise<void> {
  const result = await messaging.deliverIntent({
    idempotencyKey: "retention-winback-alternate-1",
    subjectReference: "client:38383838-3838-4838-8838-383838383838",
    subscriptionId: "39393939-3939-4939-8939-393939393939",
    sourceReference: "subscription:39393939-3939-4939-8939-393939393939",
    kind: "winback", templateReference: "subscriber-winback-v1", expectedRevision: 1,
    recipientFingerprint: "792d8584f053327498498bf0e9ed6604983e12a3ed30e0893280c30da2280f72",
    controlKey: "subscriber-retention", consentPurpose: "retention_marketing",
  });
  const receipt = await pool.query(
    "SELECT count(*)::int AS count FROM public.transactional_delivery_receipts WHERE idempotency_key=$1",
    ["retention-winback-alternate-1"],
  );
  assert(result.status === "refused" && result.refusal === "idempotency_contract_invalid"
      && receipt.rows[0]?.count === 0,
    "alternate winback idempotency key reached delivery", { result, receipt: receipt.rows[0] });
}

export async function assertProductionCleanup(pool: Pool, ids: {
  clientIds: string[]; orderIds: string[]; subscriptionIds: string[];
  cycleIds: string[]; consentFingerprints: string[]; portKey: string;
  expectedPortCount?: number; expectedClientCount?: number;
}): Promise<void> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM public.clients WHERE id=ANY($1::uuid[])) AS clients,
       (SELECT count(*)::int FROM public.subscriber_profiles
        WHERE subject_reference=ANY(SELECT 'client:' || id FROM unnest($1::uuid[]) AS id)) AS profiles,
       (SELECT count(*)::int FROM public.commerce_orders WHERE id=ANY($2::uuid[])) AS orders,
       (SELECT count(*)::int FROM public.subscriber_retention_intents
        WHERE source_reference LIKE ANY(ARRAY(
          SELECT 'order:' || id::text FROM unnest($2::uuid[]) AS id
          UNION ALL SELECT 'subscription:' || id::text FROM unnest($3::uuid[]) AS id
        ))) AS intents,
       (SELECT count(*)::int FROM public.subscriber_review_access_grants
        WHERE order_id=ANY($2::uuid[])) AS grants,
       (SELECT count(*)::int FROM public.transactional_delivery_receipts
        WHERE idempotency_key LIKE ANY(ARRAY(
          SELECT '%' || id::text FROM unnest($2::uuid[] || $3::uuid[]) AS id
        ))) AS receipts,
       (SELECT count(*)::int FROM public.fulfillment_shipments WHERE order_id=ANY($2::uuid[])) AS shipments,
       (SELECT count(*)::int FROM public.fulfillment_shipment_operations AS operation
        JOIN public.fulfillment_shipments AS shipment ON shipment.id=operation.shipment_id
        WHERE shipment.order_id=ANY($2::uuid[])) AS operations,
       (SELECT count(*)::int FROM public.subscriptions WHERE id=ANY($3::uuid[])) AS subscriptions,
       (SELECT count(*)::int FROM public.subscription_cycles WHERE id=ANY($4::uuid[])) AS cycles,
       (SELECT count(*)::int FROM public.communication_recipient_consents
        WHERE recipient_fingerprint=ANY($5::text[])) AS consents,
       (SELECT count(*)::int FROM public.fulfillment_ports WHERE port_key=$6) AS ports`,
    [ids.clientIds, ids.orderIds, ids.subscriptionIds, ids.cycleIds,
      ids.consentFingerprints, ids.portKey],
  );
  const row = rows[0] ?? {};
  assert(Object.entries(row).every(([key, value]) => key === "ports"
    ? value === (ids.expectedPortCount ?? 0) : key === "clients"
      ? value === (ids.expectedClientCount ?? 0) : value === 0),
    "production producer cleanup left mutable residue", row);
}

function assert(condition: unknown, message: string, detail?: unknown): asserts condition {
  if (!condition) throw new Error(`${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
}

async function expectLabel(work: () => Promise<unknown>, label: string): Promise<void> {
  try { await work(); } catch (error) {
    assert(error instanceof Error && error.message.includes(label), `expected ${label}`, error);
    return;
  }
  throw new Error(`expected ${label}`);
}
