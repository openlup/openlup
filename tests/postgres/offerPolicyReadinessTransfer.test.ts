import { afterAll, beforeAll, expect, it } from "vitest";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
let source: JourneyInstallation, target: JourneyInstallation;
let original: Awaited<ReturnType<typeof journeyCensus>>;
let captured: Awaited<ReturnType<typeof captureStoreJourney>>;
let pristine: typeof captured;
beforeAll(async () => {
  source = await resources.installation("readiness-source");
  target = await resources.installation("readiness-target");
  pristine = await captureStoreJourney(target.owner, "readiness-pristine");
  const client = (await source.owner.query("INSERT INTO public.clients(email) VALUES('readiness-transfer@example.invalid') RETURNING id")).rows[0].id;
  await source.owner.query("INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at) VALUES($1,28,statement_timestamp()+interval '28 days')", [client]);
  await source.owner.query("INSERT INTO public.subscriptions(client_id,cadence_days,offer_policy_assignment_state,is_test_fixture) VALUES($1,28,'legacy_frozen',true)", [client]);
  expect((await source.runtime.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline() AS value")).rows[0].value).toMatchObject({ expectedCount: 0, created: true });
  original = await journeyCensus(source.owner);
  captured = await captureStoreJourney(source.owner, "readiness-source");
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

// Local body 3.36 s; CI body 8.04 s / 11.00 s (10 s timeout); 35 s gives about 3x worst CI headroom.
it("transfer_preserves_marking_baseline_and_subscription_evidence_without_recapture", async () => {
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet: captured, freshTarget: pristine }))
    .toEqual({ captureSha256: captured.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
  expect(await journeyCensus(target.owner)).toEqual(original);
  expect(original.commerce_offer_policy_cohort_marking).toHaveLength(1);
  expect(original.commerce_offer_policy_rollout_baselines).toHaveLength(1);
  expect(original.subscriptions.map(row => JSON.parse(row).offer_policy_assignment_state).sort()).toEqual(["legacy_frozen", "pending_acquisition"]);
  expect((await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet: captured, freshTarget: pristine })).replayed).toBe(true);
  expect(await journeyCensus(target.owner)).toEqual(original);
}, 35_000);
