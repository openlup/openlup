import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ConsentPushRequest } from "@openlup/platform/communications/contracts";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../../../tests/helpers/postgresContainer.js";
import { createA1ReferenceBinding, type A1HostInputs } from "./a1ReferenceBinding.js";
import { createMarketingPostgresHost, marketingPostgresHostSetup } from "./marketingPostgresHost.js";

let container: PostgresContainer | undefined, pool: Pool;
const profile = "single-process" as const, environment = "offline";
const accountKey = (account: string) => JSON.stringify(["communications-adapter", account, environment]);
const empty = () => ({ version: 1, coolingUntil: 0, nextAt: 0, slot: false, quarantined: false,
  entries: {}, mappings: {}, tombstones: [], withdrawals: {} });
const host = (account: string, database: PgQueryExecutor = pool) => createMarketingPostgresHost({ database, account, environment, profile, maxJournalBytes: 262144 });
async function recover(value: ReturnType<typeof host>) {
  const snapshot = await value.recoverySnapshot();
  return value.reconcile({ quiesced: true, expected: snapshot.raw, reviewedUnsettledEntryKeys: snapshot.unsettledEntryKeys, evidenceReference: "offline:reviewed-synthetic-journal" });
}
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("M2 requires real local PostgreSQL");
  container = await runPostgresContainer({ name: `marketing-host-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("M2 PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  await pool.query(marketingPostgresHostSetup);
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

it("performs exact TEXT CAS, proves conflicts are non-writes and retains committed lost replies", async () => {
  const value = host("cas"), key = accountKey("cas");
  const original = ' { "unicode": "ż", "order": [2,1] } ';
  const started = performance.now();
  expect(await value.storage.get(key)).toBeNull();
  expect(await value.storage.compareAndSwap(key, null, original)).toBe(true);
  expect(await value.storage.get(key)).toBe(original);
  expect(await value.storage.compareAndSwap(key, null, "wrong-insert")).toBe(false);
  expect(await value.storage.compareAndSwap(key, "foreign", "wrong-update")).toBe(false);
  expect(await value.storage.get(key)).toBe(original);
  expect(await value.storage.compareAndSwap(key, original, "replacement")).toBe(true);
  let lose = true;
  const lost = host("lost", { async query(text, values) {
    const result = await pool.query(text, values);
    if (lose && text.startsWith("INSERT")) { lose = false; throw new Error("synthetic committed reply loss"); }
    return result;
  } });
  await expect(lost.storage.compareAndSwap(accountKey("lost"), null, original)).rejects.toThrow("committed reply loss");
  expect(await lost.storage.get(accountKey("lost"))).toBe(original);
  expect(await lost.storage.compareAndSwap(accountKey("lost"), null, "duplicate")).toBe(false);
  const racing = host("race"), raceKey = accountKey("race");
  expect((await Promise.all([racing.storage.compareAndSwap(raceKey, null, "one"), racing.storage.compareAndSwap(raceKey, null, "two")])).sort()).toEqual([false, true]);
  console.info(`M2 exact-byte CAS elapsed_ms=${Math.round(performance.now() - started)} original_bytes=${Buffer.byteLength(original)}`);
});

it("keeps startup closed and requires quiesced exact-snapshot reconciliation without changing fences", async () => {
  const value = host("recovery"), key = accountKey("recovery");
  const ledger = { ...empty(), slot: true, quarantined: true, coolingUntil: 12000, nextAt: 13000,
    entries: { unresolved: { phase: "dispatched", request: { requestId: "same-id", generation: 2 }, result: { kind: "unknown", reason: "acceptance_ambiguous" } } },
    mappings: { subject: "remote-profile" }, tombstones: ["erased-subject"], withdrawals: { withdrawal: { resolved: false, earlier: ["unresolved"] } } };
  const raw = JSON.stringify(ledger);
  await value.storage.compareAndSwap(key, null, raw);
  const restarted = host("recovery");
  expect(restarted.storage.availability).toMatchObject({ busy: false, quarantined: true });
  const snapshot = await restarted.recoverySnapshot();
  expect(snapshot).toMatchObject({ raw, bytes: Buffer.byteLength(raw), entries: 1, unsettledEntryKeys: ["unresolved"] });
  await expect(restarted.reconcile({ quiesced: true, expected: raw, reviewedUnsettledEntryKeys: [], evidenceReference: "offline:read" })).rejects.toThrow("unreconciled_entries");
  expect(restarted.storage.availability.quarantined).toBe(true);
  restarted.storage.availability.busy = true;
  await expect(recover(restarted)).rejects.toThrow("quiescence_required");
  restarted.storage.availability.busy = false;
  await expect(restarted.reconcile({ quiesced: false as true, expected: raw, reviewedUnsettledEntryKeys: ["unresolved"], evidenceReference: "offline:read" })).rejects.toThrow("quiescence_required");
  await expect(restarted.reconcile({ quiesced: true, expected: "outdated", reviewedUnsettledEntryKeys: ["unresolved"], evidenceReference: "offline:read" })).rejects.toThrow("recovery_conflict");
  await expect(restarted.reconcile({ quiesced: true, expected: raw, reviewedUnsettledEntryKeys: ["unresolved"], evidenceReference: "" })).rejects.toThrow("recovery_evidence_required");
  expect(await recover(restarted)).toMatchObject({ unresolvedEntries: 1, evidenceReference: "offline:reviewed-synthetic-journal" });
  expect(JSON.parse((await restarted.storage.get(key))!)).toEqual({ ...ledger, slot: false, quarantined: false });
  expect(restarted.storage.availability).toMatchObject({ busy: false, quarantined: false });
  expect(host("recovery").storage.availability.quarantined).toBe(true);
});

it("keeps failed recovery quarantined and refuses foreign scope, size overflow and unsupported profiles", async () => {
  const value = host("closed"), key = accountKey("closed");
  await expect(value.storage.get(accountKey("foreign"))).rejects.toThrow("account_key_mismatch");
  await expect(value.storage.compareAndSwap(key, null, "x".repeat(262145))).rejects.toThrow("journal_budget");
  expect(await value.storage.get(key)).toBeNull();
  await value.storage.compareAndSwap(key, null, JSON.stringify({ version: 2 }));
  await expect(value.recoverySnapshot()).rejects.toThrow("journal_invalid");
  expect(value.storage.availability.quarantined).toBe(true);
  expect(() => createMarketingPostgresHost({ database: pool, account: "closed", environment, profile: "multi-process" as "single-process", maxJournalBytes: 1024 })).toThrow("single_process_required");
  const recovery = host("recovery-lost");
  await recovery.storage.compareAndSwap(accountKey("recovery-lost"), null, JSON.stringify(empty()));
  const uncertain = host("recovery-lost", { async query(text, values) {
    const result = await pool.query(text, values);
    if (text.startsWith("UPDATE")) throw new Error("synthetic recovery commit reply loss");
    return result;
  } });
  await expect(recover(uncertain)).rejects.toThrow("recovery commit reply loss");
  expect(uncertain.storage.availability).toMatchObject({ busy: false, quarantined: true });
  expect(host("recovery-lost").storage.availability.quarantined).toBe(true);
});

function adapterFixture(account: string, storage: A1HostInputs["marketing"]["storage"]) {
  const binding = { account, environment, namespace: "synthetic", mappingVersion: "v1" };
  const audience = { kind: "audience" as const, reference: "audience:1" };
  const state = { now: 10, effects: 0, grantResponseLost: false };
  const target = { binding, subjectReference: "subject:1", generation: 1, erased: false,
    id: "owned_1", email: "synthetic@example.invalid", externalReference: "local:1", ownedFields: [] as const, ownedProperties: [] };
  const request = (action: "grant" | "withdraw", requestId = action + ":1"): ConsentPushRequest => ({
    binding, audience, subjectReference: target.subjectReference, requestId, generation: 1, deadlineMs: 100000,
    authorizationReference: "authorization:push", operation: "consent.push", payload: { action, consentEvidenceReference: action + ":evidence" },
  } as ConsentPushRequest);
  const marketing: A1HostInputs["marketing"] = {
    binding, audience, subjectMapper: reference => reference === target.subjectReference ? target : undefined,
    resolveCredential: () => ({ binding, key: "synthetic-only" }), storage,
    authorizations: new Map([["authorization:push", { binding, audience, subjectReference: target.subjectReference, operation: "consent.push", expiresAtMs: 100000 }]]),
    localEvidence: new Map([
      ["grant:evidence", { binding, audience, subjectReference: target.subjectReference, purpose: "synthetic", action: "grant", current: true }],
      ["withdraw:evidence", { binding, audience, subjectReference: target.subjectReference, purpose: "synthetic", action: "withdraw", current: true }],
    ]),
    verification: { binding, audience, revision: "2026-07-15", evidenceReference: "offline:synthetic-not-TEST", operations: ["consent.push"],
      scopes: ["profiles:read", "profiles:write", "subscriptions:write", "lists:write"], noTrigger: { profile: true, accountWideGrant: true, doi: true },
      safeCreate: false, safeListRemoval: true, suppressionSafeAtEffect: true, negativeSourcesComplete: true, listMappings: { LIST1: audience } },
    now: () => state.now, rateIntervalMs: 1, timeoutMs: 25,
    fetch: async (_url, init) => {
      state.now += 2;
      if (init?.method === "GET") return Response.json({ data: { type: "profile", id: target.id, attributes: {
        email: target.email, external_id: target.externalReference, subscriptions: { email: { marketing: {
          consent: "NEVER_SUBSCRIBED", suppression: [], list_suppressions: [], can_receive_email_marketing: true,
        } } },
      } } });
      state.effects++;
      if (state.grantResponseLost && init?.method === "POST") throw new Error("synthetic response lost after fake acceptance");
      return new Response(null, { status: init?.method === "DELETE" ? 204 : 202 });
    },
  };
  async function build(selectedStorage = storage) {
    const candidate = { artifact: "synthetic", configuration: "explicit", environment, database: "disposable", schema: "synthetic" };
    const inputs: A1HostInputs = {
      migrationIdentity: "synthetic",
      admission: { candidate, currentIdentity: () => candidate,
        observed: { loadedPackages: [{ name: "@openlup/core", version: "0.38.0", kind: "kernel" }, { name: "@openlup/platform", version: "0.38.0", kind: "rail" }], inventoryComplete: true },
        schemaProbe: { observe: async required => ({ database: candidate.database, version: candidate.schema, objects: required.objects.map(object => ({ object, present: true })) }) } },
      sender: { environmentTagName: "synthetic_env", policy: () => { throw new Error("unexpected send"); } },
      callback: { port: { findSend: async () => null, applyObservation: async () => {}, recordAttempt: async () => {} }, webhookSecret: "synthetic", environmentTagName: "synthetic_env", resolveReceiverEnvironmentTag: () => "non_production" },
      marketing: { ...marketing, storage: selectedStorage },
      delivery: { database: { connectionString: "postgresql://unused.invalid/synthetic" }, options: { binding: "synthetic" }, resolveCredential: () => { throw new Error("unexpected credential"); }, now: () => "2026-11-11T00:00:00.000Z", graceMinutes: 1, limit: 1 },
    };
    return (await createA1ReferenceBinding({ enabled: true, loadHostInputs: () => inputs }))!.ports.marketing;
  }
  return { state, request, build };
}

it("reconstructs the real adapter over PostgreSQL and retains replay and withdrawal fences after response loss", async () => {
  const value = host("adapter"), fixture = adapterFixture("adapter", value.storage);
  const initial = await fixture.build();
  expect(await initial.consentPush.push(fixture.request("grant"))).toMatchObject({ kind: "retryable", reason: "cooling" });
  expect(fixture.state.effects).toBe(0);
  await recover(value);
  const first = await fixture.build();
  fixture.state.grantResponseLost = true;
  expect(await first.consentPush.push(fixture.request("grant"))).toMatchObject({ kind: "unknown", reason: "acceptance_ambiguous" });
  expect(fixture.state.effects).toBe(1);
  fixture.state.grantResponseLost = false;
  const restarted = host("adapter"), closed = await fixture.build(restarted.storage);
  expect(await closed.consentPush.push(fixture.request("withdraw"))).toMatchObject({ kind: "retryable", reason: "cooling" });
  expect(fixture.state.effects).toBe(1);
  const snapshot = await restarted.recoverySnapshot();
  expect(snapshot.unsettledEntryKeys).toHaveLength(1);
  await recover(restarted);
  const recovered = await fixture.build(restarted.storage);
  expect(await recovered.consentPush.push(fixture.request("grant"))).toMatchObject({ kind: "unknown", reason: "acceptance_ambiguous" });
  expect(fixture.state.effects).toBe(1);
  expect(await recovered.consentPush.push(fixture.request("withdraw"))).toMatchObject({ kind: "acknowledged", reconcileRequired: true });
  expect(fixture.state.effects).toBe(2);
  expect(await (await fixture.build(restarted.storage)).consentPush.push(fixture.request("withdraw"))).toMatchObject({ kind: "acknowledged", reconcileRequired: true });
  expect(await recovered.consentPush.push(fixture.request("grant", "grant:2"))).toMatchObject({ kind: "refused", reason: "restricted" });
  expect(fixture.state.effects).toBe(2);
  const final = JSON.parse((await restarted.storage.get(accountKey("adapter")))!);
  expect(Object.values(final.withdrawals)).toEqual([expect.objectContaining({ resolved: false })]);
  expect(Object.values(final.entries)).toContainEqual(expect.objectContaining({ phase: "dispatched", result: expect.objectContaining({ kind: "unknown" }) }));
});

it("reconciles a real committed result-write reply loss without repeating the accepted mutation", async () => {
  let lost = false;
  const database: PgQueryExecutor = { async query(text, values) {
    const result = await pool.query(text, values);
    if (!lost && text.startsWith("UPDATE") && typeof values?.[2] === "string" && values[2].includes('"kind":"acknowledged"')) {
      lost = true;
      throw new Error("synthetic accepted-result commit reply loss");
    }
    return result;
  } };
  const value = host("result-lost", database), fixture = adapterFixture("result-lost", value.storage);
  await recover(value);
  const first = await fixture.build();
  expect(await first.consentPush.push(fixture.request("grant"))).toMatchObject({ kind: "acknowledged", journal: "unknown" });
  expect(lost).toBe(true);
  expect(fixture.state.effects).toBe(1);
  expect(value.storage.availability.quarantined).toBe(true);
  const restarted = host("result-lost"), snapshot = await restarted.recoverySnapshot();
  expect(snapshot.unsettledEntryKeys).toHaveLength(1);
  await recover(restarted);
  const recovered = await fixture.build(restarted.storage);
  expect(await recovered.consentPush.push(fixture.request("grant"))).toMatchObject({ kind: "acknowledged", journal: "unknown" });
  expect(fixture.state.effects).toBe(1);
  expect(await recovered.consentPush.push(fixture.request("withdraw"))).toMatchObject({ kind: "acknowledged", reconcileRequired: true });
  expect(fixture.state.effects).toBe(2);
});
