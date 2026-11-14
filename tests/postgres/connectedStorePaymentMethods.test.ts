import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPaymentMethodStore } from "@openlup/platform/payments";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { call, failure, prepareOriginal, renewal, request, retryDueAt } from "./subscriptionNativeFixture.js";

const resources = storeJourneyResources();
let source: JourneyInstallation, target: JourneyInstallation;
beforeAll(async () => {
  source = await resources.installation("method-source");
  target = await resources.installation("method-target");
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

// Full-catalogue PostgreSQL restore/replay reached about 10 s on a hosted shard.
// Keep this inherent database proof bounded at 30 s, about three times that cost.
it("round-trips method references, receipts and frozen recovery authority with exact rows and replay", async () => {
  const f = await renewal(source.owner), original = await prepareOriginal(source.owner, f);
  await call(source.owner, "subscription_retry_apply_failure", [f.operation, `failure:${f.operation}`, failure()]);
  await call(source.owner, "subscription_retry_open_case", [f.operation, "failed", "/recover"]);
  const obligation = (await source.owner.query("SELECT * FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1", [f.operation])).rows[0];
  const methods = createPostgresPaymentMethodStore(source.owner);
  const input = { key: "method:first", clientId: f.client, subscriptionId: f.subscription, provider: "card_rail", methodKind: "card",
    customer: "synthetic-customer", reference: "method-first", mandate: null, status: "active" as const, active: true, expiresAt: null,
    consent: { recoveryCaseId: obligation.case_id }, payload: { source: "synthetic" } };
  await methods.upsert(input);
  const replacement = { ...input, key: "method:replacement", reference: "method-replacement" };
  const recorded = await methods.upsert(replacement);
  await source.owner.query("UPDATE public.payment_method_refs SET consent_snapshot=consent_snapshot||jsonb_build_object('opaque',9007199254740993::bigint) WHERE id=$1", [recorded.id]);
  const hash = randomUUID().replaceAll("-", "").repeat(2);
  const at = (await source.owner.query("SELECT now() AS at")).rows[0].at.toISOString();
  await source.owner.query("SELECT public.dunning_lifecycle_issue_recovery_token($1,$2,now()+interval '30 days')", [obligation.case_id, hash]);
  const token = (await source.owner.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [hash])).rows[0].id;
  const authority = await call(source.owner, "subscription_retry_authorize_recovery", [f.operation, token, replacement.reference, recorded.id, at]);
  await call(source.owner, "subscription_retry_schedule_recovery", [f.operation, "method:schedule", authority.id, at]);
  const dispatchAt = await retryDueAt(source.owner, f.operation);
  await call(source.owner, "subscription_retry_prepare", [f.operation, "method:dispatch", { ...request({ ...f, original }), paymentMethodRef: replacement.reference }, dispatchAt]);
  const packet = await captureStoreJourney(source.owner, "method-source");
  const freshTarget = await captureStoreJourney(target.owner, "method-target");
  const before = await journeyCensus(source.owner);
  for (const [table, count] of [["payment_method_refs", 2], ["payment_method_ref_receipts", 2], ["payment_method_recovery_authorities", 1]] as const) {
    expect(before[table]).toHaveLength(count);
    expect(packet.owned.find(value => value.table === table)?.rows).toEqual(before[table]);
  }
  expect(before.payment_method_refs.some(row => row.includes('"opaque": 9007199254740993'))).toBe(true);
  expect(before.payment_method_recovery_authorities[0]).toContain('"dispatch_key": "method:dispatch"');
  const restore = () => restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget });
  expect(await restore()).toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect(await restore()).toEqual({ captureSha256: packet.sha256, replayed: true, neutralizedHistoricalHoldNotifications: 0 });
  expect(await createPostgresPaymentMethodStore(target.owner).upsert(replacement)).toEqual({ ...recorded, replayed: true });
  expect(await journeyCensus(target.owner)).toEqual(before);
}, 30_000);
