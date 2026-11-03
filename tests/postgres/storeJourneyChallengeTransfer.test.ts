import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresDataGateway, type PgGatewayClient } from "@openlup/platform/data";
import { createCapturedCustomerChallengeDelivery, createCustomerIdentityVerifier, createPostgresCustomerChallengeStore,
  createPostgresCustomerMePort, resolveCustomerSessionBinding } from "@openlup/platform/identity";
import { captureConnectedNativeStore, connectedNativeStoreTables } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, draftStoreJourney, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
let source: JourneyInstallation, target: JourneyInstallation;
const relation = "public.customer_identity_challenges";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
beforeAll(async () => {
  source = await resources.installation("challenge-source");
  target = await resources.installation("challenge-target");
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

it("counts but never carries authorization challenges, restores customer sign-in and preserves the lead absorption result", async () => {
  // No other graph edge may depend on the excluded rows. This is the real
  // installed catalogue, in addition to the owning SQL/source reference search.
  for (const store of [source, target]) {
    expect((await store.owner.query(`SELECT conrelid::regclass::text AS relation,conname
      FROM pg_catalog.pg_constraint WHERE contype='f' AND confrelid=$1::regclass`, [relation])).rows).toEqual([]);
  }
  const pristine = await captureStoreJourney(target.owner, "challenge-pristine");
  const census = (packet: typeof pristine) => packet.outsideProfileCensus.filter(row => row.relation === relation);
  expect(census(pristine)).toEqual([{ relation, owner: journeySelection.migrationLogin, rows: "0", disposition: "intentionally-not-carried" }]);
  expect(pristine.emptyOutsideProfile).not.toContain(relation);
  const draft = await draftStoreJourney(source);
  const client = (await source.owner.query("SELECT principal_id FROM public.clients WHERE id=$1", [draft.clientId])).rows[0];
  const keys = await generateKeyPair("ES256", { extractable: true });
  const keyId = "challenge-transfer", issuer = "https://identity.example.invalid", audience = "challenge-transfer";
  const privateJwk = { ...await exportJWK(keys.privateKey), alg: "ES256", kid: keyId, use: "sig" };
  const publicJwk = { ...await exportJWK(keys.publicKey), alg: "ES256", kid: keyId, use: "sig" };
  const delivered: string[] = [];
  const binding = (store: JourneyInstallation) => {
    const selected = resolveCustomerSessionBinding({ PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: store.runtimeUrl,
      CUSTOMER_IDENTITY_AUDIENCE: audience, CUSTOMER_IDENTITY_ISSUER: issuer,
      CUSTOMER_IDENTITY_KEY_ID: keyId, CUSTOMER_IDENTITY_PRIVATE_JWK: JSON.stringify(privateJwk) }, {
      loadJwt: () => import("jose"),
      delivery: createCapturedCustomerChallengeDelivery(async value => { delivered.push(value.token); }),
    });
    if (!selected.binding) throw new Error(selected.error);
    return selected.binding;
  };
  const sourceSession = binding(source);
  await sourceSession.requestChallenge("journey-001@example.invalid");
  expect(delivered).toHaveLength(1);
  expect(await sourceSession.verifyChallenge(delivered[0]!)).toMatchObject({ user: { id: client.principal_id } });
  expect(await sourceSession.verifyChallenge(delivered[0]!)).toBeNull();
  const tokens = [delivered[0]!, "synthetic-expired-challenge", "synthetic-live-challenge"];
  const hashes = tokens.map(hash);
  // Synthetic lifecycle fixtures supplement the genuinely issued/redeemed row.
  // No clock change or pruning makes this populated relation capturable.
  await source.owner.query(`INSERT INTO public.customer_identity_challenges
    (client_id,principal_id,email_fingerprint,token_hash,created_at,expires_at) VALUES
    ($1,$2,$3,$4,now()-interval '20 minutes',now()-interval '10 minutes'),
    ($1,$2,$3,$5,now(),now()+interval '10 minutes')`,
  [draft.clientId, client.principal_id, hash("journey-001@example.invalid"), hashes[1], hashes[2]]);
  expect((await source.owner.query(`SELECT count(*)::int AS total,
    count(*) FILTER(WHERE used_at IS NOT NULL)::int AS used,
    count(*) FILTER(WHERE used_at IS NULL AND expires_at<now())::int AS expired,
    count(*) FILTER(WHERE used_at IS NULL AND expires_at>now())::int AS live FROM public.customer_identity_challenges`)).rows)
    .toEqual([{ total: 3, used: 1, expired: 1, live: 1 }]);
  const queries: string[] = [];
  const packet = await captureConnectedNativeStore({ sourceId: "challenge-source", catalogueId: pristine.compatible.catalogueId,
    maximumRows: 10000, maximumBytes: 64 * 1024 * 1024, source: { async withSnapshot(work) {
      const db = await source.owner.connect();
      try {
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await work({ query: (sql, values) => {
          queries.push(sql);
          return db.query(sql, values ? [...values] : undefined);
        } });
        await db.query("COMMIT"); return result;
      } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    } } });
  expect(queries.filter(sql => sql.includes("customer_identity_challenges")))
    .toEqual(['SELECT count(*)::pg_catalog.text AS count FROM "public"."customer_identity_challenges"']);
  expect(census(packet)).toEqual([{ relation, owner: journeySelection.migrationLogin, rows: "3", disposition: "intentionally-not-carried" }]);
  expect(packet.emptyOutsideProfile).not.toContain(relation);
  const carried = [...packet.compatible.tables, ...packet.owned].map(table => table.table);
  expect(carried).toEqual([...connectedNativeStoreTables]);
  expect(carried).not.toContain("customer_identity_challenges");
  const serialized = JSON.stringify(packet);
  for (const value of [...tokens, ...hashes, "token_hash", "email_fingerprint"]) expect(serialized).not.toContain(value);
  const policy = (await source.owner.query("SELECT table_name,disposition,note FROM public.client_absorption_policy WHERE table_name='customer_identity_challenges'")).rows;
  expect(policy).toHaveLength(1);
  expect(policy[0]).toMatchObject({ table_name: "customer_identity_challenges", disposition: "block" });
  const restore = () => restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine });
  expect(await restore()).toMatchObject({ captureSha256: packet.sha256, replayed: false });
  expect((await target.owner.query("SELECT count(*)::int AS count FROM public.customer_identity_challenges")).rows).toEqual([{ count: 0 }]);
  expect(await restore()).toMatchObject({ replayed: true });
  expect((await target.owner.query("SELECT table_name,disposition,note FROM public.client_absorption_policy WHERE table_name='customer_identity_challenges'")).rows).toEqual(policy);

  const challengeStore = createPostgresCustomerChallengeStore({ connectionString: target.runtimeUrl });
  try {
    for (const tokenHash of hashes) expect(await challengeStore.redeem({ tokenHash, now: new Date().toISOString() })).toBeNull();
  } finally { await challengeStore.close(); }
  const restoredSession = binding(target);
  await restoredSession.requestChallenge("journey-001@example.invalid");
  expect(delivered).toHaveLength(2);
  expect(tokens).not.toContain(delivered[1]);
  const session = await restoredSession.verifyChallenge(delivered[1]!);
  expect(session).toMatchObject({ user: { id: client.principal_id, email: "journey-001@example.invalid" } });
  if (!session) throw new Error("Restored customer did not sign in");
  expect(await restoredSession.verifyChallenge(delivered[1]!)).toBeNull();
  const verifier = createCustomerIdentityVerifier({ audience, issuer, jwks: JSON.stringify({ keys: [publicJwk] }) }, () => import("jose"));
  const principal = await verifier.verifyAccessToken(session.accessToken);
  expect(principal?.principalId).toBe(client.principal_id);
  if (!principal) throw new Error("Issued session did not verify");
  const gateway = createPostgresDataGateway({ connectionString: target.runtimeUrl }, { poolFactory: () => target.runtime });
  const me = (principalId: string) => gateway.asActor({ sub: principalId, role: "authenticated" },
    db => createPostgresCustomerMePort(db as PgGatewayClient).getCustomerMe(principalId));
  expect(await me(principal.principalId)).toEqual({ clientId: draft.clientId, email: "journey-001@example.invalid",
    firstName: null, lastName: null, lifecycleStage: "customer" });
  expect(await me(randomUUID())).toBeNull();

  // Equivalent leads on each installation exercise the real versioned routine.
  // Compare the result without prescribing the current classification policy.
  const operator = randomUUID(), lead = randomUUID(), email = "challenge-lead@example.invalid";
  const at = new Date().toISOString(), results: unknown[] = [];
  for (const store of [source, target]) {
    await store.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'operator@example.invalid')", [operator]);
    await store.owner.query(`INSERT INTO public.platform_human_memberships
      (principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)`, [operator, at]);
    await store.owner.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operator]);
    await store.owner.query("INSERT INTO public.clients(id,email,lifecycle_stage) VALUES($1,$2,'lead')", [lead, email]);
    const leadChallenges = createPostgresCustomerChallengeStore({ connectionString: store.runtimeUrl });
    try {
      expect(await leadChallenges.issue({ email, tokenHash: hash("synthetic-lead-challenge"),
        expiresAt: new Date(Date.now() + 600_000).toISOString() })).toEqual({ deliverable: true });
    } finally { await leadChallenges.close(); }
    results.push((await store.runtime.query("SELECT public.customer_support_absorb_lead_v1($1,$2,$3,$4,$5,$6) AS value",
      [operator, draft.clientId, lead, email, "challenge-absorption-refusal", at])).rows[0].value);
    expect((await store.owner.query("SELECT email,principal_id,metadata FROM public.clients WHERE id=$1", [lead])).rows)
      .toEqual([{ email, principal_id: null, metadata: {} }]);
    expect((await store.owner.query("SELECT count(*)::int AS count FROM public.customer_identity_challenges WHERE client_id=$1", [lead])).rows)
      .toEqual([{ count: 1 }]);
  }
  expect(results[0]).toMatchObject({ outcome: expect.any(String), refusalCode: expect.any(String), blockingTables: expect.any(Array) });
  // Includes exact outcome, refusal code and blocking-table array equality.
  expect(results[1]).toEqual(results[0]);
  // A named exception never grants a schema-wide or authorization-name bypass.
  await source.owner.query("CREATE TABLE public.challenge_transfer_probe(id integer); INSERT INTO public.challenge_transfer_probe VALUES(1)");
  try {
    await expect(captureStoreJourney(source.owner, "challenge-unknown-table"))
      .rejects.toMatchObject({ code: "unsupported_table", table: "public.challenge_transfer_probe" });
  } finally { await source.owner.query("DROP TABLE public.challenge_transfer_probe"); }
}, 30_000);
