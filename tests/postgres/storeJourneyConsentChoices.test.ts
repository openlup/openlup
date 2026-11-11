import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createPostgresDataGateway, type PgGatewayClient } from "@openlup/platform/data";
import { createPostgresAccountLinkStore } from "@openlup/platform/identity";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { assertJourneyWithoutIntake, captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
afterAll(() => resources.close(), postgresTeardownTimeoutMs);
type Choices = Record<string, unknown>;
type Receipt = { permissionEventId: string; workId: string | null; replayed: boolean; choices: Choices };

it.each([["marketing_newsletter", "marketingNewsletter"], ["marketing_gifts_discounts", "marketingGiftsDiscounts"]] as const)(
  "restores %s choice, withdrawal replay and customer ownership", async (purpose, field) => {
    const source = await resources.installation(`consent-${field}-source`), target = await resources.installation(`consent-${field}-target`);
    for (const store of [source, target]) await assertJourneyWithoutIntake(store);
    const pristine = await captureStoreJourney(target.owner, "consent-pristine");
    const accounts = createPostgresAccountLinkStore({ connectionString: source.runtimeUrl });
    const create = async (email: string) => {
      const principal = randomUUID();
      const customer = await accounts.createAccount({ email, principalId: principal, acquisitionSource: "synthetic", lifecycleStage: "customer" });
      return { id: customer.id, principal, email };
    };
    let customer: Awaited<ReturnType<typeof create>>, stranger: Awaited<ReturnType<typeof create>>;
    try {
      customer = await create(`consent-${field.toLowerCase()}@example.invalid`);
      stranger = await create(`other-${field.toLowerCase()}@example.invalid`);
    } finally { await accounts.close(); }
    // Installation-owned configuration enables the existing outbox rail; no provider is contacted.
    await source.owner.query("INSERT INTO public.customer_account_consent_sync_targets(binding,provider_kind,enabled) VALUES('journey-consent','synthetic',true)");
    const query = <T>(store: JourneyInstallation, principal: string, sql: string, values: unknown[]) => {
      const gateway = createPostgresDataGateway({ connectionString: store.runtimeUrl }, { poolFactory: () => store.runtime });
      return gateway.asActor({ sub: principal, role: "authenticated" }, async db => {
        const actor = db as PgGatewayClient;
        expect((await actor.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
          .toEqual([{ current_user: "authenticated", session_user: journeySelection.runtimeLogin, rolsuper: false, rolbypassrls: false }]);
        return (await actor.query(sql, values)).rows[0].value as T;
      });
    };
    const read = (store: JourneyInstallation, principal = customer.principal) => query<Choices>(store, principal,
      "SELECT public.customer_account_communication_choices_as_actor($1) AS value", [customer.id]);
    const set = (store: JourneyInstallation, value: boolean, key: string, principal = customer.principal) => query<Receipt>(store, principal,
      "SELECT public.customer_account_communication_choice_set_as_actor($1,$2,$3,$4) AS value", [customer.id, purpose, value, key]);
    const grantKey = `journey-grant-${purpose}`, withdrawKey = `journey-withdraw-${purpose}`;
    expect(await read(source)).toMatchObject({ [field]: { state: "unknown", granted: false } });
    const granted = await set(source, true, grantKey);
    expect(granted).toMatchObject({ replayed: false, permissionEventId: expect.any(String), workId: expect.any(String),
      choices: { [field]: { purpose, state: "granted", granted: true, reason: "customer_self_service_grant" } } });
    expect(await read(source)).toEqual(granted.choices);
    const sourceBefore = await journeyCensus(source.owner);
    expect(await set(source, true, grantKey)).toEqual({ ...granted, replayed: true });
    expect(await journeyCensus(source.owner)).toEqual(sourceBefore);
    const packet = await captureStoreJourney(source.owner, "consent-granted");
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine })).toMatchObject({ replayed: false });
    expect(await journeyCensus(target.owner)).toEqual(sourceBefore);
    expect(await read(target)).toEqual(granted.choices);
    expect(await set(target, true, grantKey)).toEqual({ ...granted, replayed: true });
    expect(await journeyCensus(target.owner)).toEqual(sourceBefore);
    await expect(read(target, stranger.principal)).rejects.toMatchObject({ code: "42501", message: "account_consent_client_not_owned" });
    await expect(set(target, false, "other-customer-write", stranger.principal)).rejects.toMatchObject({ code: "42501", message: "account_consent_client_not_owned" });
    await expect(set(target, false, grantKey)).rejects.toMatchObject({ code: "23505", message: "account_consent_idempotency_conflict" });
    expect(await journeyCensus(target.owner)).toEqual(sourceBefore);
    const withdrawn = await set(target, false, withdrawKey);
    expect(withdrawn).toMatchObject({ replayed: false, permissionEventId: expect.any(String), workId: expect.any(String),
      choices: { [field]: { purpose, state: "denied", granted: false, reason: "customer_self_service_denial" } } });
    expect(withdrawn.permissionEventId).not.toBe(granted.permissionEventId);
    expect(withdrawn.workId).not.toBe(granted.workId);
    expect(await read(target)).toEqual(withdrawn.choices);
    const afterWithdrawal = await journeyCensus(target.owner);
    for (const table of ["customer_account_consent_events", "communication_native_sync_state", "outbox_events"]) {
      expect(afterWithdrawal[table]).toHaveLength(sourceBefore[table]!.length + 1);
    }
    expect(await set(target, false, withdrawKey)).toEqual({ ...withdrawn, replayed: true });
    await expect(set(target, true, withdrawKey)).rejects.toMatchObject({ code: "23505" });
    await expect(read(target, stranger.principal)).rejects.toMatchObject({ code: "42501" });
    await expect(set(target, true, "other-withdraw-replay", stranger.principal)).rejects.toMatchObject({ code: "42501" });
    expect(await journeyCensus(target.owner)).toEqual(afterWithdrawal);
    expect(await read(source)).toEqual(granted.choices);
    expect(await journeyCensus(source.owner)).toEqual(sourceBefore);
  // The two-case guest file measured 21.67 s total; 90 s per case exceeds four times that measured total.
  }, 140_000);
