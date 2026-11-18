import { createOutboxOrderPaidFulfillmentHandler, createPostgresFulfillmentStockSyncPort, createPostgresPaidFulfillmentHandoffStore } from "@openlup/platform/fulfillment";
import { qualifiedPostgresStartupOptions } from "@openlup/platform/migrations";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { createPostgresCatalogPublication,createCatalogProductTypeRegistry,installCatalogDefinitions,catalogDefinitionDigest,canonicalCatalogDraftJson,catalogAcceptedReferenceV2Schema,createPostgresCatalogWithdrawalImpact } from "@openlup/platform/catalog";
import type { CatalogDraftPayloadV4,CatalogDraftPayloadV5,CatalogHeadRef,CatalogProductTypeDefinition,CatalogOptionValue } from "@openlup/platform/catalog/contracts";
import { createNativeCatalogRenewalCodecV2,createPostgresSuccessorStore,createPostgresSuccessorNotices,successorNoticeSources,createPostgresPackageEditor,createPostgresStockWaitStore,createPostgresSizedEditor,type SizedHostPorts } from "@openlup/platform/subscriptions";
import { readOutboxDispatchConfig } from "@openlup/outbox";
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";
import type { SubscriptionEditConsent } from "@openlup/platform/subscriptions/contracts";
import type { SubscriptionLifecycleMessageDescriptor } from "@openlup/platform/subscriptions/contracts";
import type { HistoricalSuccessorProtocolBinding } from "@openlup/platform/subscriptions";
import type { OutboxEventRow } from "@openlup/core/outbox";
import { createPostgresTransactionalDeliveryStore,createTransactionalDelivery,createCapturedTransactionalDelivery } from "@openlup/platform/communications";
import { ecommercePaid } from "./communicationEcommerceFixture.js";
import { captureStoreJourney,journeyCensus,journeySelection,storeJourneyResources,type JourneyInstallation } from "../helpers/storeJourney.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const migration = "db/platform/migrations/20261123210000_catalog_successors.sql";
const successorEditLimits = {
  package: { maximumPlanDays: 90, maximumBaseLines: 6, maximumAddonLines: 12, maximumQuantity: 99 },
  sized: { allowedCadences: [28, 90], maximumCoreLines: 6, maximumAddonLines: 12, maximumQuantity: 99 },
};
const containers: PostgresContainer[] = [], pools: Pool[] = [];
const transferResources=storeJourneyResources();
let transferSource:JourneyInstallation,transferTarget:JourneyInstallation;
let pool: Pool, db: PoolClient, connectionString:string;
beforeAll(async () => {
  const container = await runPostgresContainer({ name: `catalog-successors-${process.pid}`, password: "synthetic-successors" }); containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Successor witnesses require real PostgreSQL");
  connectionString=container.connectionString;
  pool = new Pool({ connectionString: container.connectionString }); pools.push(pool);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === migration) {
      // A host default grant makes each explicit PUBLIC revoke observable.
      await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC");
    }
    await pool.query(readFileSync(unit.file, "utf8"));
    if (unit.file === migration) {
      await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM PUBLIC");
    }
  }
  transferSource=await transferResources.installation("successor-source");
  transferTarget=await transferResources.installation("successor-target");
}, postgresSetupTimeoutMs);
afterAll(async()=>{try{await transferResources.close();}finally{await closePostgres(containers,pools);}}, postgresTeardownTimeoutMs);
beforeEach(async () => { db = await pool.connect(); await db.query("BEGIN"); });
afterEach(async () => { await db.query("ROLLBACK"); db.release(); });

it("lc10_storage_shape_exact", async () => {
  await db.query("SET LOCAL search_path = pg_catalog");
  const tables = [
    "catalog_sku_successors",
    "subscription_successor_proposals",
    "subscription_successor_operations_v2",
    "subscription_successor_wait_cases_v2",
    "subscription_successor_reservations_v2",
  ];
  const { rows } = await db.query<{ table_name: string; protection: string }>(`
    WITH relations AS (
      SELECT c.oid, c.relname, c.relrowsecurity, c.relacl, c.relowner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    )
    SELECT relname AS table_name, protection
    FROM relations r CROSS JOIN LATERAL (
      SELECT 'TABLE' AS protection
      UNION ALL SELECT 'ROW LEVEL SECURITY' WHERE r.relrowsecurity
      UNION ALL SELECT 'PUBLIC ' || acl.privilege_type
        FROM aclexplode(coalesce(r.relacl, acldefault('r', r.relowner))) acl WHERE acl.grantee = 0
      UNION ALL SELECT 'NOT NULL ' || a.attname
        FROM pg_attribute a WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
      UNION ALL SELECT 'DEFAULT ' || a.attname || ' ' || pg_get_expr(d.adbin, d.adrelid)
        FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = r.oid
      UNION ALL SELECT pg_get_constraintdef(c.oid) || CASE WHEN c.convalidated THEN '' ELSE ' [UNVALIDATED]' END
        FROM pg_constraint c WHERE c.conrelid = r.oid
      UNION ALL SELECT pg_get_indexdef(i.indexrelid)
        FROM pg_index i WHERE i.indrelid = r.oid
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.conrelid = r.oid)
    ) AS shape
  `, [tables]);
  const shape = tables.map(table => [
    table, ...rows.filter(row => row.table_name === table).map(row => row.protection).sort(),
  ].join("\n")).join("\n\n");
  expect(shape).toBe(`catalog_sku_successors
CHECK ((predecessor_sku_id <> successor_sku_id))
FOREIGN KEY (predecessor_sku_id) REFERENCES public.catalog_skus(id) ON DELETE RESTRICT
FOREIGN KEY (publication_id) REFERENCES public.catalog_publications(id) ON DELETE RESTRICT
FOREIGN KEY (successor_sku_id) REFERENCES public.catalog_skus(id) ON DELETE RESTRICT
NOT NULL predecessor_sku_id
NOT NULL publication_id
NOT NULL successor_sku_id
PRIMARY KEY (predecessor_sku_id, successor_sku_id)
ROW LEVEL SECURITY
TABLE

subscription_successor_proposals
CHECK (((length(btrim(action)) >= 1) AND (length(btrim(action)) <= 80)))
CHECK (((length(btrim(lane)) >= 1) AND (length(btrim(lane)) <= 80)))
CHECK (((length(quote_hash) = 64) AND (translate(quote_hash, 'abcdef0123456789'::text, ''::text) = ''::text)))
CHECK (((template_version >= 1) AND (template_version <= 2147483647)))
CHECK ((jsonb_typeof(preview) = 'object'::text))
CHECK ((jsonb_typeof(request) = 'object'::text))
CHECK ((jsonb_typeof(source_binding) = 'object'::text))
CHECK ((state = ANY (ARRAY['offered'::text, 'accepted'::text, 'declined'::text, 'expired'::text])))
DEFAULT created_at now()
DEFAULT state 'offered'::text
FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE RESTRICT
FOREIGN KEY (original_case_id) REFERENCES public.subscription_stock_wait_cases(id) ON DELETE RESTRICT
FOREIGN KEY (original_operation_id) REFERENCES public.subscription_renewal_operations(id) ON DELETE RESTRICT
FOREIGN KEY (predecessor_sku_id) REFERENCES public.catalog_skus(id) ON DELETE RESTRICT
FOREIGN KEY (publication_id) REFERENCES public.catalog_publications(id) ON DELETE RESTRICT
FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE RESTRICT
FOREIGN KEY (successor_sku_id) REFERENCES public.catalog_skus(id) ON DELETE RESTRICT
NOT NULL action
NOT NULL client_id
NOT NULL created_at
NOT NULL expires_at
NOT NULL id
NOT NULL lane
NOT NULL predecessor_sku_id
NOT NULL preview
NOT NULL publication_id
NOT NULL quote_hash
NOT NULL request
NOT NULL source_binding
NOT NULL state
NOT NULL subscription_id
NOT NULL successor_sku_id
NOT NULL template_version
PRIMARY KEY (id)
ROW LEVEL SECURITY
TABLE

subscription_successor_operations_v2
CHECK (((claim_generation >= 1) AND (claim_generation <= '9223372036854775807'::bigint)))
CHECK (((cycle_number >= 1) AND (cycle_number <= 2147483647)))
CHECK (((length(btrim(claimed_by)) >= 1) AND (length(btrim(claimed_by)) <= 240)))
CHECK (((length(identity_key) >= 48) AND (length(identity_key) <= 240)))
CHECK (((length(operation_fingerprint) = 64) AND (translate(operation_fingerprint, 'abcdef0123456789'::text, ''::text) = ''::text)))
CHECK ((jsonb_typeof(cycle_snapshot) = 'object'::text))
CHECK ((jsonb_typeof(due_snapshot) = 'object'::text))
CHECK ((jsonb_typeof(outcomes) = 'array'::text))
CHECK ((state = ANY (ARRAY['claimed'::text, 'reserved'::text, 'attempt_prepared'::text, 'succeeded'::text, 'refused'::text])))
CREATE INDEX subscription_successor_operations_v2_due_idx ON public.subscription_successor_operations_v2 USING btree (state, lease_expires_at, scheduled_at)
CREATE UNIQUE INDEX subscription_successor_operations_v2_live_root_key ON public.subscription_successor_operations_v2 USING btree (root_operation_id) WHERE (superseded_by_proposal_id IS NULL)
DEFAULT claim_generation 1
DEFAULT created_at now()
DEFAULT outcomes '[]'::jsonb
DEFAULT updated_at now()
FOREIGN KEY (cycle_id) REFERENCES public.subscription_cycles(id) ON DELETE RESTRICT
FOREIGN KEY (fulfillment_id) REFERENCES public.fulfillment_shipments(id) ON DELETE RESTRICT
FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE RESTRICT
FOREIGN KEY (predecessor_generation_id) REFERENCES public.subscription_successor_operations_v2(id) ON DELETE RESTRICT
FOREIGN KEY (proposal_id) REFERENCES public.subscription_successor_proposals(id) ON DELETE RESTRICT
FOREIGN KEY (root_operation_id) REFERENCES public.subscription_renewal_operations(id) ON DELETE RESTRICT
FOREIGN KEY (settlement_intent_id) REFERENCES public.commerce_settlement_intents(id) ON DELETE RESTRICT
FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE RESTRICT
FOREIGN KEY (superseded_by_proposal_id) REFERENCES public.subscription_successor_proposals(id) ON DELETE RESTRICT
NOT NULL claim_generation
NOT NULL claim_token
NOT NULL claimed_at
NOT NULL claimed_by
NOT NULL created_at
NOT NULL cycle_number
NOT NULL cycle_snapshot
NOT NULL due_snapshot
NOT NULL id
NOT NULL identity_key
NOT NULL lease_expires_at
NOT NULL operation_fingerprint
NOT NULL outcomes
NOT NULL proposal_id
NOT NULL root_operation_id
NOT NULL scheduled_at
NOT NULL state
NOT NULL subscription_id
NOT NULL updated_at
PRIMARY KEY (id)
ROW LEVEL SECURITY
TABLE
UNIQUE (cycle_id)
UNIQUE (fulfillment_id)
UNIQUE (identity_key)
UNIQUE (order_id)
UNIQUE (proposal_id)
UNIQUE (settlement_intent_id)

subscription_successor_wait_cases_v2
CHECK (((cycle_number >= 1) AND (cycle_number <= 2147483647)))
CHECK (((length(fingerprint) = 64) AND (translate(fingerprint, 'abcdef0123456789'::text, ''::text) = ''::text)))
CHECK ((jsonb_typeof(cycle_snapshot) = 'object'::text))
CHECK ((jsonb_typeof(deficits) = 'array'::text))
CHECK ((jsonb_typeof(due_snapshot) = 'object'::text))
CHECK ((state = ANY (ARRAY['waiting'::text, 'stock_secured'::text, 'resumed'::text, 'closed'::text])))
CREATE INDEX subscription_successor_wait_cases_v2_candidates_idx ON public.subscription_successor_wait_cases_v2 USING btree (state, last_selected_at, id)
DEFAULT last_checked_at now()
DEFAULT notice_messages '{}'::jsonb
DEFAULT opened_at now()
DEFAULT refusal_observations '[]'::jsonb
FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE RESTRICT
FOREIGN KEY (cycle_id) REFERENCES public.subscription_cycles(id) ON DELETE RESTRICT
FOREIGN KEY (fulfillment_id) REFERENCES public.fulfillment_shipments(id) ON DELETE RESTRICT
FOREIGN KEY (operation_id) REFERENCES public.subscription_successor_operations_v2(id) ON DELETE RESTRICT
FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE RESTRICT
FOREIGN KEY (root_case_id) REFERENCES public.subscription_stock_wait_cases(id) ON DELETE RESTRICT
FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE RESTRICT
FOREIGN KEY (superseded_by_proposal_id) REFERENCES public.subscription_successor_proposals(id) ON DELETE RESTRICT
NOT NULL client_id
NOT NULL cycle_number
NOT NULL cycle_snapshot
NOT NULL deficits
NOT NULL due_snapshot
NOT NULL fingerprint
NOT NULL id
NOT NULL identity_key
NOT NULL last_checked_at
NOT NULL notice_messages
NOT NULL opened_at
NOT NULL operation_id
NOT NULL refusal_observations
NOT NULL root_case_id
NOT NULL scheduled_at
NOT NULL state
NOT NULL subscription_id
PRIMARY KEY (id)
ROW LEVEL SECURITY
TABLE
UNIQUE (operation_id)

subscription_successor_reservations_v2
CHECK (((length(btrim(source_key)) >= 1) AND (length(btrim(source_key)) <= 120)))
CHECK (((length(operation_fingerprint) = 64) AND (translate(operation_fingerprint, 'abcdef0123456789'::text, ''::text) = ''::text)))
CHECK ((jsonb_typeof(lines) = 'array'::text))
CHECK ((status = ANY (ARRAY['held'::text, 'committed'::text, 'consumed'::text, 'released'::text, 'expired'::text])))
CREATE INDEX subscription_successor_reservations_v2_stock_idx ON public.subscription_successor_reservations_v2 USING btree (source_key, status, expires_at)
DEFAULT created_at now()
DEFAULT updated_at now()
FOREIGN KEY (operation_id) REFERENCES public.subscription_successor_operations_v2(id) ON DELETE RESTRICT
NOT NULL created_at
NOT NULL id
NOT NULL lines
NOT NULL operation_fingerprint
NOT NULL operation_id
NOT NULL source_key
NOT NULL status
NOT NULL updated_at
PRIMARY KEY (id)
ROW LEVEL SECURITY
TABLE
UNIQUE (operation_id)`);
});

async function legacy() {
  const client = randomUUID(), subscription = randomUUID(), operation = randomUUID(), caseId = randomUUID();
  const instant = (await db.query("SELECT now()-interval '1 day' AS at")).rows[0].at;
  const fingerprint = createHash("sha256").update(operation).digest("hex");
  await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)", [subscription, client, instant]);
  await db.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,
    cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at) VALUES($1,$2,$3,1,public.subscription_renewal_identity($2,$3),$4,'{}',$1,'synthetic',now()-interval '2 days',now()-interval '1 day')`,
    [operation, subscription, instant, fingerprint]);
  await db.query(`INSERT INTO public.subscription_stock_wait_cases(id,subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,
    due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits) SELECT $1,$2,$3,id,scheduled_at,cycle_number,'waiting','{}',cycle_snapshot,operation_fingerprint,identity_key,'[]'
    FROM public.subscription_renewal_operations WHERE id=$4`, [caseId, subscription, client, operation]);
  return { client, subscription, operation, caseId };
}
it("lc10_D6_C1_old_arbiter", async () => {
  const f = await legacy();
  const row = (await db.query(`INSERT INTO public.subscription_renewal_operations(subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,
    cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at) SELECT subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,
    cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at FROM public.subscription_renewal_operations WHERE id=$1
    ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET updated_at=public.subscription_renewal_operations.updated_at RETURNING id`, [f.operation])).rows;
  expect(row).toEqual([{ id: f.operation }]);
  expect((await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='subscription_renewal_operations_cycle_key'")).rows)
    .toEqual([{ definition: "UNIQUE (subscription_id, scheduled_at)" }]);
});
it("lc10_D6_C2_old_wait_upsert", async () => {
  const f = await legacy();
  expect((await db.query(`INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits)
    SELECT subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits FROM public.subscription_stock_wait_cases WHERE id=$1
    ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET last_checked_at=public.subscription_stock_wait_cases.last_checked_at RETURNING id`, [f.caseId])).rows).toEqual([{ id: f.caseId }]);
});
it("lc10_D6_C3_direct_legacy_json", async () => {
  const f = await legacy();
  const result = (await db.query(`SELECT public.subscription_stock_wait_projection(c) AS actual,to_jsonb(c)-'due_snapshot'-'cycle_snapshot'-'notice_messages' AS expected FROM public.subscription_stock_wait_cases c WHERE id=$1`, [f.caseId])).rows[0];
  expect(result.actual).toEqual(result.expected);
  expect(Object.keys(result.actual)).toHaveLength(21);
  expect((await db.query("SELECT public.subscription_stock_wait_projection(NULL::public.subscription_stock_wait_cases) AS result")).rows).toEqual([{ result: null }]);
  const populated=(await db.query(`WITH value AS (SELECT jsonb_populate_record(NULL::public.subscription_stock_wait_cases,to_jsonb(c)||jsonb_build_object(
    'cycle_id',gen_random_uuid(),'order_id',gen_random_uuid(),'fulfillment_id',gen_random_uuid(),'state','synthetic-composite',
    'resumed_at',now(),'stock_secured_at',now(),'closed_at',now(),'last_selected_at',now(),'block_reason','synthetic',
    'notice_messages',jsonb_build_object('excluded',true))) AS row FROM public.subscription_stock_wait_cases c WHERE id=$1)
    SELECT public.subscription_stock_wait_projection(row) AS actual,to_jsonb(row)-'due_snapshot'-'cycle_snapshot'-'notice_messages' AS expected FROM value`,[f.caseId])).rows[0];
  expect(populated.actual).toEqual(populated.expected);
});
it("lc10_D6_C4_direct_legacy_read", async () => {
  const f = await legacy();
  const result = (await db.query(`SELECT public.subscription_stock_wait_read(c.id) AS actual,(to_jsonb(c)-'due_snapshot'-'cycle_snapshot'-'notice_messages')||jsonb_build_object('waitingNoticeRelevant',true) AS expected FROM public.subscription_stock_wait_cases c WHERE id=$1`, [f.caseId])).rows[0];
  expect(result.actual).toEqual(result.expected);
  expect((await db.query("SELECT public.subscription_stock_wait_read($1) AS result", [randomUUID()])).rows).toEqual([{ result: null }]);
  expect((await db.query("SELECT public.subscription_stock_wait_read_v2($1,'legacy') AS result", [f.caseId])).rows[0].result).toEqual({ schemaVersion: 2, caseKind: "legacy", case: result.expected });
});

it.each([
  {name:"lc10_N1_admit_late_opened_fact",creator:"admit" as const,recoveryStock:0,signature:"public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz)"},
  {name:"lc10_N1_recover_full_stock_opened_fact",creator:"recover" as const,recoveryStock:100,signature:"public.subscription_stock_wait_recover_refusal(uuid,text,text,timestamptz)"},
])("$name",async({creator,recoveryStock,signature})=>{
  const observer=await pool.connect(),pause=await gate(observer),oPid=await pid(observer);
  const before=(await pool.query("SELECT id FROM public.outbox_events WHERE event_type='catalog.publication.committed'")).rows.map(row=>row.id);
  const notices=createPostgresSuccessorNotices({withTransaction:transaction,impact:createPostgresCatalogWithdrawalImpact(pool),recipient:async()=>null,delivery:{enqueue:async()=>{throw Error("source_must_only_handoff");}}});
  const boundary=creator==="admit"?"PERFORM public.subscription_stock_wait_enqueue(c,'started');":`UPDATE public.subscription_stock_wait_cases SET refusal_observations=refusal_observations||
   COALESCE((SELECT jsonb_agg(to_jsonb(observation) ORDER BY occurred_at,id) FROM public.subscription_renewal_outcomes observation WHERE renewal_operation_id=op.id),'[]'::jsonb)
   WHERE id=c.id;`;
  const restore=await hook(signature,boundary,pause.sql);
  const creating=tracked(createSuccessorJourney(pool,{creator,recoveryStock}));
  try {
    await expect.poll(async()=>(await observer.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE '%subscription_stock_wait_%'",[oPid])).rows[0].count).toBe(1);
    const withdrawal=(await pool.query(`SELECT to_jsonb(e) AS event FROM public.outbox_events e JOIN public.catalog_publications p ON p.id=(e.payload#>>'{head,publicationId}')::uuid
      WHERE e.event_type='catalog.publication.committed' AND e.id<>ALL($1::uuid[]) AND p.canonical_state::jsonb#>>'{product,lifecycleState}'='withdrawn'`,[before])).rows;
    expect(withdrawal).toHaveLength(1);
    const published=withdrawal[0].event as OutboxEventRow;
    const outbox=createPostgresOutboxStore(pool),config=readOutboxDispatchConfig({});
    const known=[...successorNoticeSources];
    let emptyScanAcknowledged=false;
    const count=Number((await pool.query("SELECT count(*) AS count FROM public.outbox_events WHERE event_type='catalog.publication.committed'")).rows[0].count);
    for(let batch=0;batch<count&&!emptyScanAcknowledged;batch++) {
      const claimed=await outbox.claimBatch({eventTypes:[published.event_type],knownEventTypes:known,batchSize:config.batchSize,visibilitySeconds:config.visibilitySeconds,maxAttempts:config.maxAttempts});
      for(const source of claimed) {
        expect(await notices.handle(source)).toEqual({kind:"processed"});
        expect(await outbox.markProcessed({eventId:source.id,claimToken:String(source.metadata.claimToken)})).toEqual({applied:true});
        if(source.id===published.id)emptyScanAcknowledged=true;
      }
    }
    expect(emptyScanAcknowledged).toBe(true);
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.outbox_events WHERE event_type='subscription.predecessor_withdrawn.v2' AND payload->>'withdrawalPublicationId'=$1",[published.payload.head && (published.payload.head as {publicationId:string}).publicationId])).rows).toEqual([{count:0}]);
    await pause.release();const created=await creating;if(!created.ok)throw created.error;
    const f=created.value;
    const openings=await outbox.claimBatch({eventTypes:["subscription_stock_wait.opened.v1"],knownEventTypes:known,batchSize:config.batchSize,visibilitySeconds:config.visibilitySeconds,maxAttempts:config.maxAttempts});
    const opening=openings.find(row=>row.aggregate_id===f.caseId);expect(opening).toBeDefined();
    expect(await notices.handle(opening!)).toEqual({kind:"processed"});
    expect(await outbox.markProcessed({eventId:opening!.id,claimToken:String(opening!.metadata.claimToken)})).toEqual({applied:true});
    const handoff=await sourceEvent("subscription.predecessor_withdrawn.v2",f.subscription);
    expect(handoff.payload).toMatchObject({reason:"predecessor_withdrawn",caseId:f.caseId,operationId:f.operationId});
    expect((await pool.query("SELECT status FROM public.outbox_events WHERE id=$1",[published.id])).rows).toEqual([{status:"processed"}]);
  } finally {await pause.release();await creating;await restore();observer.release();}
});

it("stock_wait_successor_resolution_supersedes_atomically", async () => {
  const f=await createSuccessorJourney(pool);
  const before=(await db.query("SELECT to_jsonb(op) AS row FROM public.subscription_renewal_operations op WHERE id=$1",[f.operationId])).rows[0].row;
  const result=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  expect(result).toMatchObject({ schemaVersion: 2,status: "applied",proposalId: f.proposalId,rootOperationId: f.operationId,caseKind: "successor",cycleNumber: 1 });
  expect((await db.query("SELECT to_jsonb(op) AS row FROM public.subscription_renewal_operations op WHERE id=$1",[f.operationId])).rows[0].row).toEqual(before);
  expect((await db.query("SELECT state,block_reason FROM public.subscription_stock_wait_cases WHERE id=$1",[f.caseId])).rows).toEqual([{ state: "closed",block_reason: "superseded_by_successor" }]);
  expect((await db.query("SELECT variant_id,quantity,unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{ variant_id: f.successor.sku,quantity: 1,unit_price_minor: "777" }]);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2",[f.subscription,f.anchor])).rows).toEqual([{ count: 0 }]);
});

function successorEditor(f:Awaited<ReturnType<typeof createSuccessorJourney>>) {
  const money=(amountMinor:number)=>({amountMinor,currency:"XXX"});
  const options:Parameters<typeof createPostgresPackageEditor>[0]={withTransaction:transaction,now:()=>f.at,limits:{maximumPlanDays:45,maximumBaseLines:3,maximumAddonLines:5,maximumQuantity:50},
    quoteCatalogReadPort:{listQuoteCatalogItems:async()=>[{variantId:f.successor.sku,skuCode:f.successor.code,sellability:{subscription:true}}]},
    quotePort:{createServerAuthoritativeQuote:async input=>{
      const lines=input.lines.map(line=>({sku:line.sku,quantity:line.quantity,unitPriceGross:money(777),lineSubtotalGross:money(777*line.quantity)}));
      const total=money(lines.reduce((sum,line)=>sum+line.lineSubtotalGross.amountMinor,0));return {quote:{lines,totalGross:total,subtotalGross:total,discountTotalGross:money(0)}};
    }},compositionRulesPort:{validateComposition:async()=>({ok:true}),resizeComposition:async()=>null},
    constraintMapper:{toCore:stored=>({kind:"synthetic",version:1,data:stored??{}}),fromCore:value=>value.data,nominalPlanDays:()=>28}};
  return {options,editor:createPostgresPackageEditor(options)};
}

it.each([
  {name:"lc10_absent_quote_adapter_refuses",mode:"absent"},
  {name:"lc10_line_quote_adapter_null_refuses",mode:"line"},
  {name:"lc10_basket_quote_adapter_null_refuses",mode:"basket"},
])("$name",async({mode})=>{
  const f=await createSuccessorJourney(pool),{options,editor}=successorEditor(f),before=await state();
  if(mode==="absent")options.quotePort=undefined as never;
  else options.quotePort={createServerAuthoritativeQuote:async()=>null as never};
  const request=mode==="line"?{subscriptionId:f.subscription,action:"swap_base_line" as const,fromVariantId:f.predecessor.sku,toVariantId:f.successor.sku,expectedTemplateVersion:1}
    :{subscriptionId:f.subscription,planDays:28,base:[{variantId:f.successor.sku,qty:1}],addons:[],expectedTemplateVersion:1};
  await expect(editor.previewStockWaitSuccessor({actorId:f.principal,clientId:f.client},request,{caseId:f.caseId,caseKind:"legacy"})).rejects.toThrow("subscription_preview_reprice_unavailable");
  expect(await state()).toEqual(before);
});

it.each([
  {name:"lc10_late_wait_uses_native_quote_consent_and_acceptance",stale:false},
  {name:"lc10_resolution_stock_stale_is_atomic",stale:true},
])("$name",async({stale})=>{
  const created=await createSuccessorJourney(pool);
  const at=stale?(await pool.query("SELECT stale_after+interval '1 second' AS at FROM public.fulfillment_stock_current WHERE source_key=$1 AND sku=$2",[created.source,created.successor.code])).rows[0].at.toISOString():created.at;
  const f={...created,at},actor={actorId:f.principal,clientId:f.client};
  const money=(amountMinor:number)=>({amountMinor,currency:"XXX"});
  const {editor}=successorEditor(f);
  const request={subscriptionId:f.subscription,planDays:28,base:[{variantId:f.successor.sku,qty:1}],addons:[],expectedTemplateVersion:1};
  expect((await editor.preview(actor,request)).preview).toMatchObject({canApply:false,blockedReason:"edit_window_closed"});
  const quoted=await editor.previewStockWaitSuccessor(actor,request,{caseId:f.caseId,caseKind:"legacy"});
  expect(quoted).toMatchObject({preview:{canApply:true,blockedReason:null},previewId:expect.any(String),currentTotal:money(617),newTotal:money(777),delta:money(160)});
  const admission=f.offer.applyPayload.catalogAdmission;
  const store=createPostgresSuccessorStore({withTransaction:transaction,codec:f.codec,editLimits:successorEditLimits,previews:{prepare:async(connection,input)=>{
    // The existing server binding supplies catalogue authority and the native codec;
    // prices, baseline, consent and quote identity come from the actual preview owner.
    const row=(await connection.query("UPDATE public.subscription_quote_previews SET quote_snapshot=quote_snapshot||jsonb_build_object('catalogAdmission',$2::jsonb) WHERE id=$1::uuid RETURNING *",[input.previewId,admission])).rows[0];
    return {applyPayload:{...(row.request_payload as Record<string,unknown>),request:row.request_payload,...(row.quote_snapshot as Record<string,unknown>),...(row.totals as Record<string,unknown>)},cycleSnapshot:f.codec.decode(f.offer.cycleSnapshot)};
  }}});
  const offered=await store.offer(actor,{proposalId:randomUUID(),subscriptionId:f.subscription,predecessorSkuId:f.predecessor.sku,successorSkuId:f.successor.sku,publicationId:f.successor.declared.publicationId,previewId:quoted.previewId!,lane:"classic",action:"update_package_template",sourceBinding:{kind:"stock_wait",caseId:f.caseId,caseKind:"legacy"},now:f.at});
  expect((await pool.query("SELECT variant_id,unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{variant_id:f.predecessor.sku,unit_price_minor:"617"}]);
  const resolve=()=>store.resolve(actor,{caseId:f.caseId,proposalId:String(offered.id),acceptedQuoteHash:String(offered.quote_hash),commandKey:randomUUID(),now:f.at});
  if(stale){
    const before=await state();await expect(resolve()).rejects.toMatchObject({code:"22023",message:"stock_wait_stock_stale"});expect(await state()).toEqual(before);return;
  }
  const resolved=await resolve();
  expect(resolved).toMatchObject({status:"applied",rootOperationId:f.operationId});
  expect((await pool.query("SELECT variant_id,unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{variant_id:f.successor.sku,unit_price_minor:"777"}]);
});

it.each(["missing","stale"] as const)("lc10_direct_deficits_%s_provider_fact",async mode=>{
  const f=await createSuccessorJourney(pool);
  const at=mode==="stale"?(await pool.query("SELECT stale_after+interval '1 second' AS at FROM public.fulfillment_stock_current WHERE source_key=$1 AND sku=$2",[f.source,f.predecessor.code])).rows[0].at.toISOString():f.at;
  if(mode==="missing")await pool.query("DELETE FROM public.fulfillment_stock_current WHERE source_key=$1 AND sku=$2",[f.source,f.predecessor.code]);
  const before=await state();
  await expect(transaction(db=>db.query("SELECT public.subscription_stock_wait_deficits($1::jsonb,$2::uuid,$3::timestamptz)",[f.wire,f.operationId,at]))).rejects.toMatchObject({code:"P0001",message:`stock_wait_stock_${mode}`});
  expect(await state()).toEqual(before);
});

it("lc10_resolution_stock_missing_is_atomic",async()=>{
  const f=await createSuccessorJourney(pool);
  await pool.query("DELETE FROM public.fulfillment_stock_current WHERE source_key=$1 AND sku=$2",[f.source,f.successor.code]);
  const before=await state();
  await expect(transaction(db=>db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]))).rejects.toMatchObject({code:"22023",message:"stock_wait_stock_missing"});
  expect(await state()).toEqual(before);
});

it.each(["snapshot", "identity", "missing", "recovery_binding"] as const)("lc10_stock_wait_admit_refuses_%s", async mismatch => {
  const f = await createSuccessorJourney(pool);
  const fingerprint = f.codec.fingerprint(f.frozen), identityKey = f.codec.identity(f.frozen);
  const input = { operationId: f.operationId, claimToken: f.claimToken, snapshot: f.wire,
    operationFingerprint: fingerprint, identityKey, worker: "fixture" };
  const due = mismatch === "recovery_binding" ? { stockWaitRecovery: { caseId: randomUUID() } } : {};
  if (mismatch === "snapshot") input.snapshot = { ...f.wire, cycleNumber: f.header.next_cycle_number + 1 };
  if (mismatch === "identity") input.identityKey = `${identityKey}:wrong`;
  if (mismatch === "missing") {
    await db.query("UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '1 day' WHERE id=$1", [f.subscription]);
    expect((await db.query("SELECT public.subscription_stock_wait_frozen($1,$2) AS result", [f.subscription, f.anchor])).rows)
      .toEqual([{ result: null }]);
  }
  // Omit all three compared fields when the authoritative frozen read is NULL.
  const missing = { operationId: input.operationId, claimToken: input.claimToken, worker: input.worker };
  await expect(db.query("SELECT public.subscription_stock_wait_admit($1::jsonb,$2::jsonb,$3::timestamptz)",
    [mismatch === "missing" ? missing : input, due, f.at]))
    .rejects.toMatchObject({ code: "23505", message: "stock_wait_frozen_binding_changed" });
});

it("lc10_stock_wait_admit_guard_refuses_contention", async () => {
  const f = await createSuccessorJourney(pool);
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(846832106,1)");
    const input = { operationId: f.operationId, claimToken: f.claimToken, snapshot: { ...f.wire, cycleNumber: 0 },
      operationFingerprint: f.codec.fingerprint(f.frozen), identityKey: f.codec.identity(f.frozen), worker: "fixture" };
    await expect(db.query("SELECT public.subscription_stock_wait_admit($1::jsonb,'{}',$2::timestamptz)", [input, f.at]))
      .rejects.toMatchObject({ code: "55P03", message: "inventory_admission_busy", where: expect.stringContaining("subscription_stock_wait_admit") });
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
});

it("lc10_stock_wait_admit_full_stock_does_not_open_wait", async () => {
  const f = await createSuccessorJourney(pool, { ordinary: true });
  const stock = createPostgresFulfillmentStockSyncPort(db, { sourceKey: f.source, readLocalInventoryStock: async () => [] });
  const until = (await db.query("SELECT $1::timestamptz+interval '1 day' AS at", [f.anchor])).rows[0].at.toISOString();
  await stock.recordProviderStockCurrent({ requestKey: `admit:${f.subscription}`, snapshot: {
    providerRef: "synthetic", collectedAt: f.anchor, sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot",
    skuRef: f.predecessor.code, totalQuantity: 100, forSaleQuantity: 100, reservedOrUnavailableQuantity: 0, syncRunId: f.subscription,
  }, inventoryClass: "sellable", lastSyncedAt: f.anchor, staleAfter: until });
  const identityKey = f.codec.identity(f.frozen), operationFingerprint = f.codec.fingerprint(f.frozen);
  const op = (await db.query("SELECT public.subscription_claim_due_renewal($1,$2,$3,'fixture',300,$4) AS result",
    [identityKey, operationFingerprint, f.wire, f.anchor])).rows[0].result;
  const input = { operationId: op.operationId, claimToken: op.claimToken, snapshot: f.wire, operationFingerprint, identityKey, worker: "fixture" };
  const admit = async () => (await db.query("SELECT public.subscription_stock_wait_admit($1::jsonb,'{}',$2::timestamptz) AS result",
    [input, f.anchor])).rows[0].result;
  expect(await admit()).toMatchObject({ waiting: false, reserved: true });
  expect(await admit()).toMatchObject({ reason: "stock_secured", state: "reserved", replayed: true });
  expect((await db.query("SELECT id FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=$1", [op.operationId])).rows)
    .toEqual([]);
});

it.each(["same_lines", "changed_quantity"] as const)("lc10_stock_wait_rehold_%s", async variant => {
  const f = await createSuccessorJourney(pool, { creator: "recover", recoveryStock: 100 });
  const held = (await db.query(`SELECT r.id,to_char((greatest(r.expires_at,op.lease_expires_at)+interval '1 second')
      AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM public.fulfillment_inventory_reservations r JOIN public.subscription_renewal_operations op ON op.id=r.renewal_operation_id
    WHERE op.id=$1`, [f.operationId])).rows[0];
  const lines = () => db.query("SELECT sku,quantity FROM public.fulfillment_inventory_reservation_lines WHERE reservation_id=$1", [held.id]);
  const recover = () => db.query("SELECT public.subscription_stock_wait_recover_refusal($1,$2,'fixture',$3) AS result",
    [f.operationId, f.codec.fingerprint(f.frozen), held.at]);
  const before = (await lines()).rows;
  expect(before).toEqual([{ sku: f.predecessor.code, quantity: 1 }]);
  if (variant === "changed_quantity") {
    await db.query("UPDATE public.fulfillment_inventory_reservation_lines SET quantity=2 WHERE reservation_id=$1", [held.id]);
    await expect(recover()).rejects.toMatchObject({ code: "P0001", message: "stock_wait_reservation_snapshot_mismatch" });
  } else {
    expect((await recover()).rows[0].result).toMatchObject({ waiting: false, caseId: f.caseId, reason: "stock_secured" });
    expect((await db.query(`SELECT status,expires_at=$2::timestamptz+interval '15 minutes' AS renewed
      FROM public.fulfillment_inventory_reservations WHERE id=$1`, [held.id, held.at])).rows).toEqual([{ status: "held", renewed: true }]);
    expect((await lines()).rows).toEqual(before);
  }
});

it.each(["shortage", "unrelated_check"] as const)("lc10_stock_wait_recovery_%s_is_atomic", async failure => {
  const f = await createSuccessorJourney(pool);
  const stock = createPostgresFulfillmentStockSyncPort(pool, { sourceKey: f.source, readLocalInventoryStock: async () => [] });
  const now = (await pool.query("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
  const until = (await pool.query("SELECT $1::timestamptz+interval '1 day' AS at", [now])).rows[0].at.toISOString();
  await stock.recordProviderStockCurrent({ requestKey: `recheck:${f.subscription}`, snapshot: {
    providerRef: "synthetic", collectedAt: now, sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot",
    skuRef: f.predecessor.code, totalQuantity: 100, forSaleQuantity: 100, reservedOrUnavailableQuantity: 0, syncRunId: f.subscription,
  }, inventoryClass: "sellable", lastSyncedAt: now, staleAfter: until });
  expect((await pool.query("SELECT public.subscription_stock_wait_deficits($1::jsonb,$2,$3) AS result", [f.wire, f.operationId, now])).rows)
    .toEqual([{ result: [] }]);
  const readOperation = () => pool.query("SELECT to_jsonb(op) AS row FROM public.subscription_renewal_operations op WHERE id=$1", [f.operationId]);
  const readOutcomes = () => pool.query("SELECT to_jsonb(o) AS row FROM public.subscription_renewal_outcomes o WHERE renewal_operation_id=$1", [f.operationId]);
  const before = await readOperation(), outcomes = await readOutcomes();
  const seam = "public.fulfillment_reserve_subscription_renewal(uuid,uuid,integer,timestamptz)";
  const restore = await hook(seam, "  v_available integer;\nBEGIN\n", failure === "shortage"
    ? " RETURN jsonb_build_object('reserved',false);\n"
    : " RAISE EXCEPTION 'fixture_unrelated_check' USING ERRCODE='23514';\n");
  try {
    const recover = pool.query("SELECT public.subscription_stock_wait_recover_refusal($1,$2,'fixture',$3) AS result",
      [f.operationId, f.codec.fingerprint(f.frozen), now]);
    if (failure === "shortage") {
      expect((await recover).rows).toEqual([{ result: { waiting: true, caseId: f.caseId } }]);
    } else {
      await expect(recover).rejects.toMatchObject({ code: "23514", message: "fixture_unrelated_check" });
    }
    expect((await readOperation()).rows).toEqual(before.rows);
    expect((await readOutcomes()).rows).toEqual(outcomes.rows);
    expect((await pool.query("SELECT id FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1", [f.operationId])).rows)
      .toEqual([]);
  } finally {
    await restore();
  }
});

it("lc10_D6_successor_paid_fact_direct_trigger", async () => {
  const f=await createSuccessorJourney(pool);
  const resolved=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const generation=(await db.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1",[resolved.operationId])).rows[0];
  const prepared=(await db.query("SELECT public.commerce_prepare_successor_renewal_v2($1,$2,$3) AS result",[generation.id,generation.claim_token,f.at])).rows[0].result;
  expect(prepared).toMatchObject({ schemaVersion: 2,operationKind: "successor",state: "attempt_prepared",replayed: false });
  const eventKey=randomUUID();
  const evidence={ operationFingerprint: generation.operation_fingerprint,outcome: "succeeded",externalRef: `synthetic:${eventKey}` };
  const settled=(await db.query("SELECT public.commerce_settle_successor_renewal_v2($1,$2,$3,$4) AS result",[generation.id,eventKey,evidence,f.at])).rows[0].result;
  expect(settled).toMatchObject({ operation: { state: "succeeded" } });
  const source=(await db.query("SELECT metadata->'commercePaidFactV1' AS fact FROM public.outbox_events WHERE event_type='commerce.order.paid' AND aggregate_id=$1",[prepared.orderId])).rows[0];
  expect(source.fact).toMatchObject({ state: "complete",event: { sourceType: "order.paid",subject: { clientId: f.client },data: { purchaseKind: "renewal",orderId: prepared.orderId,currency: "XXX" } } });
  expect((await db.query("SELECT public.commerce_settle_successor_renewal_v2($1,$2,$3,$4) AS result",[generation.id,eventKey,evidence,f.at])).rows[0].result).toEqual(settled);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2",[f.subscription,f.anchor])).rows).toEqual([{ count: 1 }]);
  expect((await db.query("SELECT next_cycle_at>=$2::timestamptz+interval '28 days' AS extended FROM public.subscriptions WHERE id=$1",[f.subscription,f.anchor])).rows).toEqual([{ extended: true }]);
});

it.each([{ branch:"shortage",stock:0 },{ branch:"full_stock",stock:100 }])("lc10_D6_C6_persisted_due_snapshot",async ({stock})=>{
  const f=await createSuccessorJourney(pool,{ creator:"recover",recoveryStock:stock });
  expect((await db.query("SELECT due_snapshot FROM public.subscription_stock_wait_cases WHERE id=$1",[f.caseId])).rows[0].due_snapshot).toEqual(f.preRecovery);
  const opened=(await db.query("SELECT payload,idempotency_key FROM public.outbox_events WHERE event_type='subscription_stock_wait.opened.v1' AND aggregate_id=$1",[f.caseId])).rows;
  expect(opened).toHaveLength(1);
  expect(opened[0].payload).toMatchObject({ caseId:f.caseId,operationId:f.operationId,subscriptionId:f.subscription,clientId:f.client,identityKey:f.codec.identity(f.frozen),frozenFingerprint:f.codec.fingerprint(f.frozen) });
  expect(opened[0].idempotency_key).toBe(`subscription_stock_wait:${f.caseId}:opened:v1`);
  expect(Object.keys(opened[0].payload).sort()).toEqual(["caseId","clientId","frozenFingerprint","identityKey","operationId","scheduledAt","subscriptionId"].sort());
});

it.each([["null", null], ["array", []], ["string", "invalid"], ["number", 5]] as const)(
  "lc10_read_admit_rejects_nonobject_due_%s", async (_kind, due) => {
  const f = await createSuccessorJourney(pool);
  const resolved = (await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result;
  const g = (await db.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1", [resolved.operationId])).rows[0];
  const input = { operationId: g.id, operationFingerprint: g.operation_fingerprint, identityKey: g.identity_key,
    snapshot: g.cycle_snapshot, claimToken: g.claim_token, worker: "synthetic" };
  await db.query("SAVEPOINT malformed_due");
  await expect(db.query("SELECT public.subscription_stock_wait_admit_v2($1,$2::jsonb,$3)", [input, JSON.stringify(due), f.at]))
    .rejects.toMatchObject({ code: "23505", message: "stock_wait_frozen_binding_changed" });
  await db.query("ROLLBACK TO SAVEPOINT malformed_due");
  expect((await db.query("SELECT public.subscription_stock_wait_admit_v2($1,'{}'::jsonb,$2) AS result", [input, f.at])).rows[0].result)
    .toMatchObject({ waiting: false });
});

it.each((["admit", "recover"] as const).flatMap(path =>
  ["fresh_shortage", "secured", "check_failure"].map(observation => [path, observation] as const),
))("lc10_short_existing_wait_%s_%s", async (path, observation) => {
  const f = await createSuccessorJourney(pool);
  if (path === "admit") await db.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=0 WHERE source_key=$1 AND sku=$2",
    [f.source, f.successor.code]);
  const resolved = (await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result;
  const at = path === "recover" ? (await db.query(`SELECT (expires_at+interval '1 second')::text AS as_of
    FROM public.subscription_successor_reservations_v2 WHERE operation_id=$1`, [resolved.operationId])).rows[0].as_of
    : (await db.query("SELECT ($1::timestamptz+interval '2 seconds')::text AS as_of", [f.at])).rows[0].as_of;
  if (path === "recover") await db.query("SELECT public.fulfillment_expire_successor_renewals_v2(1000,$1)", [at]);
  else await db.query(`UPDATE public.subscription_successor_operations_v2
    SET state='claimed',terminal_outcome=NULL,terminal_reason=NULL,terminal_at=NULL WHERE id=$1`, [resolved.operationId]);
  const read = async (table: "wait_cases" | "reservations" | "operations") =>
    (await db.query(`SELECT to_jsonb(r) AS row FROM public.subscription_successor_${table}_v2 r
      WHERE r.${table === "operations" ? "id" : "operation_id"}=$1`, [resolved.operationId])).rows[0]?.row;
  const prior = await read("wait_cases");
  await db.query("UPDATE public.subscription_successor_wait_cases_v2 SET block_reason='previous_check' WHERE id=$1", [prior.id]);
  if (observation === "fresh_shortage") await db.query(`UPDATE public.fulfillment_stock_current
    SET for_sale_quantity=0 WHERE source_key=$1 AND sku=$2`, [f.source, f.successor.code]);
  if (observation === "secured") await db.query(`UPDATE public.fulfillment_stock_current
    SET for_sale_quantity=100 WHERE source_key=$1 AND sku=$2`, [f.source, f.successor.code]);
  if (observation === "check_failure") await db.query(`UPDATE public.fulfillment_stock_current
    SET stale_after=last_synced_at+interval '1 second' WHERE source_key=$1 AND sku=$2`, [f.source, f.successor.code]);
  const beforeHold = await read("reservations"), g = await read("operations");
  const result = path === "recover"
    ? (await db.query("SELECT public.subscription_stock_wait_recover_refusal_v2($1,$2,'synthetic',$3) AS result",
      [g.id, g.operation_fingerprint, at])).rows[0].result
    : (await db.query("SELECT public.subscription_stock_wait_admit_v2($1,'{}'::jsonb,$2) AS result", [{
      operationId: g.id, operationFingerprint: g.operation_fingerprint, identityKey: g.identity_key,
      snapshot: g.cycle_snapshot, claimToken: g.claim_token, worker: "synthetic",
    }, at])).rows[0].result;
  const after = await read("wait_cases");
  expect(after).toMatchObject({ id: prior.id, stock_secured_at: path === "admit" && observation === "secured"
    ? expect.any(String) : prior.stock_secured_at });
  expect(Date.parse(after.last_checked_at)).toBe(Date.parse(at));
  if (observation === "check_failure") {
    expect(result).toEqual({ error: "stock_wait_check_failed", caseId: prior.id });
    expect(after).toMatchObject({ block_reason: "stock_wait_check_failed", state: prior.state, deficits: prior.deficits });
    expect(await read("reservations")).toEqual(beforeHold);
    expect(await read("operations")).toEqual(g);
  } else {
    const waiting = observation === "fresh_shortage";
    expect(result).toMatchObject(path === "admit" && !waiting ? { waiting } : { caseId: prior.id, waiting });
    expect(after).toMatchObject({ state: waiting ? "waiting" : "stock_secured", block_reason: null,
      deficits: waiting ? [{ sku: f.successor.code, requiredUnits: 1, reservedUnits: 0, availableUnits: 0, missingUnits: 1 }] : [] });
    if (waiting) expect(await read("reservations")).toEqual(beforeHold);
  }
});

it.each(["confirmed", "unconfirmed"] as const)("lc10_short_late_reservation_shortage_%s", async observation => {
  const f = await createSuccessorJourney(pool);
  const resolved = await transaction(async connection => {
    await connection.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=0 WHERE source_key=$1 AND sku=$2",
      [f.source, f.successor.code]);
    return (await connection.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
      [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result;
  });
  const signature = "public.subscription_stock_wait_recover_refusal_v2(uuid,text,text,timestamptz)";
  const restoreReserve = await hook(signature, "     result:=public.fulfillment_reserve_successor_renewal_v2(g.id,token,900,p_now);",
    " result:=jsonb_build_object('reserved',false,'reason','inventory_unavailable');");
  const restoreObservation = observation === "confirmed" ? await hook(signature,
    "    available:=CASE WHEN stock.inventory_class='sellable' THEN (public.inventory_available_to_promise(stock.source_key,stock.sku,p_now,true)->>'available_quantity')::bigint ELSE 0 END;",
    " IF shortage_after_reserve THEN available:=0; END IF;") : null;
  try {
    await db.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=100 WHERE source_key=$1 AND sku=$2",
      [f.source, f.successor.code]);
    const operation = async () => (await db.query("SELECT to_jsonb(g) AS row FROM public.subscription_successor_operations_v2 g WHERE id=$1",
      [resolved.operationId])).rows[0].row;
    const original = await operation();
    await db.query("UPDATE public.subscription_successor_wait_cases_v2 SET block_reason='previous_check' WHERE id=$1", [resolved.caseId]);
    const result = (await db.query("SELECT public.subscription_stock_wait_recover_refusal_v2($1,$2,'synthetic',$3::timestamptz+interval '1 second') AS result",
      [original.id, original.operation_fingerprint, original.lease_expires_at])).rows[0].result;
    const deficits = [{ sku: f.successor.code, requiredUnits: 1, reservedUnits: 0, availableUnits: 0, missingUnits: 1 }];
    expect(result).toMatchObject(observation === "confirmed" ? { waiting: true, caseId: resolved.caseId, deficits }
      : { error: "stock_wait_check_failed", caseId: resolved.caseId });
    expect((await db.query("SELECT state,deficits,block_reason,last_checked_at>opened_at AS observed FROM public.subscription_successor_wait_cases_v2 WHERE id=$1",
      [resolved.caseId])).rows).toEqual([{ state: "waiting", deficits, observed: true,
      block_reason: observation === "confirmed" ? null : "stock_wait_check_failed" }]);
    expect(await operation()).toEqual(original);
    expect((await db.query("SELECT id FROM public.subscription_successor_reservations_v2 WHERE operation_id=$1", [original.id])).rows).toEqual([]);
  } finally {
    await restoreObservation?.();
    await restoreReserve();
  }
});

it.each((["frozen", "admit", "reserve", "recover"] as const).flatMap(path =>
  ["exact", "missing_receipt", "changed_receipt_fingerprint", "competing_cycle", "different_client"].map(fact => [path, fact] as const),
))("lc10_bind_frozen_%s_%s", async (path, fact) => {
  const f = await createSuccessorJourney(pool);
  const resolved = (await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result;
  const g = (await db.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1", [resolved.operationId])).rows[0];
  if (fact === "missing_receipt") {
    const deleted = await db.query(`DELETE FROM public.subscription_command_receipts r
      USING public.subscription_successor_proposals p WHERE p.id=$1 AND p.accepted_receipt=r.result`, [f.proposalId]);
    expect(deleted.rowCount).toBe(1);
  }
  if (fact === "changed_receipt_fingerprint") {
    const changed = await db.query(`UPDATE public.subscription_command_receipts r SET command_fingerprint=$2
      FROM public.subscription_successor_proposals p WHERE p.id=$1 AND p.accepted_receipt=r.result`, [f.proposalId, "0".repeat(64)]);
    expect(changed.rowCount).toBe(1);
  }
  if (fact === "competing_cycle") {
    await db.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'planned')", [f.subscription, f.anchor]);
  }
  if (fact === "different_client") {
    const client = randomUUID();
    await db.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [client, `${client}@example.invalid`, randomUUID()]);
    await db.query("UPDATE public.subscriptions SET client_id=$2 WHERE id=$1", [f.subscription, client]);
  }
  const observe = async () => (await db.query(`SELECT
    (SELECT to_jsonb(g) FROM public.subscription_successor_operations_v2 g WHERE id=$1) AS operation,
    (SELECT to_jsonb(c) FROM public.subscription_successor_wait_cases_v2 c WHERE operation_id=$1) AS wait,
    (SELECT to_jsonb(r) FROM public.subscription_successor_reservations_v2 r WHERE operation_id=$1) AS hold,
    (SELECT count(*) FROM public.outbox_events WHERE aggregate_id=$2) AS events`, [g.id, resolved.caseId])).rows[0];
  const before = await observe();
  const response = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0].result;
  const invoke = {
    frozen: () => response("SELECT public.subscription_stock_wait_frozen_v2($1) AS result", [g.id]),
    admit: () => response("SELECT public.subscription_stock_wait_admit_v2($1,'{}'::jsonb,$2) AS result", [{
      operationId: g.id, operationFingerprint: g.operation_fingerprint, identityKey: g.identity_key,
      snapshot: g.cycle_snapshot, claimToken: g.claim_token, worker: "synthetic",
    }, f.at]),
    reserve: () => response("SELECT public.fulfillment_reserve_successor_renewal_v2($1,$2,900,$3) AS result", [g.id, g.claim_token, f.at]),
    recover: () => response("SELECT public.subscription_stock_wait_recover_refusal_v2($1,$2,'synthetic',$3) AS result", [g.id, g.operation_fingerprint, f.at]),
  }[path];
  if (fact === "exact") {
    expect(await invoke()).toMatchObject(path === "frozen" ? { operationId: g.id, caseId: resolved.caseId }
      : path === "reserve" ? { reserved: true, replayed: true } : { waiting: false, replayed: true });
  } else if (path === "frozen") {
    expect(await invoke()).toBeNull();
  } else {
    await db.query("SAVEPOINT changed_frozen");
    await expect(invoke()).rejects.toMatchObject(path === "admit"
      ? { code: "23505", message: "stock_wait_frozen_binding_changed" }
      : { code: "22023", message: "stock_wait_binding_changed" });
    await db.query("ROLLBACK TO SAVEPOINT changed_frozen");
  }
  expect(await observe()).toEqual(before);
});

it("lc10_bind_admission_rereads_closed_case_before_effects", async () => {
  const f = await createSuccessorJourney(pool);
  const resolved = (await pool.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result;
  const g = (await pool.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1", [resolved.operationId])).rows[0];
  const first = await pool.connect(), observer = await pool.connect(), pause = await gate(observer);
  const restore = await hook("public.subscription_stock_wait_admit_v2(jsonb,jsonb,timestamptz)",
    "SELECT * INTO hint FROM public.subscription_successor_operations_v2 WHERE id=(p_input->>'operationId')::uuid;", pause.sql);
  let running: ReturnType<typeof tracked> | undefined;
  try {
    await first.query("BEGIN");
    const firstPid = await pid(first), observerPid = await pid(observer);
    running = tracked(first.query("SELECT public.subscription_stock_wait_admit_v2($1,'{}'::jsonb,$2)", [{
      operationId: g.id, operationFingerprint: g.operation_fingerprint, identityKey: g.identity_key,
      snapshot: g.cycle_snapshot, claimToken: g.claim_token, worker: "synthetic",
    }, f.at]));
    await blocked(observer, firstPid, observerPid);
    await pool.query("UPDATE public.subscription_successor_wait_cases_v2 SET state='closed',closed_at=$2 WHERE id=$1",
      [resolved.caseId, f.at]);
    const before = await state();
    await pause.release();
    expect(await running).toMatchObject({ ok: false, error: { code: "23505", message: "stock_wait_frozen_binding_changed" } });
    await first.query("ROLLBACK");
    expect(await state()).toEqual(before);
  } finally {
    await pause.release();
    await running;
    await first.query("ROLLBACK");
    await restore();
    first.release();
    observer.release();
  }
});

it.each(["retained", "freshened"] as const)("lc10_bind_claim_retains_frozen_template_%s", async mode => {
  const f = await createSuccessorJourney(pool);
  const resolved = (await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result;
  const operation = (await db.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1",
    [resolved.operationId])).rows[0];
  await db.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
  const original = operation.cycle_snapshot;
  const snapshot = mode === "retained" ? original : {
    ...original, templateSnapshot: { ...original.templateSnapshot, version: original.templateSnapshot.version + 1 },
  };
  const claim = () => db.query(`SELECT public.subscription_claim_successor_renewal_v2($1,$2,$3,'fixture',300,
    $4::timestamptz+interval '1 second') AS result`, [operation.identity_key, operation.operation_fingerprint, snapshot, operation.lease_expires_at]);
  if (mode === "freshened") {
    await db.query("SAVEPOINT foreign_template");
    await expect(claim()).rejects.toMatchObject({ code: "23505", message: "subscription_renewal_claim_idempotency_conflict" });
    await db.query("ROLLBACK TO SAVEPOINT foreign_template");
  } else {
    expect((await claim()).rows[0].result).toMatchObject({ acquired: true, reason: "lease_taken_over",
      operation: { cycle_snapshot: original, claim_generation: Number(operation.claim_generation) + 1 } });
  }
  expect((await db.query("SELECT cycle_snapshot FROM public.subscription_successor_operations_v2 WHERE id=$1",
    [operation.id])).rows).toEqual([{ cycle_snapshot: original }]);
});

it("lc10_bind_selected_recovery_rejects_old_lease_generation",async()=>{
  const f=await createSuccessorJourney(pool);
  const resolved=(await pool.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const read=async()=>(await pool.query("SELECT public.subscription_stock_wait_frozen_v2($1) AS result",[resolved.operationId])).rows[0].result;
  const first=await read();
  const at=(await pool.query("SELECT to_char((lease_expires_at+interval '1 second') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at FROM public.subscription_successor_operations_v2 WHERE id=$1",
    [resolved.operationId])).rows[0].at;
  await pool.query("SELECT public.subscription_claim_successor_renewal_v2($1,$2,$3,'synthetic-worker',300,$4)",
    [first.identityKey,first.operationFingerprint,first.snapshot,at]);
  const current=await read(),before=await state();
  expect(current.binding.claimGeneration).toBe(first.binding.claimGeneration+1);
  const store=createPostgresSuccessorStore({withTransaction:transaction,codec:f.codec,
    previews:{prepare:async()=>{throw Error("recovery_must_not_quote");}}});
  const input={operationId:resolved.operationId,fingerprint:first.operationFingerprint,workerId:"synthetic-worker",now:at};
  await expect(store.recover({...input,selection:first.binding})).rejects
    .toMatchObject({code:"23505",message:"stock_wait_frozen_binding_changed"});
  expect(await state()).toEqual(before);
  expect(await store.recover({...input,selection:current.binding})).toMatchObject({waiting:false,replayed:true});
});

async function prepareLegacy() {
  const f=await createSuccessorJourney(pool,{ creator:"recover",recoveryStock:100 });
  const token=(await pool.query("SELECT claim_token FROM public.subscription_renewal_operations WHERE id=$1",[f.operationId])).rows[0].claim_token;
  const prepared=(await pool.query("SELECT public.commerce_prepare_subscription_renewal($1,$2,$3) AS result",[f.operationId,token,f.at])).rows[0].result;
  const external=`synthetic:${randomUUID()}`;
  await pool.query("SELECT public.commerce_acknowledge_subscription_renewal_attempt($1,$2,$3,$4)",[f.operationId,f.codec.fingerprint(f.frozen),external,f.at]);
  return { ...f,prepared,external };
}
const tracked=<T>(work:Promise<T>)=>work.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
async function hook(signature:string,boundary:string,insertion:string) {
  const before=(await pool.query("SELECT pg_get_functiondef(oid) AS ddl,prosrc FROM pg_proc WHERE oid=$1::regprocedure",[signature])).rows[0];
  expect(before.prosrc.split(boundary)).toHaveLength(2);
  await pool.query(before.ddl.replace(before.prosrc,()=>before.prosrc.replace(boundary,()=>boundary+insertion)));
  return ()=>pool.query(before.ddl);
}
async function gate(observer:PoolClient) {
  const key=BigInt(`0x${randomUUID().replaceAll("-","").slice(0,14)}`).toString();
  await observer.query("SELECT pg_advisory_lock($1::bigint)",[key]);
  return { sql:`DECLARE lc10_gate_lock_timeout text:=current_setting('lock_timeout'); BEGIN
    PERFORM set_config('lock_timeout','0',true); PERFORM pg_advisory_lock(${key}::bigint); PERFORM pg_advisory_unlock(${key}::bigint);
    PERFORM set_config('lock_timeout',lc10_gate_lock_timeout,true); END;`,release:()=>observer.query("SELECT pg_advisory_unlock($1::bigint)",[key]) };
}
const pid=async(connection:PoolClient)=>Number((await connection.query("SELECT pg_backend_pid() AS id")).rows[0].id);
async function blocked(observer:PoolClient,waiter:number,holder:number) {
  await expect.poll(async()=>(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[waiter,holder])).rows[0].blocked).toBe(true);
}
async function state() {
  const result:Record<string,unknown>={};
  for(const name of ["subscriptions","subscription_lines","subscription_renewal_terms","subscription_renewal_operations","subscription_renewal_outcomes","subscription_events","subscription_cycles","commerce_orders","commerce_order_items","commerce_settlement_intents","fulfillment_shipments","subscription_delivery_alignment_arrivals","subscription_stock_wait_cases","fulfillment_inventory_reservations","fulfillment_inventory_reservation_lines","subscription_quote_previews","subscription_successor_proposals","subscription_successor_operations_v2","subscription_successor_wait_cases_v2","subscription_successor_reservations_v2","subscription_command_receipts","outbox_events"])
    result[name]=(await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM public.${name} t`)).rows[0].rows;
  return result;
}

it.each([
  {name:"lc10_rollback_after_release",boundary:"WHERE operation_id=prior_generation.id AND status IN ('held','expired');"},
  {name:"lc10_rollback_after_template",boundary:" -- The chosen lane must realize the exact checked basket on the same transaction.\n"},
  {name:"lc10_rollback_after_freeze",boundary:"snapshot,'claimed',gen_random_uuid(),'successor_resolution',p_now,p_now+interval '5 minutes',p_now,p_now) RETURNING * INTO g;"},
  {name:"lc10_rollback_after_receipt",boundary:"VALUES(p_actor_id,p_command_key,s.id,s.client_id,command_fingerprint,command,p_accepted_quote_hash,answer,'applied');"},
  {name:"lc10_rollback_after_outbox",boundary:"VALUES('subscription',s.id,'subscription.successor.accepted.v2','subscription-successor:'||proposal.id::text||':accepted:v2',answer);"},
])("$name",async({boundary})=>{
  const f=await createSuccessorJourney(pool,{creator:"recover",recoveryStock:100}),before=await state();
  const at=(await pool.query("SELECT lease_expires_at+interval '1 second' AS at FROM public.subscription_renewal_operations WHERE id=$1",[f.operationId])).rows[0].at.toISOString();
  const restore=await hook("public.resolve_stock_wait_with_successor(uuid,uuid,text,text,uuid,timestamptz)",boundary," RAISE EXCEPTION 'synthetic_successor_rollback';");
  try {
    await expect(transaction(connection=>connection.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,at]))).rejects.toMatchObject({code:"P0001",message:"synthetic_successor_rollback"});
    expect(await state()).toEqual(before);
  } finally {await restore();}
});

it("lc10_admission_prelocks_match_immutable_preview",async()=>{
  const f=await createSuccessorJourney(pool),other=await createSuccessorJourney(pool),proposalId=randomUUID();
  const offer={...f.offer,proposalId,applyPayload:{...f.offer.applyPayload,catalogAdmission:other.offer.applyPayload.catalogAdmission}};
  const proposed=(await pool.query("SELECT public.subscription_successor_proposal_offer_v2($1,$2,$3,$4) AS result",[f.subscription,f.client,offer,f.at])).rows[0].result;
  const before=await state();
  await expect(transaction(connection=>connection.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,proposalId,proposed.quote_hash,randomUUID(),f.client,f.at]))).rejects.toMatchObject({code:"22023",message:"customer_self_service_invalid_catalog_anchor"});
  expect(await state()).toEqual(before);
});

it("lc10_decision_client_parent_busy_is_atomic",async()=>{
  const f=await createSuccessorJourney(pool),parent=await pool.connect(),writer=await pool.connect();
  let work:ReturnType<typeof tracked>|undefined;
  try {
    await parent.query("BEGIN");await parent.query("SELECT id FROM public.clients WHERE id=$1 FOR UPDATE",[f.client]);
    await writer.query("BEGIN");const parentPid=await pid(parent),writerPid=await pid(writer),before=await state();let done=false;
    work=tracked(writer.query("SELECT public.subscription_successor_proposal_decide_v2($1,$2,'declined',$3,NULL,$4)",[f.proposalId,f.client,randomUUID(),f.at])).then(value=>{done=true;return value;});
    await expect.poll(async()=>done||(await pool.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[writerPid,parentPid])).rows[0].blocked).toBe(true);
    const waited=(await pool.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[writerPid,parentPid])).rows[0].blocked;
    await parent.query("ROLLBACK");const outcome=await work;
    expect(waited).toBe(false);expect(outcome).toMatchObject({ok:false,error:{code:"55P03",message:"lc10_commerce_busy"}});
    expect(await state()).toEqual(before);
  } finally {await parent.query("ROLLBACK");await work;await writer.query("ROLLBACK");parent.release();writer.release();}
});

it("lc10_proposal_identity_conflict_never_waits_across_subscriptions",async()=>{
  const a=await createSuccessorJourney(pool),b=await createSuccessorJourney(pool),proposalId=randomUUID();
  const observer=await pool.connect(),first=await pool.connect(),second=await pool.connect(),pause=await gate(observer);
  const restore=await hook("public.subscription_successor_proposal_offer_v2(uuid,uuid,jsonb,timestamptz)","p_request,to_jsonb(q),hash,q.expires_at,original_case,root,p_now) RETURNING * INTO p;",pause.sql);
  const invoke=(connection:PoolClient,f:typeof a)=>connection.query("SELECT public.subscription_successor_proposal_offer_v2($1,$2,$3,$4) AS result",[f.subscription,f.client,{...f.offer,proposalId},f.at]);
  let creating:ReturnType<typeof tracked>|undefined,competing:ReturnType<typeof tracked>|undefined;
  try {
    await first.query("BEGIN");await second.query("BEGIN");const firstPid=await pid(first),secondPid=await pid(second),observerPid=await pid(observer);
    creating=tracked(invoke(first,a));await blocked(observer,firstPid,observerPid);
    const before=await state();let done=false;
    competing=tracked(invoke(second,b)).then(value=>{done=true;return value;});
    await expect.poll(async()=>done||(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[secondPid,firstPid])).rows[0].blocked).toBe(true);
    const waited=(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[secondPid,firstPid])).rows[0].blocked;
    if(waited){await pause.release();expect(await creating).toMatchObject({ok:true});await first.query("COMMIT");}
    expect(await competing).toMatchObject({ok:false,error:{code:"55P03",message:"lc10_commerce_busy"}});expect(waited).toBe(false);expect(await state()).toEqual(before);
    await second.query("ROLLBACK");await pause.release();expect(await creating).toMatchObject({ok:true});await first.query("COMMIT");
    expect((await pool.query("SELECT subscription_id FROM public.subscription_successor_proposals WHERE id=$1",[proposalId])).rows).toEqual([{subscription_id:a.subscription}]);
  } finally {await pause.release();await creating;await competing;await first.query("ROLLBACK");await second.query("ROLLBACK");await restore();first.release();second.release();observer.release();}
});

it("lc10_N3_opening_atomicity",async()=>{
  for(const creator of ["admit","recover"] as const){
    const before=(await pool.query("SELECT (SELECT count(*) FROM public.subscription_stock_wait_cases) AS cases,(SELECT count(*) FROM public.subscription_renewal_operations) AS operations,(SELECT count(*) FROM public.outbox_events WHERE event_type='subscription_stock_wait.opened.v1') AS facts")).rows;
    const signature=creator==="admit"?"public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz)":"public.subscription_stock_wait_recover_refusal(uuid,text,text,timestamptz)";
    const restore=await hook(signature,"PERFORM public.subscription_stock_wait_record_opened(c);"," RAISE EXCEPTION 'synthetic_opening_rollback';");
    try {
      await expect(createSuccessorJourney(pool,{creator})).rejects.toMatchObject({code:"P0001",message:"synthetic_opening_rollback"});
      expect((await pool.query("SELECT (SELECT count(*) FROM public.subscription_stock_wait_cases) AS cases,(SELECT count(*) FROM public.subscription_renewal_operations) AS operations,(SELECT count(*) FROM public.outbox_events WHERE event_type='subscription_stock_wait.opened.v1') AS facts")).rows).toEqual(before);
    } finally {await restore();}
    const f=await createSuccessorJourney(pool,{creator});
    expect((await pool.query("SELECT id FROM public.subscription_stock_wait_cases WHERE id=$1",[f.caseId])).rows).toEqual([{id:f.caseId}]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription_stock_wait.opened.v1'",[f.caseId])).rows).toEqual([{count:1}]);
  }
});

it("lc10_claim_and_preview_nonblocking",async()=>{
  const f=await createSuccessorJourney(pool),claimant=await pool.connect(),preview=await pool.connect(),resolver=await pool.connect(),observer=await pool.connect(),pause=await gate(observer);
  const restore=await hook("public.subscription_claim_due_renewal(text,text,jsonb,text,integer,timestamptz)","SELECT * INTO v_subscription\n    FROM public.subscriptions\n   WHERE id = v_subscription_id\n   FOR UPDATE;",pause.sql);
  let claiming:ReturnType<typeof tracked>|undefined,previewing:ReturnType<typeof tracked>|undefined,resolving:ReturnType<typeof tracked>|undefined;
  try {
    await claimant.query("BEGIN");await resolver.query("BEGIN");const claimPid=await pid(claimant),previewPid=await pid(preview),resolvePid=await pid(resolver),observerPid=await pid(observer);
    claiming=tracked(claimant.query("SELECT public.subscription_claim_due_renewal($1,$2,$3,'native-claim',300,$4) AS result",[f.codec.identity(f.frozen),f.codec.fingerprint(f.frozen),f.wire,f.at]));
    await blocked(observer,claimPid,observerPid);const before=await state();
    const {options,editor}=successorEditor(f);let quoted=false;
    options.quotePort={createServerAuthoritativeQuote:async()=>{quoted=true;throw Error("unexpected_quote_before_subscription");}};
    options.withTransaction=async work=>{try{await preview.query("BEGIN");const result=await work(preview);await preview.query("COMMIT");return result;}catch(error){await preview.query("ROLLBACK");throw error;}};
    let previewDone=false;
    previewing=tracked(editor.previewStockWaitSuccessor({actorId:f.principal,clientId:f.client},{subscriptionId:f.subscription,planDays:28,base:[{variantId:f.successor.sku,qty:1}],addons:[]},{caseId:f.caseId,caseKind:"legacy"})).then(result=>{previewDone=true;return result;});
    await expect.poll(async()=>previewDone||(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[previewPid,claimPid])).rows[0].blocked).toBe(true);
    const previewWaited=(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[previewPid,claimPid])).rows[0].blocked;
    if(previewWaited){await pause.release();await claiming;await claimant.query("COMMIT");}
    expect(await previewing).toMatchObject({ok:false,error:{code:"55P03",message:"lc10_commerce_busy"}});expect(previewWaited).toBe(false);expect(quoted).toBe(false);
    let resolveDone=false;
    resolving=tracked(resolver.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).then(result=>{resolveDone=true;return result;});
    await expect.poll(async()=>resolveDone||(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[resolvePid,claimPid])).rows[0].blocked).toBe(true);
    const resolveWaited=(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[resolvePid,claimPid])).rows[0].blocked;
    if(resolveWaited){await pause.release();await claiming;await claimant.query("COMMIT");}
    expect(await resolving).toMatchObject({ok:false,error:{code:"55P03",message:"lc10_commerce_busy"}});expect(resolveWaited).toBe(false);expect(await state()).toEqual(before);
    await pause.release();expect(await claiming).toMatchObject({ok:true});await claimant.query("COMMIT");
  } finally {await pause.release();await claiming;await previewing;await resolving;await claimant.query("ROLLBACK");await preview.query("ROLLBACK");await resolver.query("ROLLBACK");await restore();claimant.release();preview.release();resolver.release();observer.release();}
});

it.each(["publisher_first","acceptance_first"])("lc10_publication_acceptance_contention",async order=>{
  const f=await createSuccessorJourney(pool),resolver=await pool.connect(),observer=await pool.connect(),pause=await gate(observer),commandKey=randomUUID();
  const withdrawal=structuredClone(f.successor.value);withdrawal.product.sharedContent.catalogAction="revise";
  withdrawal.publication.operations=[{op:"set_product_lifecycle",productSlug:withdrawal.product.slug!,expectedState:"active",state:"withdrawn",children:[{skuCode:f.successor.code,expectedState:"active"}]}];
  const signature=order==="publisher_first"?"public.catalog_publication_record_admit()":"public.resolve_stock_wait_with_successor(uuid,uuid,text,text,uuid,timestamptz)";
  const boundary=order==="publisher_first"?"body := canonical::jsonb;":" -- Effects start only after ownership, frozen identity, quote and current admission.\n";
  let restore:()=>Promise<unknown>=async()=>{};
  let publishing:ReturnType<typeof tracked>|undefined,resolving:ReturnType<typeof tracked>|undefined;
  const resolve=()=>resolver.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,commandKey,f.client,f.at]);
  try {
    restore=await hook(signature,boundary,pause.sql);
    await resolver.query("BEGIN");const resolverPid=await pid(resolver),observerPid=await pid(observer);
    if(order==="publisher_first"){
      publishing=tracked(f.publish(withdrawal,f.successor.draft,1,f.successor.head));
      await expect.poll(async()=>(await observer.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE '%catalog_publications%'",[observerPid])).rows[0].count).toBe(1);
      const before=await state();expect(await tracked(resolve())).toMatchObject({ok:false,error:{code:"55P03",message:"lc10_commerce_busy"}});expect(await state()).toEqual(before);
      await resolver.query("ROLLBACK");await pause.release();expect(await publishing).toMatchObject({ok:true});const afterPublication=await state();
      await resolver.query("BEGIN");expect(await tracked(resolve())).toMatchObject({ok:false,error:{code:"40001",message:"customer_self_service_stale_edit_catalog_head"}});await resolver.query("ROLLBACK");expect(await state()).toEqual(afterPublication);
    }else{
      resolving=tracked(resolve());await blocked(observer,resolverPid,observerPid);
      publishing=tracked(f.publish(withdrawal,f.successor.draft,1,f.successor.head));
      expect(await publishing).toMatchObject({ok:false,error:{message:'{"outcome":"conflict","reason":"catalog_publication_busy"}'}});
      await pause.release();expect(await resolving).toMatchObject({ok:true,value:{rows:[{result:{status:"applied"}}]}});await resolver.query("COMMIT");
      publishing=tracked(f.publish(withdrawal,f.successor.draft,1,f.successor.head));expect(await publishing).toMatchObject({ok:true});
      expect((await pool.query("SELECT count(*)::integer AS count FROM public.subscription_successor_operations_v2 WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{count:1}]);
      expect((await pool.query("SELECT next_cycle_at=$2::timestamptz AS same FROM public.subscriptions WHERE id=$1",[f.subscription,f.anchor])).rows).toEqual([{same:true}]);
    }
  } finally {await pause.release();await resolver.query("ROLLBACK");await resolving;await publishing;await restore();resolver.release();observer.release();}
});

it("lc10_catalogue_reread_refuses_before_effects", async () => {
  const f = await createSuccessorJourney(pool);
  const resolver = await pool.connect(), observer = await pool.connect(), pause = await gate(observer);
  const withdrawal = structuredClone(f.successor.value);
  withdrawal.product.sharedContent.catalogAction = "revise";
  withdrawal.publication.operations = [{ op: "set_product_lifecycle", productSlug: withdrawal.product.slug!,
    expectedState: "active", state: "withdrawn", children: [{ skuCode: f.successor.code, expectedState: "active" }] }];
  const signature = "public.resolve_stock_wait_with_successor(uuid,uuid,text,text,uuid,timestamptz)";
  const restoreGate = await hook(signature, " admission:=q.quote_snapshot->'catalogAdmission';", pause.sql);
  let restoreEffects: (() => Promise<unknown>) | undefined;
  let resolving: ReturnType<typeof tracked> | undefined;
  try {
    // A later lane can reject the same stale head. Observe whether effects were reached first.
    restoreEffects = await hook(signature, " -- Effects start only after ownership, frozen identity, quote and current admission.\n",
      " RAISE EXCEPTION 'fixture_successor_effects_reached';\n");
    const resolverPid = await pid(resolver), observerPid = await pid(observer);
    resolving = tracked(resolver.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",
      [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at]));
    await blocked(observer, resolverPid, observerPid);
    const head = await f.publish(withdrawal, f.successor.draft, 1, f.successor.head);
    expect(head.publicationId).not.toBe(f.successor.head.publicationId);
    const published = await state();
    await pause.release();
    expect(await resolving).toMatchObject({ ok: false, error: { code: "40001", message: "customer_self_service_stale_edit_catalog_head" } });
    expect(await state()).toEqual(published);
  } finally {
    await pause.release();
    await resolving;
    await restoreEffects?.();
    await restoreGate();
    resolver.release();
    observer.release();
  }
});

it("lc10_real_payment_aggregate_contention",async()=>{
  const f=await prepareLegacy(),payer=await pool.connect(),resolver=await pool.connect(),observer=await pool.connect(),pause=await gate(observer),eventKey=randomUUID();
  const restore=await hook("public.payment_provider_lock_aggregate(uuid)","PERFORM 1 FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE;",pause.sql);
  let paying:ReturnType<typeof tracked>|undefined;
  try {
    await payer.query("BEGIN");await resolver.query("BEGIN");const payerPid=await pid(payer),observerPid=await pid(observer);
    paying=tracked(payer.query("SELECT public.commerce_record_settlement($1,$2,'succeeded',$3,'{}'::jsonb,$4) AS result",[eventKey,f.prepared.settlementIntentId,f.external,f.at]));
    await blocked(observer,payerPid,observerPid);const before=await state();
    expect(await tracked(resolver.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]))).toMatchObject({ok:false,error:{code:"55P03",message:"lc10_commerce_busy"}});
    expect(await state()).toEqual(before);await resolver.query("ROLLBACK");await pause.release();expect(await paying).toMatchObject({ok:true});await payer.query("COMMIT");
    expect((await pool.query("SELECT status FROM public.subscription_cycles WHERE id=$1",[f.prepared.cycleId])).rows).toEqual([{status:"paid"}]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND idempotency_key=$2",[f.prepared.settlementIntentId,eventKey])).rows).toEqual([{count:1}]);
    await resolver.query("BEGIN");expect(await tracked(resolver.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]))).toMatchObject({ok:false,error:{code:"22023",message:"stock_wait_successor_provider_owned"}});
  } finally {await pause.release();await paying;await payer.query("ROLLBACK");await resolver.query("ROLLBACK");await restore();payer.release();resolver.release();observer.release();}
});

it("lc10_selector_nonblocking",async()=>{
  const f=await createSuccessorJourney(pool,{ordinary:true});
  const stock=createPostgresFulfillmentStockSyncPort(pool,{sourceKey:f.source,readLocalInventoryStock:async()=>[]});
  await stock.recordProviderStockCurrent({requestKey:`selector:${f.subscription}`,snapshot:{providerRef:"synthetic",collectedAt:f.anchor,sourceRevision:null,revisionSource:"collection",quantityKind:"snapshot",skuRef:f.predecessor.code,totalQuantity:0,forSaleQuantity:0,reservedOrUnavailableQuantity:0,syncRunId:f.subscription},inventoryClass:"sellable",lastSyncedAt:f.anchor,staleAfter:(await pool.query("SELECT $1::timestamptz+interval '1 day' AS at",[f.anchor])).rows[0].at.toISOString()});
  const claimed=(await pool.query("SELECT public.subscription_claim_due_renewal($1,$2,$3,'selector',300,$4) AS result",[f.codec.identity(f.frozen),f.codec.fingerprint(f.frozen),f.wire,f.anchor])).rows[0].result;
  expect((await pool.query("SELECT public.fulfillment_reserve_subscription_renewal($1,$2,900,$3) AS result",[claimed.operationId,claimed.claimToken,f.anchor])).rows[0].result).toMatchObject({reserved:false});
  expect((await pool.query("SELECT id FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=$1",[claimed.operationId])).rows).toEqual([]);
  const at=(await pool.query("SELECT lease_expires_at+interval '1 second' AS at FROM public.subscription_renewal_operations WHERE id=$1",[claimed.operationId])).rows[0].at.toISOString();
  const worker=await pool.connect(),selector=await pool.connect(),observer=await pool.connect(),pause=await gate(observer);
  const restore=await hook("public.subscription_stock_wait_recover_refusal(uuid,text,text,timestamptz)","SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=p_operation_id FOR UPDATE;",pause.sql);
  let recovering:ReturnType<typeof tracked>|undefined,selecting:ReturnType<typeof tracked>|undefined;
  try {
    await worker.query("BEGIN");await selector.query("BEGIN");const workerPid=await pid(worker),selectorPid=await pid(selector),observerPid=await pid(observer);
    recovering=tracked(worker.query("SELECT public.subscription_stock_wait_recover_refusal($1,$2,'selector-worker',$3)",[claimed.operationId,f.codec.fingerprint(f.frozen),at]));
    await blocked(observer,workerPid,observerPid);
    for(const routine of ["subscription_stock_wait_candidates","subscription_stock_wait_candidates_v2"]){
      let done=false;selecting=tracked(selector.query(`SELECT public.${routine}(500,$1) AS result`,[at])).then(result=>{done=true;return result;});
      await expect.poll(async()=>done||(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[selectorPid,workerPid])).rows[0].blocked).toBe(true);
      const waited=(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[selectorPid,workerPid])).rows[0].blocked;
      if(waited){await pause.release();await recovering;await worker.query("COMMIT");}
      const outcome=await selecting;expect(waited).toBe(false);expect(outcome).toMatchObject({ok:true});
      if(outcome.ok){const rows=(outcome.value as {rows:{result:{operationId?:string;frozen?:{operationId?:string}}[]}[]}).rows[0].result;expect(rows.some(row=>(row.frozen??row).operationId===claimed.operationId)).toBe(false);}
    }
    await selector.query("ROLLBACK");await pause.release();expect(await recovering).toMatchObject({ok:true});await worker.query("COMMIT");
    expect((await pool.query("SELECT state FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=$1",[claimed.operationId])).rows).toEqual([{state:"waiting"}]);
  } finally {await pause.release();await recovering;await selecting;await worker.query("ROLLBACK");await selector.query("ROLLBACK");await restore();worker.release();selector.release();observer.release();}
});

it.each((["legacy", "successor"] as const).flatMap(kind =>
  ["due", "future", "cancelled", "reanchored", "provider_owned"].map(change => [kind, change] as const),
))("lc10_select_owned_wait_%s_%s", async (kind, change) => {
  const f = await createSuccessorJourney(pool, change === "provider_owned" && kind === "legacy"
    ? { creator: "recover", recoveryStock: 100 } : {});
  let caseId = f.caseId, operationId = f.operationId;
  if (kind === "successor") {
    if (change !== "provider_owned") await db.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=0 WHERE source_key=$1 AND sku=$2",
      [f.source, f.successor.code]);
    const resolved = (await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
      [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result;
    caseId = resolved.caseId;
    operationId = resolved.operationId;
  }
  const operations = kind === "legacy" ? "subscription_renewal_operations" : "subscription_successor_operations_v2";
  const waits = kind === "legacy" ? "subscription_stock_wait_cases" : "subscription_successor_wait_cases_v2";
  if (change === "provider_owned") {
    const claimed = (await db.query(`SELECT claim_token FROM public.${operations} WHERE id=$1`, [operationId])).rows[0];
    const prepare = kind === "legacy" ? "commerce_prepare_subscription_renewal" : "commerce_prepare_successor_renewal_v2";
    await db.query(`SELECT public.${prepare}($1,$2,$3)`, [operationId, claimed.claim_token, f.at]);
  }
  let at = (await db.query(`SELECT greatest($2::timestamptz,lease_expires_at+interval '1 second')::text AS as_of
    FROM public.${operations} WHERE id=$1`, [operationId, f.at])).rows[0].as_of;
  if (change === "future") {
    at = (await db.query("SELECT ($1::timestamptz-interval '1 second')::text AS as_of", [f.anchor])).rows[0].as_of;
    await db.query(`UPDATE public.${operations} SET claimed_at=$2::timestamptz-interval '2 seconds',
      lease_expires_at=$2::timestamptz-interval '1 second' WHERE id=$1`, [operationId, at]);
  }
  if (change === "cancelled") await db.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [f.subscription]);
  if (change === "reanchored" || change === "provider_owned") await db.query(
    "UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '1 day' WHERE id=$1", [f.subscription]);
  await db.query("UPDATE public.subscriptions SET status='paused' WHERE status='active' AND id<>$1", [f.subscription]);
  const result = (await db.query("SELECT public.subscription_stock_wait_candidates_v2(50,$1) AS result", [at])).rows[0].result;
  expect(result.some((candidate: { caseId?: string; frozen?: { caseId: string } }) => (candidate.frozen ?? candidate).caseId === caseId))
    .toBe(change === "due");
  const expected = change === "cancelled" || change === "reanchored"
    ? { state: "closed", block_reason: "cancelled_or_superseded" }
    : { state: change === "provider_owned" ? "stock_secured" : "waiting", last_selected_at: change === "due" ? expect.any(Date) : null };
  expect((await db.query(`SELECT state,block_reason,last_selected_at FROM public.${waits} WHERE id=$1`, [caseId])).rows[0]).toMatchObject(expected);
});

it("lc10_select_normal_filter_precedes_cap",async()=>{
  const wait=await createSuccessorJourney(pool,{creator:"recover",recoveryStock:100});
  const due=await createSuccessorJourney(pool,{ordinary:true});
  await db.query("UPDATE public.subscriptions SET status='paused' WHERE status='active' AND id<>ALL($1::uuid[])",[[wait.subscription,due.subscription]]);
  const old=(await db.query("SELECT subscription_id FROM public.subscription_list_due_renewals($1,1)",[due.anchor])).rows;
  expect(old).toEqual([{subscription_id:wait.subscription}]);
  const current=(await db.query("SELECT public.subscription_list_due_successor_renewals_v2(1,$1) AS result",[due.anchor])).rows[0].result;
  expect(current).toEqual([expect.objectContaining({operationKind:"legacy",due:expect.objectContaining({subscription_id:due.subscription})})]);
});

it.each(["never_selected", "oldest_check", "stable_case_id", "busy_successor"] as const)(
  "lc10_select_mixed_order_%s", async deciding => {
  const legacy = await createSuccessorJourney(pool), successor = await createSuccessorJourney(pool);
  const next = await transaction(async connection => {
    await connection.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=0 WHERE source_key=$1 AND sku=$2",
      [successor.source, successor.successor.code]);
    return (await connection.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
      [successor.caseId, successor.proposalId, successor.quoteHash, randomUUID(), successor.client, successor.at])).rows[0].result;
  });
  const at = (await db.query("SELECT ($1::timestamptz+interval '10 minutes')::text AS result", [successor.at])).rows[0].result;
  await db.query("UPDATE public.subscriptions SET status='paused' WHERE status='active' AND id<>ALL($1::uuid[])",
    [[legacy.subscription, successor.subscription]]);
  await db.query(`UPDATE public.subscription_stock_wait_cases SET last_checked_at=$2::timestamptz-interval '2 minutes',
    last_selected_at=CASE WHEN $3='never_selected' THEN $2::timestamptz-interval '1 minute' END WHERE id=$1`, [legacy.caseId, at, deciding]);
  const run = async () => (await db.query("SELECT public.subscription_stock_wait_candidates_v2(2,$1) AS result", [at])).rows[0].result
    .map((candidate: { caseId?: string; frozen?: { caseId: string } }) => (candidate.frozen ?? candidate).caseId);
  if (deciding === "busy_successor") {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM public.subscription_successor_wait_cases_v2 WHERE id=$1 FOR UPDATE", [next.caseId]);
      expect(await run()).toEqual([legacy.caseId]);
    } finally { await holder.query("ROLLBACK"); holder.release(); }
    expect((await db.query("SELECT last_selected_at FROM public.subscription_successor_wait_cases_v2 WHERE id=$1", [next.caseId])).rows)
      .toEqual([{ last_selected_at: null }]);
  } else {
    await db.query(`UPDATE public.subscription_successor_wait_cases_v2
      SET last_checked_at=$2::timestamptz-CASE WHEN $3='oldest_check' THEN interval '3 minutes' ELSE interval '2 minutes' END
      WHERE id=$1`, [next.caseId, at, deciding]);
    expect(await run()).toEqual(deciding === "stable_case_id" ? [legacy.caseId, next.caseId].sort() : [next.caseId, legacy.caseId]);
  }
});

it.each(["preview_first","resolution_first"])("lc10_preview_take_resolution_contention",async order=>{
  const f=await createSuccessorJourney(pool),reader=await pool.connect(),resolver=await pool.connect(),observer=await pool.connect(),pause=await gate(observer);
  const signature=order==="preview_first"?"public.subscription_quote_preview_take(uuid,uuid,uuid,text,text,integer,text,timestamptz)":"public.resolve_stock_wait_with_successor(uuid,uuid,text,text,uuid,timestamptz)";
  const boundary=order==="preview_first"?"AND action=p_action AND quote_hash=p_hash AND template_version=p_version ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;":"SELECT * INTO q FROM public.subscription_quote_previews WHERE id=(proposal.preview->>'id')::uuid FOR UPDATE NOWAIT;";
  let restore:()=>Promise<unknown>=async()=>{},reading:ReturnType<typeof tracked>|undefined,resolving:ReturnType<typeof tracked>|undefined;
  const resolve=()=>resolver.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]);
  const read=()=>reader.query("SELECT public.subscription_quote_preview_take($1,$2,$3,$4,$5,1,$6,$7) AS result",[f.principal,f.client,f.subscription,f.offer.action,f.offer.applyPayload.acceptedQuoteHash,randomUUID(),f.at]);
  try {
    restore=await hook(signature,boundary,pause.sql);await reader.query("BEGIN");await resolver.query("BEGIN");
    const readerPid=await pid(reader),resolverPid=await pid(resolver),observerPid=await pid(observer);
    if(order==="preview_first"){
      reading=tracked(read());await blocked(observer,readerPid,observerPid);const before=await state();
      expect(await tracked(resolve())).toMatchObject({ok:false,error:{code:"55P03",message:"lc10_commerce_busy"}});expect(await state()).toEqual(before);
      await resolver.query("ROLLBACK");await pause.release();expect(await reading).toMatchObject({ok:true});await reader.query("COMMIT");
      await resolver.query("BEGIN");expect(await tracked(resolve())).toMatchObject({ok:true,value:{rows:[{result:{status:"applied"}}]}});await resolver.query("COMMIT");
    }else{
      resolving=tracked(resolve());await blocked(observer,resolverPid,observerPid);reading=tracked(read());await blocked(observer,readerPid,resolverPid);
      await pause.release();expect(await resolving).toMatchObject({ok:true,value:{rows:[{result:{status:"applied"}}]}});await resolver.query("COMMIT");
      expect(await reading).toMatchObject({ok:false,error:{code:"22023",message:"subscription_edit_stale_template"}});
    }
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.subscription_successor_operations_v2 WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{count:1}]);
  } finally {await pause.release();await resolver.query("ROLLBACK");await resolving;await reader.query("ROLLBACK");await reading;await restore();reader.release();resolver.release();observer.release();}
});
it.each(["legacy_first","resolver_first"])("lc10_D6_direct_legacy_outcome_root_contention",async schedule=>{
  const f=await prepareLegacy(),observer=await pool.connect(),legacy=await pool.connect(),resolver=await pool.connect();
  const lPid=await pid(legacy),rPid=await pid(resolver),oPid=await pid(observer),pause=await gate(observer);
  let restore=async()=>{},finished=false;
  const invoke=()=>legacy.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'succeeded',$4,NULL,$5) AS result",[f.operationId,randomUUID(),f.codec.fingerprint(f.frozen),f.external,f.at]);
  const resolve=()=>resolver.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]);
  let old:Promise<{ok:true;value:unknown}|{ok:false;error:unknown}>|undefined;
  try {
    await legacy.query("BEGIN");await resolver.query("BEGIN");
    if(schedule==="legacy_first") {
      restore=await hook("public.commerce_record_subscription_renewal_outcome(uuid,text,text,text,text,text,timestamptz)","WHERE id = p_operation_id FOR UPDATE;",pause.sql);
      old=tracked(invoke());await blocked(observer,lPid,oPid);
    } else restore=await hook("public.resolve_stock_wait_with_successor(uuid,uuid,text,text,uuid,timestamptz)","SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE NOWAIT;",pause.sql);
    const before=await state(),resolving=tracked(resolve()).finally(()=>{finished=true;});
    if(schedule==="resolver_first") {
      await blocked(observer,rPid,oPid);old=tracked(invoke());await blocked(observer,lPid,rPid);await pause.release();
    }
    // An executable remove-NOWAIT mutant must fail on its actual root wait, before
    // PostgreSQL's deadlock detector or the runner timeout can supply an error.
    await expect.poll(async()=>finished?"finished":(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[rPid,lPid])).rows[0].blocked?"root_wait":"running").not.toBe("running");
    if(!finished) {
      await pause.release();await blocked(observer,lPid,rPid);
      expect((await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[rPid,lPid])).rows[0].blocked,"new root acquisition must refuse the inverse native wait").toBe(false);
    }
    expect(await resolving).toMatchObject({ok:false,error:{code:"55P03",message:"lc10_root_operation_busy"}});
    await resolver.query("ROLLBACK");expect(await state()).toEqual(before);
    await pause.release();expect(await old).toMatchObject({ok:true});await legacy.query("COMMIT");
    expect((await pool.query("SELECT status FROM public.commerce_orders WHERE id=$1",[f.prepared.orderId])).rows).toEqual([{status:"paid"}]);
    await expect(resolve()).rejects.toMatchObject({code:"22023",message:"stock_wait_successor_provider_owned"});
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.subscription_successor_operations_v2 WHERE root_operation_id=$1",[f.operationId])).rows).toEqual([{count:0}]);
  } finally {
    await observer.query("SELECT pg_cancel_backend($1)",[rPid]);await resolver.query("ROLLBACK");
    await pause.release();await legacy.query("ROLLBACK");await restore();observer.release();legacy.release();resolver.release();
  }
});

it("lc10_D6_document_fk_witness_precedence",async()=>{
  const f=await createSuccessorJourney(pool);
  const revision=(await db.query("SELECT current_document_revision_id FROM public.catalog_products WHERE id=$1",[f.successor.product])).rows[0].current_document_revision_id;
  const before=(await db.query("SELECT to_jsonb(p) AS row FROM public.catalog_products p WHERE id=$1",[f.predecessor.product])).rows[0].row;
  const update=()=>db.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1",[f.predecessor.product,revision]);
  await db.query("SAVEPOINT original_guard");
  await expect(update()).rejects.toMatchObject({code:"42501",message:"catalog_document_pointer_direct_write_denied"});
  await db.query("ROLLBACK TO SAVEPOINT original_guard");
  await db.query("SAVEPOINT single_fk_mutant");
  await db.query("ALTER TABLE public.catalog_products DROP CONSTRAINT catalog_products_current_document_revision_same_product_fkey");
  await expect(update()).rejects.toMatchObject({code:"42501",message:"catalog_document_pointer_direct_write_denied"});
  await db.query("ROLLBACK TO SAVEPOINT single_fk_mutant");
  await db.query("SAVEPOINT pointer_authority");
  await expect(db.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)",[f.predecessor.product,revision,"a".repeat(64)]))
    .rejects.toMatchObject({code:"23503",table:"catalog_publication_pointer_capabilities"});
  await db.query("ROLLBACK TO SAVEPOINT pointer_authority");
  expect((await db.query("SELECT to_jsonb(p) AS row FROM public.catalog_products p WHERE id=$1",[f.predecessor.product])).rows[0].row).toEqual(before);
});

// Custom roles opt in through the documented helper grant; raw tables stay private.
it("lc10_D6_invoker_ATP_custom_role_upgrade",async()=>{
  const container=await runPostgresContainer({name:`successor-invoker-${process.pid}`,password:"synthetic-invoker"});containers.push(container);
  if(!await waitForPostgresTcpReady(container.connectionString))throw Error("Invoker parity requires PostgreSQL");
  const owner=new Pool({connectionString:container.connectionString,options:qualifiedPostgresStartupOptions({generation:"qualified-v2",roleMode:"installer-managed",bootstrapLogin:"postgres",migrationLogin:"postgres",runtimeLogin:"lc10_runtime",restoreLogin:"lc10_restore"})});pools.push(owner);
  await owner.query("CREATE ROLE lc10_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE lc10_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  const manifest=JSON.parse(readFileSync("config/platform-migration-manifest.json","utf8")).qualified;
  for(const unit of [manifest.baseline,...manifest.forward]) {if(unit.file===migration)break;await owner.query(readFileSync(unit.file,"utf8"));}
  // Existing native invoker contract: no successor relation or privilege exists.
  await owner.query(`CREATE ROLE lc10_inventory_reader NOLOGIN NOINHERIT NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO lc10_inventory_reader;
    GRANT SELECT ON public.fulfillment_stock_current,public.fulfillment_inventory_reservations,public.fulfillment_inventory_reservation_lines,
      public.subscription_renewal_operations,public.subscription_cycles,public.subscriptions,public.subscription_renewal_terms,public.subscription_renewal_term_lines TO lc10_inventory_reader;
    GRANT EXECUTE ON FUNCTION public.inventory_available_to_promise(text,text,timestamptz,boolean),public.inventory_channel_exposure_quantity(text,text) TO lc10_inventory_reader`);
  const connection=await owner.connect();
  const call=(source="synthetic-source",sku="synthetic-sku",at?:string)=>connection.query("SELECT public.inventory_available_to_promise($1,$2,coalesce($3::timestamptz,clock_timestamp()),false) AS result",[source,sku,at??null]);
  try {
    await connection.query("SET ROLE lc10_inventory_reader");
    const before=(await call()).rows[0].result;
    expect(before).toEqual({available_quantity:0,for_sale_quantity:0,hard_hold_quantity:0,safety_quantity:0,soft_subscription_demand_quantity:0,channel_exposure_quantity:0});
    await connection.query("RESET ROLE");
    await owner.query(readFileSync(migration,"utf8"));
    expect((await owner.query("SELECT count(*)::integer AS count FROM public.subscription_successor_reservations_v2")).rows).toEqual([{count:0}]);
    expect((await owner.query("SELECT prosecdef FROM pg_proc WHERE oid='public.inventory_available_to_promise(text,text,timestamptz,boolean)'::regprocedure")).rows).toEqual([{prosecdef:false}]);
    await connection.query("SET ROLE lc10_inventory_reader");
    await expect(call()).rejects.toMatchObject({code:"42501",message:"permission denied for function inventory_successor_reservation_quantity"});
    await connection.query("RESET ROLE");
    const f=await createSuccessorJourney(owner);
    await owner.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]);
    await connection.query("SET ROLE service_role");
    expect((await call()).rows[0].result).toEqual(before);
    const held=(await call(f.source,f.successor.code,f.at)).rows[0].result;
    expect(held).toMatchObject({available_quantity:99,hard_hold_quantity:1});
    await connection.query("RESET ROLE");
    const grant="GRANT EXECUTE ON FUNCTION public.inventory_successor_reservation_quantity(text,text,timestamptz,uuid,timestamptz) TO lc10_inventory_reader";
    async function witness(){
      await connection.query("SET ROLE lc10_inventory_reader");
      try{expect((await call()).rows[0].result).toEqual(before);expect((await call(f.source,f.successor.code,f.at)).rows[0].result).toEqual(held);}
      finally{await connection.query("RESET ROLE");}
    }
    await owner.query(grant);await witness();
    expect((await owner.query("SELECT has_table_privilege('lc10_inventory_reader','public.subscription_successor_reservations_v2','SELECT') AS reads")).rows).toEqual([{reads:false}]);
    await owner.query("REVOKE EXECUTE ON FUNCTION public.inventory_successor_reservation_quantity(text,text,timestamptz,uuid,timestamptz) FROM lc10_inventory_reader");
    try{expect(await tracked(witness())).toMatchObject({ok:false,error:{code:"42501"}});}
    finally{await owner.query(grant);}
    await witness();
  } finally {await connection.query("RESET ROLE");connection.release();}
});

it("lc10_D6_invoker_ATP_compat",async()=>{
  const container=await runPostgresContainer({name:`successor-service-${process.pid}`,password:"synthetic-service"});containers.push(container);
  if(!await waitForPostgresTcpReady(container.connectionString))throw Error("ATP compatibility requires PostgreSQL");
  const owner=new Pool({connectionString:container.connectionString,options:qualifiedPostgresStartupOptions({generation:"qualified-v2",roleMode:"installer-managed",bootstrapLogin:"postgres",migrationLogin:"postgres",runtimeLogin:"lc10_runtime",restoreLogin:"lc10_restore"})});pools.push(owner);
  await owner.query("CREATE ROLE lc10_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE lc10_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  const manifest=JSON.parse(readFileSync("config/platform-migration-manifest.json","utf8")).qualified;
  for(const unit of [manifest.baseline,...manifest.forward]){if(unit.file===migration)break;await owner.query(readFileSync(unit.file,"utf8"));}
  const connection=await owner.connect();
  const call=(source="synthetic-source",sku="synthetic-sku",at?:string)=>connection.query("SELECT public.inventory_available_to_promise($1,$2,coalesce($3::timestamptz,clock_timestamp()),false) AS result",[source,sku,at??null]);
  try {
    await connection.query("SET ROLE service_role");const before=(await call()).rows[0].result;
    await connection.query("RESET ROLE");await owner.query(readFileSync(migration,"utf8"));
    await connection.query("SET ROLE service_role");expect((await call()).rows[0].result).toEqual(before);
    await connection.query("RESET ROLE");
    const f=await createSuccessorJourney(owner);
    await owner.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]);
    async function witness(){
      await connection.query("SET ROLE service_role");
      try {
        expect((await call()).rows[0].result).toEqual(before);
        expect((await call(f.source,f.successor.code,f.at)).rows[0].result).toEqual({available_quantity:99,for_sale_quantity:100,hard_hold_quantity:1,safety_quantity:0,soft_subscription_demand_quantity:0,channel_exposure_quantity:0});
      } finally {await connection.query("RESET ROLE");}
    }
    await witness();
    await owner.query("REVOKE EXECUTE ON FUNCTION public.inventory_successor_reservation_quantity(text,text,timestamptz,uuid,timestamptz) FROM service_role");
    try {expect(await tracked(witness())).toMatchObject({ok:false,error:{code:"42501"}});}
    finally {await owner.query("GRANT EXECUTE ON FUNCTION public.inventory_successor_reservation_quantity(text,text,timestamptz,uuid,timestamptz) TO service_role");}
    await witness();
    await owner.query("ALTER FUNCTION public.inventory_successor_reservation_quantity(text,text,timestamptz,uuid,timestamptz) SECURITY INVOKER");
    try {expect(await tracked(witness())).toMatchObject({ok:false,error:{code:"42501"}});}
    finally {await owner.query("ALTER FUNCTION public.inventory_successor_reservation_quantity(text,text,timestamptz,uuid,timestamptz) SECURITY DEFINER");}
    await witness();
    const original=(await owner.query("SELECT pg_get_functiondef('public.inventory_available_to_promise(text,text,timestamptz,boolean)'::regprocedure) AS ddl")).rows[0].ddl as string;
    const summand="+public.inventory_successor_reservation_quantity(p_source_key,p_sku,p_as_of)";
    expect(original.split(summand)).toHaveLength(2);await owner.query(original.replace(summand,""));
    try {expect(await tracked(witness())).toMatchObject({ok:false,error:{name:"AssertionError"}});}
    finally {await owner.query(original);}
    await witness();
    expect((await owner.query("SELECT has_table_privilege('service_role','public.subscription_successor_reservations_v2','SELECT') AS reads,pg_get_function_result('public.inventory_successor_reservation_quantity(text,text,timestamptz,uuid,timestamptz)'::regprocedure) AS result")).rows).toEqual([{reads:false,result:"bigint"}]);
    await owner.query("CREATE ROLE lc10_no_atp NOLOGIN NOINHERIT NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO lc10_no_atp");
    for(const role of ["lc10_no_atp","anon","authenticated"]){
      expect((await owner.query("SELECT has_function_privilege($1,'public.inventory_available_to_promise(text,text,timestamptz,boolean)','EXECUTE') AS allowed",[role])).rows).toEqual([{allowed:false}]);
      await connection.query(`SET ROLE ${role}`);
      await expect(connection.query("SELECT public.inventory_successor_reservation_quantity($1,$2,$3)",[f.source,f.successor.code,f.at])).rejects.toMatchObject({code:"42501"});
      await connection.query("RESET ROLE");
    }
  } finally {await connection.query("RESET ROLE");connection.release();}
});

it.each([
  {name:"lc10_ATP_credit_unknown_subscription",subscription:"unknown",schedule:"same"},
  {name:"lc10_ATP_credit_mismatched_subscription",subscription:"other",schedule:"same"},
  {name:"lc10_ATP_credit_unknown_schedule",subscription:"same",schedule:"other"},
  {name:"lc10_ATP_credit_missing_subscription",subscription:"null",schedule:"same"},
  {name:"lc10_ATP_credit_missing_schedule",subscription:"same",schedule:"null"},
])("$name",async({subscription,schedule})=>{
  const f=await createSuccessorJourney(pool);
  await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]);
  const other=await legacy();
  const sub=subscription==="same"?f.subscription:subscription==="other"?other.subscription:subscription==="unknown"?randomUUID():null;
  const at=schedule==="same"?f.anchor:schedule==="other"?(await db.query("SELECT $1::timestamptz+interval '1 day' AS at",[f.anchor])).rows[0].at:null;
  const invoke=(subscriptionId:string|null,scheduledAt:unknown)=>db.query("SELECT public.inventory_successor_reservation_quantity($1,$2,$3,$4,$5) AS quantity",[f.source,f.successor.code,f.at,subscriptionId,scheduledAt]);
  expect((await invoke(f.subscription,f.anchor)).rows).toEqual([{quantity:"1"}]);
  expect((await invoke(sub,at)).rows).toEqual([{quantity:"0"}]);
  if(subscription==="unknown"||schedule==="other"){
    const original=(await db.query("SELECT pg_get_functiondef('public.inventory_successor_reservation_quantity(text,text,timestamptz,uuid,timestamptz)'::regprocedure) AS ddl")).rows[0].ddl as string;
    const predicate=subscription==="unknown"?"g.subscription_id=p_subscription_id":"g.scheduled_at=p_scheduled_at";
    expect(original.split(predicate)).toHaveLength(2);
    await db.query("SAVEPOINT matching_filter_mutant");await db.query(original.replace(predicate,"true"));
    const witness=async()=>expect((await invoke(sub,at)).rows).toEqual([{quantity:"0"}]);
    expect(await tracked(witness())).toMatchObject({ok:false,error:{name:"AssertionError"}});
    await db.query("ROLLBACK TO SAVEPOINT matching_filter_mutant");await witness();
  }
});

it.each([
  {name:"lc10_history_02989_same_product_sku",column:"primary_sku_id",parent:"catalog_skus",constraint:"catalog_products_primary_sku_same_product_fkey"},
  {name:"lc10_history_03027_validated_sku_fk",column:"primary_sku_id",parent:"catalog_skus",constraint:"catalog_products_primary_sku_same_product_fkey"},
  {name:"lc10_history_02991_same_product_document",column:"current_document_revision_id",parent:"catalog_product_document_revisions",constraint:"catalog_products_current_document_revision_same_product_fkey"},
  {name:"lc10_history_03028_validated_document_fk",column:"current_document_revision_id",parent:"catalog_product_document_revisions",constraint:"catalog_products_current_document_revision_same_product_fkey"},
])("$name",async({column,parent,constraint})=>{
  const f=await createSuccessorJourney(pool);
  const pointers=(await db.query("SELECT primary_sku_id,current_document_revision_id FROM public.catalog_products WHERE id=$1",[f.successor.product])).rows[0];
  const product=randomUUID(),foreign=pointers[column];
  const before=(await db.query("SELECT to_jsonb(p) AS row FROM public.catalog_products p WHERE id=$1",[f.predecessor.product])).rows[0].row;
  const metadata=(await db.query(`SELECT c.convalidated,c.confdeltype,c.confrelid::regclass::text AS parent,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.ord) AS child_columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.ord) AS parent_columns
    FROM pg_constraint c WHERE c.conrelid='public.catalog_products'::regclass AND c.conname=$1`,[constraint])).rows;
  expect(metadata).toEqual([{convalidated:true,confdeltype:"r",parent,child_columns:["id",column],parent_columns:["product_id","id"]}]);
  let reachedWrite=false;
  async function witness() {
    await db.query("SAVEPOINT foreign_identity");
    try {
      // The document INSERT uses ordinary insert authority; its UPDATE fence stays intact.
      const write=column==="primary_sku_id"
        ? db.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1",[f.predecessor.product,foreign])
        : db.query("INSERT INTO public.catalog_products(id,slug,name,current_document_revision_id) VALUES($1,$2,'Synthetic article',$3)",[product,`article-${product}`,foreign]);
      await expect(write.then(result=>{reachedWrite=result.rowCount===1;return result;})).rejects.toMatchObject({code:"23503",constraint});
    } finally { await db.query("ROLLBACK TO SAVEPOINT foreign_identity"); }
  }
  await witness();expect(reachedWrite).toBe(false);
  await db.query("SAVEPOINT target_fk_mutant");
  await db.query(`ALTER TABLE public.catalog_products DROP CONSTRAINT ${constraint}`);
  expect(await tracked(witness())).toMatchObject({ok:false,error:{name:"AssertionError"}});
  expect(reachedWrite).toBe(true);
  await db.query("ROLLBACK TO SAVEPOINT target_fk_mutant");
  reachedWrite=false;await witness();expect(reachedWrite).toBe(false);
  expect((await db.query("SELECT id FROM public.catalog_products WHERE id=$1",[product])).rows).toEqual([]);
  expect((await db.query("SELECT to_jsonb(p) AS row FROM public.catalog_products p WHERE id=$1",[f.predecessor.product])).rows[0].row).toEqual(before);
});

it("lc10_D6_paid_fact_legacy_bytes",async()=>{
  const source=readFileSync("db/platform/migrations/20261111120000_communication_ecommerce_sources.sql","utf8");
  const start=source.indexOf("CREATE FUNCTION public.communication_paid_fact(");
  const original=source.slice(start,source.indexOf("END; $$;",start)+9);
  expect(start).toBeGreaterThan(0);
  await db.query(original.replace("public.communication_paid_fact","pg_temp.lc10_legacy_paid_fact"));
  const f=await prepareLegacy();
  await db.query("CREATE TEMP TABLE lc10_paid_fact_probe(order_id uuid,actual jsonb,expected jsonb) ON COMMIT DROP");
  const restore=await hook("public.commerce_order_emit_paid_notification()","PERFORM public.communication_event_paid_write(NEW.id);",
    "INSERT INTO pg_temp.lc10_paid_fact_probe VALUES(NEW.id,public.communication_paid_fact(NEW),pg_temp.lc10_legacy_paid_fact(NEW));");
  try {
    await db.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'succeeded',$4,NULL,$5)",[f.operationId,randomUUID(),f.codec.fingerprint(f.frozen),f.external,f.at]);
    const orders=[f.prepared.orderId];
    for(const options of [{},{initial:true},{discount:true},{complete:false}])orders.push((await ecommercePaid(db,{...options,at:f.at})).order);
    const results=(await db.query("SELECT actual,expected FROM pg_temp.lc10_paid_fact_probe ORDER BY order_id")).rows;
    expect(results).toHaveLength(orders.length);
    for(const result of results)expect(result.actual).toEqual(result.expected);
    expect(results.map(r=>r.actual.state).sort()).toEqual(["complete","complete","complete","complete","incomplete"]);
    expect(results.filter(r=>r.actual.state==="complete").map(r=>r.actual.event.data.purchaseKind).sort()).toEqual(["one_time","one_time","renewal","subscription_initial"]);
  } finally { await restore(); }
});

it("lc10_D6_C5_first_and_replay_json",async()=>{
  const f=await prepareLegacy();
  expect((await db.query("SELECT public.subscription_stock_wait_mark_resumed($1) AS result",[f.prepared.orderId])).rows).toEqual([{result:null}]);
  await db.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'succeeded',$4,NULL,$5)",[f.operationId,randomUUID(),f.codec.fingerprint(f.frozen),f.external,f.at]);
  await db.query("SAVEPOINT no_shipment");
  await expect(db.query("SELECT public.subscription_stock_wait_mark_resumed($1)",[f.prepared.orderId])).rejects.toMatchObject({code:"22023",message:"stock_wait_realization_admission_missing"});
  await db.query("ROLLBACK TO SAVEPOINT no_shipment");
  await db.query("RELEASE SAVEPOINT no_shipment");
  await db.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('synthetic-successor','3pl',true) ON CONFLICT DO NOTHING");
  await db.query("SELECT public.fulfillment_create_shipment($1,$2,'synthetic-successor','{}'::jsonb,$3)",[`shipment:${f.prepared.orderId}`,f.prepared.orderId,f.at]);
  const first=(await db.query("SELECT public.subscription_stock_wait_mark_resumed($1) AS result",[f.prepared.orderId])).rows[0].result;
  const expected=(await db.query("SELECT to_jsonb(c)-'due_snapshot'-'cycle_snapshot'-'notice_messages' AS result FROM public.subscription_stock_wait_cases c WHERE id=$1",[f.caseId])).rows[0].result;
  expect(first).toEqual(expected);expect(Object.keys(first)).toHaveLength(21);expect(first.state).toBe("resumed");
  expect((await db.query("SELECT public.subscription_stock_wait_mark_resumed($1) AS result",[f.prepared.orderId])).rows[0].result).toEqual(first);
  expect((await db.query("SELECT idempotency_key FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription_stock_wait.resumed'",[f.caseId])).rows).toEqual([{idempotency_key:`subscription_stock_wait:${f.caseId}:resumed`}]);
  expect((await db.query("SELECT public.subscription_stock_wait_mark_resumed($1) AS result",[randomUUID()])).rows).toEqual([{result:null}]);
});

it("lc10_D6_shared_ATP_counts_generation_once",async()=>{
  const f=await createSuccessorJourney(pool);
  const resolved=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const g=(await db.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1",[resolved.operationId])).rows[0];
  const atp=async(renewal:boolean,at=f.at)=>(await db.query("SELECT public.inventory_available_to_promise($1,$2,$3,$4) AS result",[f.source,f.successor.code,at,renewal])).rows[0].result;
  const expected={available_quantity:99,for_sale_quantity:100,hard_hold_quantity:1,safety_quantity:0,soft_subscription_demand_quantity:0,channel_exposure_quantity:0};
  expect(await atp(false)).toEqual(expected);expect(await atp(true)).toEqual(expected);
  const held=(await db.query("SELECT expires_at FROM public.subscription_successor_reservations_v2 WHERE operation_id=$1",[g.id])).rows[0];
  const expiry=(await db.query("SELECT $1::timestamptz+interval '1 second' AS at",[held.expires_at])).rows[0].at.toISOString();
  expect(await atp(false,expiry)).toEqual({...expected,hard_hold_quantity:0,soft_subscription_demand_quantity:1});
  expect(await atp(true,expiry)).toEqual({...expected,available_quantity:100,hard_hold_quantity:0,soft_subscription_demand_quantity:1});
  await db.query("SAVEPOINT committed_hold");
  await db.query("SELECT public.commerce_prepare_successor_renewal_v2($1,$2,$3)",[g.id,g.claim_token,f.at]);
  expect(await atp(false,expiry)).toEqual(expected);expect(await atp(true,expiry)).toEqual(expected);
  await db.query("ROLLBACK TO SAVEPOINT committed_hold");await db.query("RELEASE SAVEPOINT committed_hold");
  await db.query("SELECT public.fulfillment_release_successor_renewal_v2($1,$2,'fixture_release',$3)",[g.id,g.claim_token,f.at]);
  expect(await atp(false)).toEqual({...expected,hard_hold_quantity:0,soft_subscription_demand_quantity:1});
  expect(await atp(true)).toEqual({...expected,available_quantity:100,hard_hold_quantity:0,soft_subscription_demand_quantity:1});
});

it("stock_wait_successor_never_moves_cycle_earlier",async()=>{
  const f=await createSuccessorJourney(pool);
  const before=(await db.query("SELECT s.next_cycle_at,t.next_cycle_number,op.scheduled_at,op.cycle_number FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id JOIN public.subscription_renewal_operations op ON op.subscription_id=s.id WHERE op.id=$1",[f.operationId])).rows[0];
  const result=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const after=(await db.query("SELECT s.next_cycle_at,t.next_cycle_number,g.scheduled_at,g.cycle_number FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id JOIN public.subscription_successor_operations_v2 g ON g.subscription_id=s.id WHERE g.id=$1",[result.operationId])).rows[0];
  expect(after).toEqual(before);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_delivery_alignment_arrivals a JOIN public.fulfillment_shipments f ON f.id=a.shipment_id JOIN public.commerce_orders o ON o.id=f.order_id JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id WHERE c.subscription_id=$1",[f.subscription])).rows).toEqual([{count:0}]);
});

it("lc10_D6_one_live_generation",async()=>{
  const f=await createSuccessorJourney(pool);
  const result=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const g=(await db.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1",[result.operationId])).rows[0];
  const at=(await db.query("SELECT $1::timestamptz+interval '1 second' AS at",[g.lease_expires_at])).rows[0].at.toISOString();
  const due=(await db.query("SELECT public.subscription_list_due_successor_renewals_v2(500,$1) AS result",[at])).rows[0].result as Record<string,unknown>[];
  expect(due.filter(row=>row.operationId===g.id)).toHaveLength(1);
  expect(due.filter(row=>row.operationKind==="legacy"&&(row.due as Record<string,unknown>).subscription_id===f.subscription)).toEqual([]);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_successor_operations_v2 WHERE root_operation_id=$1 AND superseded_by_proposal_id IS NULL",[f.operationId])).rows).toEqual([{count:1}]);
  expect((await db.query(`SELECT i.indisunique,pg_get_expr(i.indpred,i.indrelid) AS predicate,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.n ORDER BY k.ord) AS columns
    FROM pg_index i WHERE i.indexrelid=to_regclass('public.subscription_successor_operations_v2_live_root_key')`)).rows)
    .toEqual([{indisunique:true,predicate:"(superseded_by_proposal_id IS NULL)",columns:["root_operation_id"]}]);
});

it("lc10_successor_transfer_preserves_nonempty_graph_and_replay",async()=>{
  const binding={sourceIdentity:"retained:synthetic",candidateKind:"adopt_v2",baseProtocol:"v3",eventKind:"adopt_v2",
    authorityRef:"installed:synthetic"};
  const owner=transferSource.owner,f=await createSuccessorJourney(owner,{continuation:true,historicalBinding:binding}),following=f.continuation!;
  const rootBefore=(await owner.query("SELECT to_jsonb(o) AS row FROM public.subscription_renewal_operations o WHERE id=$1",[f.operationId])).rows;
  const first=(await owner.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const withdraw=structuredClone(f.successor.value);withdraw.product.sharedContent.catalogAction="revise";
  withdraw.publication.operations=[{op:"set_product_lifecycle",productSlug:withdraw.product.slug!,expectedState:"active",state:"withdrawn",children:[{skuCode:f.successor.code,expectedState:"active"}]}];
  await f.publish(withdraw,f.successor.draft,1,f.successor.head);
  const at=(await owner.query(`SELECT to_char((lease_expires_at+interval '1 second') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM public.subscription_successor_operations_v2 WHERE id=$1`,[first.operationId])).rows[0].at;
  const {options}=successorEditor({...f,successor:following,at});options.withTransaction=work=>transaction(work,owner);
  const editor=createPostgresPackageEditor(options),actor={actorId:f.principal,clientId:f.client};
  const quoted=await editor.previewStockWaitSuccessor(actor,{subscriptionId:f.subscription,planDays:28,base:[{variantId:following.sku,qty:1}],addons:[],expectedTemplateVersion:2},{caseId:first.caseId,caseKind:"successor"});
  const price=(await owner.query("SELECT to_jsonb(p) AS row FROM public.price_entries p WHERE variant_id=$1",[following.sku])).rows[0].row;
  const admission={...f.offer.applyPayload.catalogAdmission,heads:[{productId:following.product,head:following.head}],skuRevisions:[{reference:following.reference,quantity:1}],priceContextVersions:[{skuId:following.sku,priceListId:price.price_list_id,entryId:price.id,entry:price}]};
  const nextFrozen=f.codec.withDestination!(f.codec.freeze({...f.header,template_version:3,lines:[{lineOrdinal:1,sku:following.code,quantity:1,unitAmountMinor:777}],catalog_acceptance:{schemaVersion:2,lines:[following.reference]},graduation_pricing:[{sku:following.code,quantity:1,unitAmountMinor:777,isAddon:false,quoteLine:{sku:following.code,quantity:1,unitPriceGross:{amountMinor:777,currency:"XXX"},lineSubtotalGross:{amountMinor:777,currency:"XXX"}}}]},{subscriptionId:f.subscription,scheduledAt:f.anchor,scheduledInstant:Date.parse(f.anchor)}),f.destination);
  const store=createPostgresSuccessorStore({withTransaction:work=>transaction(work,owner),codec:f.codec,editLimits:successorEditLimits,previews:{prepare:async(connection,input)=>{
    const row=(await connection.query("UPDATE public.subscription_quote_previews SET quote_snapshot=quote_snapshot||jsonb_build_object('catalogAdmission',$2::jsonb) WHERE id=$1::uuid RETURNING *",[input.previewId,admission])).rows[0];
    return {applyPayload:{...(row.request_payload as Record<string,unknown>),request:row.request_payload,...(row.quote_snapshot as Record<string,unknown>),...(row.totals as Record<string,unknown>)},cycleSnapshot:nextFrozen};
  }}});
  const offered=await store.offer(actor,{proposalId:randomUUID(),subscriptionId:f.subscription,predecessorSkuId:f.successor.sku,successorSkuId:following.sku,publicationId:following.declared.publicationId,previewId:quoted.previewId!,lane:"classic",action:"update_package_template",sourceBinding:{kind:"stock_wait",caseId:first.caseId,caseKind:"successor"},now:at});
  const resolved=await store.resolve(actor,{caseId:first.caseId,proposalId:String(offered.id),acceptedQuoteHash:String(offered.quote_hash),commandKey:randomUUID(),now:at});
  expect((await owner.query("SELECT to_jsonb(o) AS row FROM public.subscription_renewal_operations o WHERE id=$1",[f.operationId])).rows).toEqual(rootBefore);
  expect((await owner.query("SELECT predecessor_generation_id,superseded_by_proposal_id FROM public.subscription_successor_operations_v2 WHERE id=$1",[first.operationId])).rows).toEqual([{predecessor_generation_id:null,superseded_by_proposal_id:offered.id}]);
  expect((await owner.query("SELECT predecessor_generation_id FROM public.subscription_successor_operations_v2 WHERE id=$1",[resolved.operationId])).rows).toEqual([{predecessor_generation_id:first.operationId}]);
  expect((await owner.query("SELECT count(*)::integer AS count FROM public.subscription_successor_operations_v2 WHERE root_operation_id=$1 AND superseded_by_proposal_id IS NULL",[f.operationId])).rows).toEqual([{count:1}]);
  expect((await owner.query("SELECT next_cycle_at=$2::timestamptz AS anchor,next_cycle_number FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id WHERE s.id=$1",[f.subscription,f.anchor])).rows).toEqual([{anchor:true,next_cycle_number:1}]);
  const original=await journeyCensus(transferSource.owner),packet=await captureStoreJourney(transferSource.owner,"successor-source");
  for(const table of ["catalog_sku_successors","subscription_successor_proposals","subscription_successor_operations_v2","subscription_successor_wait_cases_v2","subscription_successor_reservations_v2"]){
    expect(packet.owned.find(entry=>entry.table===table)?.rows).toHaveLength(2);
  }
  const request={owner:transferTarget.owner,installation:journeySelection,packet,
    freshTarget:await captureStoreJourney(transferTarget.owner,"successor-target"),historicalSuccessorBindings:[binding]};
  const fresh=await journeyCensus(transferTarget.owner);
  for(const invalid of [[],[binding,binding],...["candidateKind","baseProtocol","eventKind","authorityRef"].map(key=>[{...binding,[key]:"different"}])]){
    await expect(restoreConnectedNativeStore({...request,historicalSuccessorBindings:invalid}))
      .rejects.toMatchObject({code:"invalid_input",table:"subscription_successor_proposals"});
  }
  expect(await journeyCensus(transferTarget.owner)).toEqual(fresh);
  expect(await restoreConnectedNativeStore(request)).toMatchObject({replayed:false});
  expect(await journeyCensus(transferTarget.owner)).toEqual(original);
  const restored=await captureStoreJourney(transferTarget.owner,"successor-restored");
  expect(restored.owned).toEqual(packet.owned);expect(restored.compatible.tables).toEqual(packet.compatible.tables);
  expect(await restoreConnectedNativeStore(request)).toMatchObject({replayed:true});
  expect(await journeyCensus(transferTarget.owner)).toEqual(original);
  expect((await transferTarget.owner.query("SELECT public.subscription_stock_wait_read_v2($1,'successor') AS result",[resolved.caseId])).rows[0].result).toMatchObject({schemaVersion:2,caseKind:"successor",case:{operation_id:resolved.operationId}});
  expect((await transferTarget.owner.query("SELECT root_operation_id FROM public.subscription_successor_operations_v2 WHERE id=$1",[resolved.operationId])).rows).toEqual([{root_operation_id:f.operationId}]);
});

it("lc10_D6_legacy_opened_shipped_invoker_compat",async()=>{
  const owner=transferSource.owner,f=await createSuccessorJourney(owner),connection=await owner.connect();
  async function witness(){
    await connection.query("SET ROLE service_role");
    try{
      expect((await connection.query("SELECT public.subscription_stock_wait_recover_refusal($1,$2,'compatibility',$3) AS result",[f.operationId,f.codec.fingerprint(f.frozen),f.at])).rows[0].result).toMatchObject({waiting:true,caseId:f.caseId});
    }finally{await connection.query("RESET ROLE");}
  }
  try{
    await witness();
    expect((await owner.query("SELECT count(*)::integer AS count FROM public.outbox_events WHERE event_type='subscription_stock_wait.opened.v1' AND aggregate_id=$1",[f.caseId])).rows).toEqual([{count:1}]);
    await owner.query("REVOKE EXECUTE ON FUNCTION public.subscription_stock_wait_record_opened(public.subscription_stock_wait_cases) FROM service_role");
    try{expect(await tracked(witness())).toMatchObject({ok:false,error:{code:"42501",message:"permission denied for function subscription_stock_wait_record_opened"}});}
    finally{await owner.query("GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_record_opened(public.subscription_stock_wait_cases) TO service_role");}
    await witness();
    expect((await owner.query("SELECT prosecdef FROM pg_proc WHERE oid='public.subscription_stock_wait_record_opened(public.subscription_stock_wait_cases)'::regprocedure")).rows).toEqual([{prosecdef:false}]);
  }finally{await connection.query("RESET ROLE");connection.release();}
});

it("successor_offer_requires_acceptance_and_never_substitutes",async()=>{
  const f=await prepareLegacy();
  expect((await db.query("SELECT state FROM public.subscription_successor_proposals WHERE id=$1",[f.proposalId])).rows).toEqual([{state:"offered"}]);
  expect((await db.query("SELECT variant_id,unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{variant_id:f.predecessor.sku,unit_price_minor:"617"}]);
  expect((await db.query("SELECT sku_id,unit_amount_minor FROM public.commerce_order_items WHERE order_id=$1",[f.prepared.orderId])).rows).toEqual([{sku_id:f.predecessor.sku,unit_amount_minor:"617"}]);
  expect((await db.query("SELECT id FROM public.subscription_successor_operations_v2 WHERE root_operation_id=$1",[f.operationId])).rows).toEqual([]);
});

it("successor_offer_never_advances_cycle",async()=>{
  const f=await createSuccessorJourney(pool);
  expect((await db.query("SELECT next_cycle_at=$2::timestamptz AS same FROM public.subscriptions WHERE id=$1",[f.subscription,f.anchor])).rows).toEqual([{same:true}]);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2",[f.subscription,f.anchor])).rows).toEqual([{count:0}]);
});

// Pack-owned strength and shade data use the admitted mass-based native rail.
it.each(["strength","shade"] as const)("lc10_successor_pack_%s_active_subscriber",async profile=>{
  const f=await createSuccessorJourney(pool,{profile});
  expect(f.predecessor.value.skus[0].options).not.toEqual(f.successor.value.skus[0].options);
  expect(f.predecessor.reference.optionDigest).not.toBe(f.successor.reference.optionDigest);
  expect(f.successor.reference.netContent).toEqual(f.predecessor.reference.netContent);
  expect((await pool.query("SELECT publication_facts->>'lifecycleState' AS state FROM public.catalog_skus WHERE id=$1",[f.predecessor.sku])).rows).toEqual([{state:"withdrawn"}]);
  expect((await pool.query("SELECT s.status,l.variant_id,l.unit_price_minor FROM public.subscriptions s JOIN public.subscription_lines l ON l.subscription_id=s.id WHERE s.id=$1",[f.subscription])).rows)
    .toEqual([{status:"active",variant_id:f.predecessor.sku,unit_price_minor:"617"}]);
  expect(await createPostgresCatalogWithdrawalImpact(pool).report(f.predecessor.sku)).toMatchObject({outcome:"complete",obligations:expect.arrayContaining([
    expect.objectContaining({family:"template",subscriptionId:f.subscription}),expect.objectContaining({family:"stock_wait",sourceId:f.caseId,subscriptionId:f.subscription})])});
  const before=(await pool.query("SELECT next_cycle_at,t.next_cycle_number FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id WHERE s.id=$1",[f.subscription])).rows;
  const key=randomUUID(),accept=()=>transaction(async connection=>(await connection.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,key,f.client,f.at])).rows[0].result);
  const first=await accept();expect(first).toMatchObject({status:"applied",proposalId:f.proposalId});expect(await accept()).toEqual(first);
  expect((await pool.query("SELECT variant_id,unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{variant_id:f.successor.sku,unit_price_minor:"777"}]);
  expect((await pool.query("SELECT next_cycle_at,t.next_cycle_number FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id WHERE s.id=$1",[f.subscription])).rows).toEqual(before);
});

it.each(["classic","exact","sized"] as const)("lc10_successor_lane_acceptance_%s",async lane=>{
  for(const ordinary of [false,true]){
    const f=await createSuccessorJourney(pool,{lane,ordinary}),key=randomUUID();
    const before=(await pool.query("SELECT next_cycle_at,t.next_cycle_number FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id WHERE s.id=$1",[f.subscription])).rows;
    const invoke=()=>transaction(async connection=>(await connection.query("SELECT public.subscription_successor_proposal_decide_v2($1,$2,'accepted',$3,$4,$5) AS result",[f.proposalId,f.client,key,f.quoteHash,f.at])).rows[0].result);
    const first=await invoke();expect(first).toMatchObject({status:"applied",proposalId:f.proposalId});expect(await invoke()).toEqual(first);
    expect((await pool.query("SELECT variant_id,quantity,unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{variant_id:f.successor.sku,quantity:1,unit_price_minor:"777"}]);
    expect((await pool.query("SELECT next_cycle_at,t.next_cycle_number FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id WHERE s.id=$1",[f.subscription])).rows).toEqual(before);
    expect((await pool.query("SELECT state FROM public.subscription_successor_proposals WHERE id=$1",[f.proposalId])).rows).toEqual([{state:"accepted"}]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.subscription_successor_operations_v2 WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{count:ordinary?0:1}]);
  }
});

const successorCommandPaths = [
  ["a2", "classic", "ordinary"], ["a3", "exact", "ordinary"], ["a4", "sized", "ordinary"],
  ["a6", "classic", "declined"], ["a7", "classic", "expired"],
  ["a8", "classic", "wait"], ["a9", "exact", "wait"], ["a10", "sized", "wait"],
] as const;
it.each((["classic","exact","sized"] as const).flatMap(lane=>["ordinary","wait"].flatMap(source=>
  ["missing_line","changed_amount","changed_currency"].map(change=>[lane,source,change] as const),
)))("lc10_quote_agreed_baseline_%s_%s_%s",async(lane,source,change)=>{
  const f=await createSuccessorJourney(pool,{lane,ordinary:source==="ordinary"});
  if(change==="missing_line")await pool.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1",[f.subscription]);
  if(change==="changed_amount")await transaction(async connection=>{
    await connection.query("UPDATE public.subscription_lines SET unit_price_minor=unit_price_minor+1 WHERE subscription_id=$1",[f.subscription]);
    await connection.query("UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=unit_amount_minor+1 WHERE subscription_id=$1",[f.subscription]);
  });
  if(change==="changed_currency")await pool.query("UPDATE public.subscription_renewal_terms SET currency_code='ZZZ' WHERE subscription_id=$1",[f.subscription]);
  const store=createPostgresSuccessorStore({withTransaction:transaction,codec:f.codec,
    previews:{prepare:async()=>{throw Error("decision_must_not_quote");}},
    assertCurrentSizedFacts:async()=>{throw Error("baseline_must_refuse_before_subject");}});
  const actor={actorId:f.principal,clientId:f.client},input={proposalId:f.proposalId,commandKey:randomUUID(),now:f.at};
  const before=await state();
  const result=source==="ordinary" ? store.decide(actor,{...input,decision:"accepted",quoteHash:f.quoteHash})
    :store.resolve(actor,{...input,caseId:f.caseId,acceptedQuoteHash:f.quoteHash});
  await expect(result).rejects.toHaveProperty("message",change==="missing_line"?"agreement_baseline_unavailable"
    :change==="changed_currency"?"agreement_currency_mismatch":"subscription_edit_quote_drift");
  expect(await state()).toEqual(before);
});

it.each(successorCommandPaths.flatMap(([path, lane, mode]) => (
  mode === "declined" || mode === "expired" ? ["key"] as const : ["key", "hash"] as const
).map(field => [`lc10_d_${field === "key" ? "222" : "223"}_${path}`, lane, mode, field] as const)))(
  "%s", async (_name, lane, mode, field) => {
    const f = await createSuccessorJourney(pool, { lane, ordinary: mode !== "wait" });
    const now = mode === "expired" ? (await pool.query(
      "SELECT expires_at+interval '1 second' AS at FROM public.subscription_successor_proposals WHERE id=$1", [f.proposalId],
    )).rows[0].at.toISOString() : f.at;
    const store = createPostgresSuccessorStore({ withTransaction: transaction, codec: f.codec, editLimits: successorEditLimits,
      previews: { prepare: async () => { throw Error("decision_must_not_quote"); } },
      assertCurrentSizedFacts: async (_connection, context, expected) => {
        expect(expected).toMatchObject({ subscriptionId: context.subscriptionId, clientId: context.clientId });
      } });
    const actor = { actorId: f.principal, clientId: f.client };
    const key = field === "key" ? (mode === "expired" ? `ą${"b".repeat(179)}` : "ąbcdefgh") : randomUUID();
    const hash = f.quoteHash;
    const invoke = (commandKey: string, quoteHash: string) => mode === "wait"
      ? store.resolve(actor, { caseId: f.caseId, proposalId: f.proposalId, acceptedQuoteHash: quoteHash, commandKey, now })
      : store.decide(actor, { proposalId: f.proposalId, decision: mode === "ordinary" ? "accepted" : mode,
        commandKey, quoteHash: mode === "ordinary" ? quoteHash : null, now });
    const receipts = async () => (await pool.query(
      "SELECT idempotency_key FROM public.subscription_command_receipts WHERE subscription_id=$1", [f.subscription],
    )).rows;
    for (const [invalidKey, invalidHash] of field === "key"
      ? [[" abcdefg ", hash], [` ${"a".repeat(181)} `, hash]]
      : [[key, ` ${"g".repeat(64)} `], [key, ` ${"a".repeat(63)} `]]) {
      await expect(Promise.resolve().then(() => invoke(invalidKey!, invalidHash!))).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(await receipts()).toEqual([]);
    const decorated = (value: string) => ` \t${value}\r\n`;
    const first = await invoke(field === "key" ? decorated(key) : key, field === "hash" ? decorated(hash) : hash);
    expect(first).toMatchObject({ status: "applied", proposalId: f.proposalId });
    expect(await invoke(key, hash)).toEqual(first);
    expect((await receipts()).filter(row => row.idempotency_key === key)).toHaveLength(1);
  },
);

function sizedSuccessorEditor(f: Awaited<ReturnType<typeof createSuccessorJourney>>, overrides: Partial<Parameters<typeof createPostgresSizedEditor>[0]> = {}) {
  const { catalogFacts, ...facts } = f.subjectFacts;
  const editor = createPostgresSizedEditor({
    withTransaction: transaction, now: () => f.at,
    assertCurrentFacts: async () => { throw Error("unexpected_subject_recheck"); },
    policy: { minimumCoreUnits: 1, maximumCoreLines: 3, maximumAddonLines: 3, maximumQuantity: 12, allowedCadences: [28],
      maximumExclusions: 20, maximumCatalogExclusions: 20, fixedThroughCycle: 2, graduationCycle: 3,
      portionModes: { full: { mode: "complete", factor: 1 }, reduced: { mode: "partial", factor: 0.5 } } },
    readFacts: async () => ({ ...facts, exclusions: [] }),
    resolveOptInNeed: async () => ({ dailyNeed: 1, snapshot: { revision: 1 } }),
    readCatalog: async () => catalogFacts,
    proposePortion: async () => { throw Error("unexpected_portion"); },
    quotePort: { async createServerAuthoritativeQuote() {
      const quoteLine = f.sizedQuoteLine;
      const total = quoteLine.lineSubtotalGross, zero = { amountMinor: 0, currency: total.currency };
      return { quote: { currency: total.currency, taxIncluded: true, lines: [quoteLine], discounts: [],
        subtotalGross: total, discountTotalGross: zero, totalGross: total, netTotal: total, taxTotal: zero } };
    } },
    ...overrides,
  });
  const request = { subscriptionId: f.subscription, action: "resize_bundle" as const, cadenceDays: 28,
    compositionConstraint: { kind: "unit_count", value: 1, dailyNeed: 1 },
    resizeLever: { kind: "subscription.sized.parcel" as const, value: {
      coreLines: [{ variantId: f.successor.sku, qty: 1 }], optInToSized: true as const,
    } },
  };
  return { editor, request };
}

it.each(["classic", "exact", "sized"] as const)("lc10_quote_prune_skips_unrelated_locked_preview_%s", async lane => {
  const f = await createSuccessorJourney(pool, { lane }), other = await createSuccessorJourney(pool, { ordinary: true });
  const older = (await pool.query(`SELECT ($1::timestamptz-interval '9 days') AS created,
    ($1::timestamptz-interval '8 days') AS expires`, [f.at])).rows[0];
  const makeAged = async (hash: string) => (await pool.query(
    "SELECT public.subscription_quote_preview_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result",
    [other.principal, other.client, other.subscription, "update_package_template", hash, 1, older.expires, {}, {}, {}, older.created],
  )).rows[0].result;
  const locked = await makeAged(createHash("sha256").update(randomUUID()).digest("hex"));
  const unlocked = await makeAged(createHash("sha256").update(randomUUID()).digest("hex"));
  const holder = await pool.connect(), writer = await pool.connect();
  const holderPid = await pid(holder), writerPid = await pid(writer);
  let completed = false;
  let pending: ReturnType<typeof tracked> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM public.subscription_quote_previews WHERE id=$1 FOR UPDATE", [locked.id]);
    await writer.query("BEGIN");
    const withTransaction = <T>(run: (connection: PoolClient) => Promise<T>) => run(writer);
    const actor = { actorId: f.principal, clientId: f.client }, source = { caseId: f.caseId, caseKind: "legacy" as const };
    const { options } = successorEditor(f);
    const sized = sizedSuccessorEditor(f, { withTransaction });
    const editor = createPostgresPackageEditor({ ...options, withTransaction });
    const preview = lane === "sized" ? sized.editor.previewStockWaitSuccessor(actor, sized.request, source)
      : editor.previewStockWaitSuccessor(actor, lane === "exact"
        ? { subscriptionId: f.subscription, action: "swap_base_line", fromVariantId: f.predecessor.sku, toVariantId: f.successor.sku }
        : { subscriptionId: f.subscription, planDays: 28, base: [{ variantId: f.successor.sku, qty: 1 }], addons: [] }, source);
    pending = tracked<unknown>(preview).finally(() => { completed = true; });
    await expect.poll(async () => completed ? "completed" : (
      await pool.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [writerPid, holderPid])
    ).rows[0].blocked ? "blocked" : "pending").toBe("completed");
    expect(await pending).toMatchObject({ ok: true, value: { previewId: expect.any(String), preview: { canApply: true } } });
    expect((await writer.query("SELECT id FROM public.subscription_quote_previews WHERE id=ANY($1::uuid[])", [[locked.id, unlocked.id]])).rows)
      .toEqual([{ id: locked.id }]);
  } finally {
    await holder.query("ROLLBACK");
    await pending;
    await writer.query("ROLLBACK");
    holder.release();
    writer.release();
  }
});

it.each((["payment", "retained_quote"] as const).flatMap(fact =>
  (["classic", "exact", "sized"] as const).map(lane => [fact, lane] as const),
))("lc10_quote_%s_refusal_precedes_source_close_%s", async (fact, lane) => {
  const f = await createSuccessorJourney(pool, { lane });
  let proposalId = f.proposalId, quoteHash = f.quoteHash;
  if (fact === "payment") await db.query("DELETE FROM public.subscription_method_states WHERE subscription_id=$1", [f.subscription]);
  else {
    proposalId = randomUUID();
    const applyPayload = { ...f.offer.applyPayload, [lane === "classic" ? "planDays" : "cadenceDays"]: 29 };
    const { rows } = await db.query("SELECT public.subscription_successor_proposal_offer_v2($1,$2,$3,$4) AS result",
      [f.subscription, f.client, { ...f.offer, proposalId, applyPayload }, f.at]);
    quoteHash = rows[0].result.quote_hash;
  }
  await db.query(`CREATE FUNCTION pg_temp.reject_test_source_close() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture_source_close_reached'; END; $$;
    CREATE TRIGGER fixture_source_close BEFORE UPDATE ON public.subscription_stock_wait_cases
    FOR EACH ROW WHEN (NEW.state='closed') EXECUTE FUNCTION pg_temp.reject_test_source_close()`);
  const invoke = () => db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",
    [f.caseId, proposalId, quoteHash, randomUUID(), f.client, f.at]);
  const before = await state();
  await db.query("SAVEPOINT payment_refusal");
  await expect(invoke()).rejects.toMatchObject({ code: "22023",
    message: fact === "payment" ? "subscription_command_payment_blocked" : "subscription_edit_quote_drift" });
  await db.query("ROLLBACK TO SAVEPOINT payment_refusal");
  expect(await state()).toEqual(before);
});

it.each(["classic", "exact", "sized"] as const)("lc10_quote_source_close_precedes_agreement_effects_%s", async lane => {
  const f = await createSuccessorJourney(pool, { lane, creator: "recover", recoveryStock: 100 });
  const graph = (await db.query(`SELECT hold.status, op.lease_expires_at+interval '1 second' AS as_of
    FROM public.subscription_renewal_operations op JOIN public.fulfillment_inventory_reservations hold
      ON hold.renewal_operation_id=op.id WHERE op.id=$1`, [f.operationId])).rows[0];
  expect(graph.status).toBe("held");
  await db.query(`CREATE FUNCTION pg_temp.assert_test_source_released() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.subscription_id ELSE NEW.subscription_id END;
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM public.subscription_stock_wait_cases wait
        JOIN public.fulfillment_inventory_reservations hold ON hold.renewal_operation_id=wait.renewal_operation_id
        WHERE wait.subscription_id=target AND wait.state='closed' AND wait.block_reason='superseded_by_successor' AND hold.status='released')
      THEN RAISE EXCEPTION 'fixture_agreement_write_before_source_release'; END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER fixture_agreement_effect_order BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_lines
    FOR EACH ROW EXECUTE FUNCTION pg_temp.assert_test_source_released()`);
  await expect(db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, graph.as_of]))
    .resolves.toMatchObject({ rows: [{ result: { status: "applied", rootOperationId: f.operationId, proposalId: f.proposalId } }] });
  expect((await db.query("SELECT next_cycle_at=$2::timestamptz AS same FROM public.subscriptions WHERE id=$1",
    [f.subscription, f.anchor])).rows).toEqual([{ same: true }]);
});

it("lc10_quote_unrepresentable_lane_refuses_before_activation", async () => {
  const f = await createSuccessorJourney(pool), proposalId = randomUUID();
  const offer = (await db.query("SELECT public.subscription_successor_proposal_offer_v2($1,$2,$3,$4) AS result",
    [f.subscription, f.client, { ...f.offer, proposalId, lane: "legacy" }, f.at])).rows[0].result;
  await db.query("SAVEPOINT unavailable_lane");
  await expect(db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",
    [f.caseId, proposalId, offer.quote_hash, randomUUID(), f.client, f.at]))
    .rejects.toMatchObject({ code: "55000", message: "successor_lane_unavailable" });
  await db.query("ROLLBACK TO SAVEPOINT unavailable_lane");
  expect((await db.query("SELECT state,accepted_receipt FROM public.subscription_successor_proposals WHERE id=$1", [proposalId])).rows)
    .toEqual([{ state: "offered", accepted_receipt: null }]);
  expect((await db.query("SELECT id FROM public.subscription_successor_operations_v2 WHERE proposal_id=$1", [proposalId])).rows).toEqual([]);
  expect((await db.query("SELECT variant_id FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows)
    .toEqual([{ variant_id: f.predecessor.sku }]);
});

it.each(["a4", "a10"] as const)("lc10_quote_sized_rejects_legacy_alias_%s", async path => {
  const f = await createSuccessorJourney(pool, { lane: "sized", ordinary: path === "a4", applyLegacyAlias: true });
  const store = createPostgresSuccessorStore({ withTransaction: transaction, codec: f.codec, editLimits: successorEditLimits,
    previews: { prepare: async () => { throw Error("acceptance_must_not_quote"); } }, assertCurrentSizedFacts: async () => {} });
  const actor = { actorId: f.principal, clientId: f.client };
  const input = { proposalId: f.proposalId, commandKey: randomUUID(), now: f.at };
  const before = await state();
  await expect(path === "a4" ? store.decide(actor, { ...input, decision: "accepted", quoteHash: f.quoteHash })
    : store.resolve(actor, { ...input, caseId: f.caseId, acceptedQuoteHash: f.quoteHash }))
    .rejects.toHaveProperty("message", "subscription_reprice_invalid_request");
  expect(await state()).toEqual(before);
});

it.each(([['a8', 'classic'], ['a9', 'exact'], ['a10', 'sized']] as const).flatMap(([path, lane]) =>
  ([1, 100] as const).map(qty => [path, lane, qty] as const),
))("lc10_quote_successor_host_bounds_%s_%s_%s", async (_path, lane, qty) => {
  const f = await createSuccessorJourney(pool, { lane, quotedQuantity: qty });
  const store = createPostgresSuccessorStore({ withTransaction: transaction, codec: f.codec, editLimits: successorEditLimits,
    previews: { prepare: async () => { throw Error("acceptance_must_not_quote"); } }, assertCurrentSizedFacts: async () => {} });
  const input = { proposalId: f.proposalId, commandKey: randomUUID(), now: f.at, caseId: f.caseId, acceptedQuoteHash: f.quoteHash };
  const before = await state();
  const result = store.resolve({ actorId: f.principal, clientId: f.client }, input);
  if (qty === 100) {
    await expect(result).rejects.toHaveProperty("message", "subscription_reprice_invalid_request");
    expect(await state()).toEqual(before);
  } else expect(await result).toMatchObject({ status: "applied", proposalId: f.proposalId });
});

it.each(["ordinary", "a4", "a10"].flatMap(path =>
  ["changed_subject", "absent_subject", "changed_exclusions", "invalid_exclusions", "exclusion_cap", "accepted"]
    .map(change => [path, change] as const),
))("lc10_quote_sized_subject_%s_%s", async (path, change) => {
  const exclusions: unknown = change === "invalid_exclusions" ? ["valid", 1]
    : change === "exclusion_cap" ? Array.from({ length: 21 }, (_, index) => `key-${index}`) : [];
  const f = await createSuccessorJourney(pool, { lane: "sized", ordinary: path !== "a10",
    retainedExclusions: path === "ordinary" ? [] : exclusions });
  const actor = { actorId: f.principal, clientId: f.client }, commandKey = randomUUID();
  const { catalogFacts: _catalogFacts, ...facts } = f.subjectFacts;
  let guarded = false;
  const assertCurrentFacts: SizedHostPorts["assertCurrentFacts"] = async (connection, context, expected) => {
    guarded = true;
    const current = (await connection.query(`SELECT value FROM lc10_subject_fixture
      WHERE subscription_id=$1 AND client_id=$2 FOR UPDATE`, [context.subscriptionId, context.clientId])).rows[0]?.value;
    if (!current || !(await connection.query("SELECT $1::jsonb=$2::jsonb AS equal", [current, expected])).rows[0]?.equal) {
      throw Error("subscription_edit_invalid_subject_snapshot");
    }
  };
  let invalidAtApply = false;
  const withSubject = <T>(work: (connection: PoolClient) => Promise<T>) => transaction(async connection => {
    await connection.query("CREATE TEMP TABLE lc10_subject_fixture(subscription_id uuid,client_id uuid,value jsonb) ON COMMIT DROP");
    if (change !== "absent_subject" || !invalidAtApply) await connection.query(
      "INSERT INTO lc10_subject_fixture VALUES($1,$2,$3)", [f.subscription, f.client, { ...facts,
        subjectRef: change === "changed_subject" && invalidAtApply ? randomUUID() : facts.subjectRef,
        exclusions: change === "changed_exclusions" && invalidAtApply ? ["new"] : invalidAtApply ? exclusions : [],
      }],
    );
    return work(connection);
  });
  const store = createPostgresSuccessorStore({ withTransaction: withSubject, codec: f.codec, editLimits: successorEditLimits, assertCurrentSizedFacts: assertCurrentFacts,
    previews: { prepare: async () => { throw Error("decision_must_not_quote"); } } });
  const { editor, request: ordinaryRequest } = sizedSuccessorEditor(f, {
    withTransaction: withSubject, assertCurrentFacts,
    async readFacts() {
      // Ordinary apply reprices from its admitted inputs, then the transaction guard checks live facts.
      return { ...facts, exclusions: (invalidAtApply && ["invalid_exclusions", "exclusion_cap"].includes(change) ? exclusions : []) as string[] };
    },
  });
  const ordinaryPreview = path === "ordinary" ? await editor.preview(actor, ordinaryRequest) : null;
  if (ordinaryPreview) {
    expect(ordinaryPreview.preview.canApply).toBe(true);
    await pool.query(`UPDATE public.subscription_quote_previews SET quote_snapshot=quote_snapshot||jsonb_build_object('catalogAdmission',$2::jsonb)
      WHERE subscription_id=$1 AND quote_hash=$3`, [f.subscription, f.offer.applyPayload.catalogAdmission, ordinaryPreview.quoteHash]);
  }
  const invoke = () => path === "ordinary" ? editor.apply(actor, commandKey, { ...ordinaryRequest,
    expectedTemplateVersion: 1, acceptedQuoteHash: ordinaryPreview!.quoteHash! })
    : path === "a4" ? store.decide(actor, { proposalId: f.proposalId, decision: "accepted", quoteHash: f.quoteHash, commandKey, now: f.at })
      : store.resolve(actor, { proposalId: f.proposalId, caseId: f.caseId, acceptedQuoteHash: f.quoteHash, commandKey, now: f.at });
  invalidAtApply = true;
  const before = await state();
  if (change === "accepted") {
    const result = await invoke();
    expect(result).toMatchObject(path === "ordinary"
      ? { status: "applied", subscriptionId: f.subscription } : { status: "applied", proposalId: f.proposalId });
    expect(guarded).toBe(true);
    expect((await pool.query("SELECT variant_id FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows)
      .toEqual([{ variant_id: f.successor.sku }]);
  } else {
    const message = ["invalid_exclusions", "exclusion_cap"].includes(change)
      ? "subscription_reprice_sized_subject_facts_unreadable" : "subscription_edit_invalid_subject_snapshot";
    await expect(invoke()).rejects.toHaveProperty("message", message);
    expect(guarded).toBe(message === "subscription_edit_invalid_subject_snapshot");
    expect(await state()).toEqual(before);
  }
});

it.each(["anon", "authenticated", "service_role"] as const)("lc10_sized_acceptance_primitives_refuse_%s", async role => {
  for (const call of [
    "subscription_successor_proposal_decide_v2(NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::timestamptz)",
    "resolve_stock_wait_with_successor(NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::timestamptz)",
  ]) {
    await expect(transaction(async connection => {
      await connection.query(`SET LOCAL ROLE ${role}`);
      await connection.query(`SELECT public.${call}`);
    }, transferSource.owner)).rejects.toHaveProperty("code", "42501");
  }
});

it.each(["sql", "adapter"].flatMap(path => ["expired_preview", "consumed_preview"].map(phase => [path, phase] as const)))(
  "lc10_quote_offer_replay_%s_%s", async (path, phase) => {
    const f = await createSuccessorJourney(pool, { ordinary: true });
    const original = (await pool.query("SELECT to_jsonb(p) AS result FROM public.subscription_successor_proposals p WHERE p.id=$1",
      [f.proposalId])).rows[0].result;
    const at = phase === "expired_preview" ? (await pool.query(
      "SELECT expires_at+interval '1 second' AS at FROM public.subscription_successor_proposals WHERE id=$1", [f.proposalId],
    )).rows[0].at.toISOString() : f.at;
    if (phase === "consumed_preview") {
      await transaction(connection => connection.query("SELECT public.subscription_successor_proposal_decide_v2($1,$2,'accepted',$3,$4,$5)",
        [f.proposalId, f.client, randomUUID(), f.quoteHash, f.at]));
      expect((await pool.query("SELECT status FROM public.subscription_quote_previews WHERE id=$1", [f.offer.previewId])).rows)
        .toEqual([{ status: "accepted" }]);
    }
    const { applyPayload: _applyPayload, cycleSnapshot: _cycleSnapshot, ...request } = f.offer;
    const actor = { actorId: f.principal, clientId: f.client };
    const replayTransaction = <T>(work: (connection: PoolClient) => Promise<T>) => transaction(async connection => {
      await connection.query("SET LOCAL timezone = 'Asia/Tokyo'");
      return work(connection);
    });
    const store = createPostgresSuccessorStore({ withTransaction: replayTransaction, codec: f.codec,
      previews: { prepare: async () => { throw Error("retained_offer_must_not_be_enriched"); } } });
    const replay = (action = f.offer.action) => path === "sql"
      ? replayTransaction(async connection => (await connection.query("SELECT public.subscription_successor_proposal_offer_v2($1,$2,$3,$4) AS result",
        [f.subscription, f.client, { ...f.offer, action }, at])).rows[0].result)
      : store.offer(actor, { ...request, previewId: String(request.previewId), sourceBinding: { kind: "ordinary_edit" },
        lane: "classic", action, subscriptionId: f.subscription, now: at });
    const before = await state();
    expect(await replay()).toEqual(original);
    await expect(replay("update_plan_length")).rejects.toMatchObject({
      message: "subscription_command_idempotency_conflict", code: "23505",
    });
    expect(await state()).toEqual(before);
  },
);

it.each(["declined","expired"] as const)("lc10_successor_%s_preserves_obligations",async decision=>{
  for(const ordinary of [false,true]){
    const f=await createSuccessorJourney(pool,{ordinary}),key=randomUUID();
    const before=await state();
    const at=decision==="expired"?(await pool.query("SELECT expires_at+interval '1 second' AS at FROM public.subscription_successor_proposals WHERE id=$1",[f.proposalId])).rows[0].at.toISOString():f.at;
    const store=createPostgresSuccessorStore({withTransaction:transaction,codec:f.codec,previews:{prepare:async()=>{throw Error("decision_must_not_quote");}}});
    const input={proposalId:f.proposalId,decision,commandKey:key,quoteHash:null,now:at};
    const first=await store.decide({actorId:f.principal,clientId:f.client},input);
    expect(first).toMatchObject({status:"applied",decision,proposalId:f.proposalId});expect(await store.decide({actorId:f.principal,clientId:f.client},input)).toEqual(first);
    const after=await state();
    for(const table of Object.keys(before).filter(table=>!["subscription_successor_proposals","subscription_command_receipts","outbox_events"].includes(table)))expect(after[table],table).toEqual(before[table]);
    expect((await pool.query("SELECT state FROM public.subscription_successor_proposals WHERE id=$1",[f.proposalId])).rows).toEqual([{state:decision}]);
  }
});

it("stock_wait_successor_refuses_paid_or_provider_owned",async()=>{
  const f=await prepareLegacy();
  for(const paid of [false,true]) {
    if(paid)await pool.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'succeeded',$4,NULL,$5)",[f.operationId,randomUUID(),f.codec.fingerprint(f.frozen),f.external,f.at]);
    const before=await state();
    await db.query("SAVEPOINT provider_owned");
    await expect(db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]))
      .rejects.toMatchObject({code:"22023",message:"stock_wait_successor_provider_owned"});
    await db.query("ROLLBACK TO SAVEPOINT provider_owned");await db.query("RELEASE SAVEPOINT provider_owned");
    expect(await state()).toEqual(before);
  }
});

it.each(["resolution_first","recovery_first"])("stock_wait_successor_races_recovery_one_winner",async order=>{
  const f=await createSuccessorJourney(pool,{creator:"recover",recoveryStock:100}),observer=await pool.connect(),winner=await pool.connect(),loser=await pool.connect();
  const at=(await pool.query("SELECT lease_expires_at+interval '1 second' AS at FROM public.subscription_renewal_operations WHERE id=$1",[f.operationId])).rows[0].at.toISOString();
  const pause=await gate(observer),wPid=await pid(winner),oPid=await pid(observer);
  const resolve=(connection:PoolClient)=>connection.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,at]);
  const recover=(connection:PoolClient)=>connection.query("SELECT public.subscription_stock_wait_recover_refusal($1,$2,'synthetic-recovery',$3) AS result",[f.operationId,f.codec.fingerprint(f.frozen),at]);
  const resolutionFirst=order==="resolution_first";
  const restore=await hook(resolutionFirst?"public.resolve_stock_wait_with_successor(uuid,uuid,text,text,uuid,timestamptz)":"public.subscription_stock_wait_recover_refusal(uuid,text,text,timestamptz)",
    resolutionFirst?"SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE NOWAIT;":"SELECT * INTO s FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;",pause.sql);
  let pending:Promise<unknown>|undefined;
  try {
    await winner.query("BEGIN");await loser.query("BEGIN");
    pending=(resolutionFirst?resolve:recover)(winner);await blocked(observer,wPid,oPid);const before=await state();
    await expect((resolutionFirst?recover:resolve)(loser)).rejects.toMatchObject({code:"55P03",message:"inventory_admission_busy"});
    await loser.query("ROLLBACK");expect(await state()).toEqual(before);
    await pause.release();expect((await pending as {rows:{result:Record<string,unknown>}[]}).rows[0].result).toMatchObject(resolutionFirst?{status:"applied"}:{waiting:false});
    await winner.query("COMMIT");
    await expect((resolutionFirst?recover:resolve)(loser)).rejects.toMatchObject({code:"22023",message:resolutionFirst?"stock_wait_binding_changed":"stock_wait_successor_lease_active"});
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.subscription_successor_operations_v2 WHERE root_operation_id=$1 AND superseded_by_proposal_id IS NULL",[f.operationId])).rows).toEqual([{count:resolutionFirst?1:0}]);
  } finally {await pause.release();await winner.query("ROLLBACK");await loser.query("ROLLBACK");await restore();observer.release();winner.release();loser.release();}
});

it("lc10_exact_old_receipt",async()=>{
  const f=await createSuccessorJourney(pool),key=randomUUID();
  const claim=(connection:PgQueryExecutor)=>connection.query("SELECT public.subscription_claim_due_renewal($1,$2,$3,'synthetic-old-worker',300,$4) AS result",[f.codec.identity(f.frozen),f.codec.fingerprint(f.frozen),f.wire,f.at]);
  const original=(await claim(pool)).rows[0]!.result;
  const resolved=await transaction(async connection=>(await connection.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,key,f.client,f.at])).rows[0].result);
  const changed=structuredClone(f.predecessor.value);changed.product.sharedContent.catalogAction="revise";changed.product.sharedContent.presentation={label:"Synthetic revision"};
  changed.publication.operations=[{op:"set_product_presentation",productSlug:changed.product.slug!,presentation:{label:"Synthetic revision"}}];
  const drift=await f.publish(changed,f.predecessor.draft,2,f.withdrawalHead);expect(drift.revision).toBe(f.withdrawalHead.revision+1);
  const reconnected=new Pool({connectionString});
  try {
    expect((await claim(reconnected)).rows[0]!.result).toEqual(original);
    const replay=(await reconnected.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,key,f.client,f.at])).rows[0].result;
    expect(replay).toEqual(resolved);
    expect((await reconnected.query("SELECT count(*)::integer AS count FROM public.subscription_successor_operations_v2 WHERE root_operation_id=$1",[f.operationId])).rows).toEqual([{count:1}]);
  } finally {await reconnected.end();}
});

it("lc10_D6_one_native_realization_and_benefit",async()=>{
  const f=await createSuccessorJourney(pool);
  const resolved=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const g=(await db.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1",[resolved.operationId])).rows[0];
  const store=createPostgresSuccessorStore({withTransaction:work=>work(db),codec:f.codec,previews:{prepare:async()=>{throw Error("unexpected_preview");}}});
  const input={operationId:g.id,claimToken:g.claim_token,now:f.at};
  const prepared=await store.prepare(input);
  expect(await store.prepare(input)).toEqual({...prepared,replayed:true});
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_cycles WHERE subscription_id=$1 AND status='paid'",[f.subscription])).rows).toEqual([{count:1}]);
  const outcome={operationId:g.id,eventKey:randomUUID(),evidence:{operationFingerprint:g.operation_fingerprint,outcome:"succeeded" as const,externalRef:`synthetic:${g.id}`},now:f.at};
  const settled=await store.settle(outcome);expect(await store.settle(outcome)).toEqual(settled);
  await db.query("SAVEPOINT second_payment");
  await expect(store.settle({...outcome,eventKey:randomUUID()})).rejects.toMatchObject({code:"22023",message:"commerce_renewal_outcome_attempt_not_prepared"});
  await db.query("ROLLBACK TO SAVEPOINT second_payment");await db.query("RELEASE SAVEPOINT second_payment");
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_cycles WHERE subscription_id=$1 AND status='paid'",[f.subscription])).rows).toEqual([{count:2}]);
  expect((await db.query("SELECT next_cycle_number FROM public.subscription_renewal_terms WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{next_cycle_number:2}]);
  expect((await db.query("SELECT status FROM public.subscription_successor_reservations_v2 WHERE operation_id=$1",[g.id])).rows).toEqual([{status:"consumed"}]);
  expect((await db.query("SELECT renewal_operation_id,renewal_operation_fingerprint FROM public.commerce_orders WHERE id=$1",[prepared.orderId])).rows).toEqual([{renewal_operation_id:null,renewal_operation_fingerprint:null}]);
  await db.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('synthetic-successor','3pl',true) ON CONFLICT DO NOTHING");
  await db.query("SELECT public.fulfillment_create_shipment($1,$2,'synthetic-successor','{}'::jsonb,$3)",[`shipment:${prepared.orderId}`,prepared.orderId,f.at]);
  const first=await store.markResumed(String(prepared.orderId));expect(first).toMatchObject({schemaVersion:2,caseKind:"successor",case:{state:"resumed",operation_id:g.id,order_id:prepared.orderId}});
  expect(await store.markResumed(String(prepared.orderId))).toEqual(first);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_delivery_alignment_arrivals WHERE shipment_id=(SELECT fulfillment_id FROM public.subscription_successor_operations_v2 WHERE id=$1)",[g.id])).rows).toEqual([{count:0}]);
});

it.each([
  ["lc10_successor_proposal_immutable", "proposal", "subscription_successor_proposals", "id", "created_at"],
  ["lc10_successor_operation_immutable", "operation", "subscription_successor_operations_v2", "id", "created_at"],
  ["lc10_successor_wait_immutable", "wait", "subscription_successor_wait_cases_v2", "operation_id", "opened_at"],
  ["lc10_successor_reservation_immutable", "reservation", "subscription_successor_reservations_v2", "operation_id", "created_at"],
] as const)("%s", async (_name, kind, table, key, column) => {
  const f = await createSuccessorJourney(pool);
  const id = kind === "proposal" ? f.proposalId : (await db.query(
    "SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at],
  )).rows[0].result.operationId;
  const before = (await db.query(`SELECT ${column} FROM public.${table} WHERE ${key}=$1`, [id])).rows;
  expect(before).toHaveLength(1);
  await db.query("SAVEPOINT immutable_field");
  await expect(db.query(`UPDATE public.${table} SET ${column}=${column}-interval '1 second' WHERE ${key}=$1`, [id]))
    .rejects.toMatchObject({ code: "23514", message: `successor_${kind}_immutable` });
  await db.query("ROLLBACK TO SAVEPOINT immutable_field");
  expect((await db.query(`SELECT ${column} FROM public.${table} WHERE ${key}=$1`, [id])).rows).toEqual(before);
});

it("lc10_successor_history_delete_refused", async () => {
  const f = await createSuccessorJourney(pool);
  await db.query("SAVEPOINT history_delete");
  await expect(db.query("DELETE FROM public.catalog_sku_successors WHERE predecessor_sku_id=$1 AND successor_sku_id=$2",
    [f.predecessor.sku, f.successor.sku])).rejects.toMatchObject({ code: "23514", message: "successor_history_immutable" });
  await db.query("ROLLBACK TO SAVEPOINT history_delete");
  expect((await db.query("SELECT publication_id FROM public.catalog_sku_successors WHERE predecessor_sku_id=$1 AND successor_sku_id=$2",
    [f.predecessor.sku, f.successor.sku])).rows).toEqual([{ publication_id: f.successor.declared.publicationId }]);
});

it("lc10_successor_native_graph_refuses_wrong_cycle", async () => {
  const f = await createSuccessorJourney(pool);
  const generation = (await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result.operationId;
  // An existing same-subscription cycle passes the FK, but its instant is wrong for this generation.
  await db.query("SAVEPOINT graph_cycle");
  await expect(db.query("UPDATE public.subscription_successor_operations_v2 SET cycle_id=$2 WHERE id=$1",
    [generation, f.header.activation_cycle_id])).rejects.toMatchObject({ code: "23514", message: "successor_native_graph_mismatch" });
  await db.query("ROLLBACK TO SAVEPOINT graph_cycle");
  expect((await db.query("SELECT cycle_id FROM public.subscription_successor_operations_v2 WHERE id=$1", [generation])).rows)
    .toEqual([{ cycle_id: null }]);
});

it("lc10_successor_generation_rejects_foreign_lineage", async () => {
  const f = await createSuccessorJourney(pool), other = await createSuccessorJourney(pool);
  const predecessor = (await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [other.caseId, other.proposalId, other.quoteHash, randomUUID(), other.client, other.at])).rows[0].result.operationId;
  const id = randomUUID();
  await db.query("SAVEPOINT foreign_lineage");
  await expect(db.query(`
    INSERT INTO public.subscription_successor_operations_v2(id, root_operation_id, proposal_id, predecessor_generation_id,
      subscription_id, scheduled_at, cycle_number, identity_key, operation_fingerprint, due_snapshot, cycle_snapshot,
      state, claim_token, claimed_by, claimed_at, lease_expires_at)
    SELECT $1, root.id, $2, $3, root.subscription_id, root.scheduled_at, root.cycle_number,
      root.identity_key || ':successor:' || $2::uuid::text, root.operation_fingerprint, root.cycle_snapshot, root.cycle_snapshot,
      'claimed', $1, 'synthetic', $4::timestamptz, $4::timestamptz + interval '5 minutes'
    FROM public.subscription_renewal_operations root WHERE root.id=$5
  `, [id, f.proposalId, predecessor, f.at, f.operationId]))
    .rejects.toMatchObject({ code: "23514", message: "successor_generation_lineage_changed" });
  await db.query("ROLLBACK TO SAVEPOINT foreign_lineage");
  expect((await db.query("SELECT id FROM public.subscription_successor_operations_v2 WHERE id=$1", [id])).rows).toEqual([]);
});

it.each([
  ["lc10_successor_outcomes_append_after_recovery", "append"],
  ["lc10_bind_settlement_duplicate_receipt", "duplicate"],
] as const)("%s", async (_name, observation) => {
  const f = await createSuccessorJourney(pool);
  const resolved = (await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result;
  const id = resolved.operationId;
  const at = (await db.query("SELECT expires_at + interval '1 second' AS at FROM public.subscription_successor_reservations_v2 WHERE operation_id=$1", [id])).rows[0].at;
  await db.query("SELECT public.fulfillment_expire_successor_renewals_v2(1000,$1)", [at]);
  const read = async () => (await db.query("SELECT operation_fingerprint, claim_token, outcomes FROM public.subscription_successor_operations_v2 WHERE id=$1", [id])).rows[0];
  const first = await read();
  expect(first.outcomes).toEqual([expect.objectContaining({ outcome: "refused", reason: "reservation_expired" })]);
  await db.query("SELECT public.subscription_stock_wait_recover_refusal_v2($1,$2,'fixture',$3)", [id, first.operation_fingerprint, at]);
  const recovered = await read();
  expect(recovered.outcomes).toEqual(first.outcomes);
  await db.query("SELECT public.commerce_prepare_successor_renewal_v2($1,$2,$3)", [id, recovered.claim_token, at]);
  const eventKey = randomUUID();
  const evidence = { operationFingerprint: first.operation_fingerprint, outcome: "succeeded", externalRef: `synthetic:${id}` };
  const settle = async () => (await db.query("SELECT public.commerce_settle_successor_renewal_v2($1,$2,$3,$4) AS result",
    [id, eventKey, evidence, at])).rows[0].result;
  const result = await settle(), terminal = await read();
  expect(terminal.outcomes).toEqual([...first.outcomes, expect.objectContaining({ eventKey, outcome: "succeeded" })]);
  expect(await settle()).toEqual(result);
  if (observation === "duplicate") {
    await db.query("UPDATE public.subscription_successor_operations_v2 SET outcomes=outcomes||jsonb_build_array(outcomes->-1) WHERE id=$1", [id]);
    await db.query("SAVEPOINT duplicate_settlement");
    await expect(settle()).rejects.toMatchObject({ code: "23505", message: "commerce_renewal_outcome_idempotency_conflict" });
    await db.query("ROLLBACK TO SAVEPOINT duplicate_settlement");
    expect((await read()).outcomes).toEqual([...terminal.outcomes, terminal.outcomes.at(-1)]);
  }
});

it("lc10_D6_paid_fact_generation_binding",async()=>{
  const f=await createSuccessorJourney(pool);
  const resolved=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const g=(await db.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1",[resolved.operationId])).rows[0];
  const prepared=(await db.query("SELECT public.commerce_prepare_successor_renewal_v2($1,$2,$3) AS result",[g.id,g.claim_token,f.at])).rows[0].result;
  await db.query("CREATE TEMP TABLE lc10_paid_fact_edges(actual jsonb,wrong_client jsonb,wrong_cycle jsonb,wrong_fingerprint jsonb) ON COMMIT DROP");
  const restore=await hook("public.commerce_order_emit_paid_notification()","PERFORM public.communication_event_paid_write(NEW.id);",`INSERT INTO pg_temp.lc10_paid_fact_edges VALUES(public.communication_paid_fact(NEW),
    public.communication_paid_fact(jsonb_populate_record(NULL::public.commerce_orders,to_jsonb(NEW)||jsonb_build_object('client_id',gen_random_uuid()))),
    public.communication_paid_fact(jsonb_populate_record(NULL::public.commerce_orders,to_jsonb(NEW)||jsonb_build_object('subscription_cycle_id',gen_random_uuid()))),
    public.communication_paid_fact(jsonb_populate_record(NULL::public.commerce_orders,to_jsonb(NEW)||jsonb_build_object('renewal_operation_fingerprint',repeat('a',64)))));`);
  try {
    await db.query("SELECT public.commerce_settle_successor_renewal_v2($1,$2,$3,$4)",[g.id,randomUUID(),{operationFingerprint:g.operation_fingerprint,outcome:"succeeded",externalRef:`synthetic:${g.id}`},f.at]);
    const probe=(await db.query("SELECT * FROM pg_temp.lc10_paid_fact_edges")).rows;
    expect(probe).toHaveLength(1);expect(probe[0].actual).toMatchObject({state:"complete",event:{data:{orderId:prepared.orderId,purchaseKind:"renewal"}}});
    for(const key of ["wrong_client","wrong_cycle","wrong_fingerprint"])expect(probe[0][key]).toEqual({state:"incomplete",reason:"renewal_evidence"});
  } finally { await restore(); }
});

it.each([
  "completed", "deferred", "wrong_cycle", "wrong_order", "wrong_fulfillment", "wrong_amount", "wrong_currency",
  "pending_payment", "failed_settlement", "active_hold", "missing_shipment", "retry",
] as const)(
  "lc10_mile_paid_fulfillment_%s", async observation => {
  const f = await createSuccessorJourney(pool);
  const resolved = (await pool.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
    [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result;
  const g = (await pool.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1", [resolved.operationId])).rows[0];
  const prepared = (await pool.query("SELECT public.commerce_prepare_successor_renewal_v2($1,$2,$3) AS result", [g.id, g.claim_token, f.at])).rows[0].result;
  await pool.query("SELECT public.commerce_settle_successor_renewal_v2($1,$2,$3,$4)",
    [g.id, randomUUID(), { operationFingerprint: g.operation_fingerprint, outcome: "succeeded", externalRef: `synthetic:${g.id}` }, f.at]);
  const paidEvent = await sourceEvent("commerce.order.paid", prepared.orderId);
  await pool.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('synthetic-fulfillment','3pl',true) ON CONFLICT DO NOTHING");
  const handoff = createPostgresPaidFulfillmentHandoffStore(pool, "synthetic-fulfillment");
  const store = createPostgresSuccessorStore({ withTransaction: transaction, codec: f.codec,
    previews: { prepare: async () => { throw Error("handoff_must_not_quote"); } } });
  let observations = 0;
  const handler = createOutboxOrderPaidFulfillmentHandler({
    fulfillmentPort: { async ensureFulfilledFromPaidOrder({ orderUuid, outboxEventId }) {
      if (observation === "deferred") return { kind: "snooze", reason: "synthetic-deferred" };
      if (observation === "missing_shipment") return { kind: "completed" };
      const requestKey = `synthetic-paid:${outboxEventId}`;
      const result = await handoff.ensureObligation({ requestKey, orderRef: orderUuid, paidFactRef: outboxEventId });
      await handoff.acknowledge({ requestKey, fulfillmentRef: result.fulfillmentRef });
      return { kind: "completed" };
    } },
    async realizationAdmitted(orderUuid) {
      observations++;
      if (observation === "retry" && observations === 1) throw Error("synthetic-interrupted");
      if (observation === "active_hold" && observations === 1) await pool.query(
        "INSERT INTO public.commerce_order_holds(order_id,reason) VALUES($1,'manual_support')", [orderUuid]);
      return store.markResumed(orderUuid);
    },
  });
  if (observation === "wrong_cycle") await pool.query("UPDATE public.subscription_successor_wait_cases_v2 SET cycle_id=$2 WHERE id=$1",
    [resolved.caseId, f.header.activation_cycle_id]);
  if (observation === "wrong_order" || observation === "wrong_fulfillment") {
    const foreign = await createSuccessorJourney(pool);
    const accepted = (await pool.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
      [foreign.caseId, foreign.proposalId, foreign.quoteHash, randomUUID(), foreign.client, foreign.at])).rows[0].result;
    const generation = (await pool.query("SELECT claim_token,operation_fingerprint FROM public.subscription_successor_operations_v2 WHERE id=$1",
      [accepted.operationId])).rows[0];
    const preparedForeign = (await pool.query("SELECT public.commerce_prepare_successor_renewal_v2($1,$2,$3) AS result",
      [accepted.operationId, generation.claim_token, foreign.at])).rows[0].result;
    await pool.query("SELECT public.commerce_settle_successor_renewal_v2($1,$2,$3,$4)", [accepted.operationId, randomUUID(),
      { operationFingerprint: generation.operation_fingerprint, outcome: "succeeded", externalRef: `synthetic:${accepted.operationId}` }, foreign.at]);
    if (observation === "wrong_order") await pool.query(
      "UPDATE public.subscription_successor_wait_cases_v2 SET order_id=$2 WHERE id=$1", [resolved.caseId, preparedForeign.orderId]);
    else {
      await pool.query("SELECT public.fulfillment_create_shipment($1,$2,'synthetic-fulfillment','{}'::jsonb,$3)",
        [randomUUID(), preparedForeign.orderId, foreign.at]);
      const shipment = (await pool.query("SELECT id FROM public.fulfillment_shipments WHERE order_id=$1", [preparedForeign.orderId])).rows[0].id;
      await pool.query("UPDATE public.subscription_successor_wait_cases_v2 SET fulfillment_id=$2 WHERE id=$1", [resolved.caseId, shipment]);
    }
  }
  const current = async () => (await pool.query("SELECT state,cycle_id,order_id,fulfillment_id FROM public.subscription_successor_wait_cases_v2 WHERE id=$1",
    [resolved.caseId])).rows[0];
  const before = await current();
  const deliver = () => handler.handle(paidEvent, new AbortController().signal);
  const overrides = {
    wrong_amount: "payment.amount_minor:=payment.amount_minor+1;", wrong_currency: "payment.currency_code:='USD';",
    pending_payment: "o.status:='pending_payment';", failed_settlement: "payment.status:='failed';",
  };
  if (Object.hasOwn(overrides, observation)) {
    const restore = await hook("public.subscription_stock_wait_mark_resumed_v2(uuid)",
      " SELECT * INTO payment FROM public.commerce_settlement_intents WHERE id=g.settlement_intent_id FOR UPDATE NOWAIT;",
      overrides[observation as keyof typeof overrides]);
    try {
      if (observation === "pending_payment") {
        expect(await deliver()).toMatchObject({ kind: "processed" });
        expect(await store.markResumed(prepared.orderId)).toBeNull();
      } else {
        expect(await deliver()).toMatchObject({ kind: "retry" });
        await expect(store.markResumed(prepared.orderId)).rejects.toMatchObject({ code: "22023", message: "stock_wait_realization_admission_missing" });
      }
      expect(await current()).toEqual(before);
    } finally { await restore(); }
    expect(await deliver()).toMatchObject({ kind: "processed" });
    return;
  }
  const first = await deliver();
  if (["deferred", "wrong_cycle", "wrong_order", "wrong_fulfillment", "missing_shipment"].includes(observation)) {
    expect(first.kind).toBe(observation === "deferred" ? "snooze" : "retry");
    expect(await current()).toEqual(before);
    expect(observations).toBe(observation === "deferred" ? 0 : 1);
    return;
  }
  if (observation === "retry" || observation === "active_hold") {
    expect(first).toMatchObject({ kind: "retry" });
    expect(await current()).toEqual(before);
    if (observation === "active_hold") await pool.query(
      "UPDATE public.commerce_order_holds SET status='released',released_at=$2 WHERE order_id=$1 AND reason='manual_support'",
      [prepared.orderId, f.at]);
  } else expect(first.kind).toBe("processed");
  expect((await deliver()).kind).toBe("processed");
  expect(await current()).toMatchObject({ state: "resumed", cycle_id: prepared.cycleId, order_id: prepared.orderId,
    fulfillment_id: expect.any(String) });
  const notices = await pool.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription_stock_wait.resumed.v2'",
    [resolved.caseId]);
  expect(notices.rows).toHaveLength(1);
});

it("withdrawal_reports_bound_subscriptions",async()=>{
  const f=await createSuccessorJourney(pool),impact=createPostgresCatalogWithdrawalImpact(db);
  const result=await impact.report(f.predecessor.sku);
  expect(result).toEqual((await db.query("SELECT public.catalog_bound_obligations_v2($1) AS result",[f.predecessor.sku])).rows[0].result);
  expect(result).toMatchObject({outcome:"complete",obligations:expect.arrayContaining([
    expect.objectContaining({family:"template",subscriptionId:f.subscription}),expect.objectContaining({family:"stock_wait",sourceId:f.caseId,subscriptionId:f.subscription})])});
});

it.each(["exact","missing","different"] as const)("lc10_publication_retained_pair_%s",async evidence=>{
  const f=await createSuccessorJourney(pool);
  const publication=createPostgresCatalogPublication({
    registry:f.registry,rules:f.rules,authorizeHuman:async()=>({ok:false}),
    readiness:async()=>({ready:true,reasons:[]}),globalReadiness:async()=>({ready:true,reasons:[]}),verifyMedia:async()=>false,
    transactions:{run:work=>transaction(connection=>work({query:async(sql,params)=>{
      const result=await connection.query(sql,params?[...params]:undefined);
      if(!sql.includes("FROM public.catalog_sku_successors")||evidence==="exact")return result;
      return {rows:evidence==="missing"?[]:result.rows.map(row=>({...row,successorOf:f.successor.sku}))};
    }}))},
  });
  const result=await publication.readbackV4(f.successor.declared);
  if(evidence==="exact")expect(result).toMatchObject({outcome:"page",schemaVersion:4,
    successors:[{successorSkuId:f.successor.sku,successorOf:f.predecessor.sku}]});
  else expect(result).toMatchObject({outcome:"dependency_unavailable",reason:"catalog_publication_post_state_mismatch"});
});

it("lc10_publication_commit_requires_observed_pair", async () => {
  const read = async () => (await pool.query(`SELECT
    (SELECT count(*) FROM public.catalog_publication_heads) AS heads,
    (SELECT count(*) FROM public.catalog_publications) AS publications,
    (SELECT count(*) FROM public.catalog_sku_successors) AS successors,
    (SELECT count(*) FROM public.outbox_events WHERE event_type='catalog.publication.committed') AS notices`)).rows;
  const before = await read();
  await expect(createSuccessorJourney(pool, { omitPublishedPair: true })).rejects.toThrow("catalog_publication_post_state_mismatch");
  expect(await read()).toEqual(before);
});

it.each(["exact","maximum","over_cap","missing","not_array","empty","duplicate","extra_field","outside_roster"] as const)(
  "lc10_publication_manifest_v4_%s",async change=>{
    const f=await createSuccessorJourney(pool);
    const original=(await db.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1",[f.successor.declared.publicationId])).rows[0];
    const manifest=JSON.parse(original.canonical_state),pair=manifest.successors[0];
    if(change==="missing")delete manifest.successors;
    if(change==="not_array")manifest.successors=pair;
    if(change==="empty")manifest.successors=[];
    if(change==="duplicate")manifest.successors=[pair,pair];
    if(change==="extra_field")manifest.successors=[{...pair,extra:true}];
    if(change==="outside_roster")manifest.successors=[{...pair,successorSkuId:randomUUID()}];
    if(change==="maximum"||change==="over_cap"){
      const ids=Array.from({length:change==="maximum"?9999:10000},(_,index)=>`00000000-0000-4000-8000-${index.toString(16).padStart(12,"0")}`);
      const reference=manifest.skus[0];
      manifest.skus=[...ids.map(skuId=>({...reference,skuId})),...manifest.skus];
      manifest.successors=[...ids.map(successorSkuId=>({successorOf:pair.successorOf,successorSkuId})),pair];
    }
    // These two fixtures target the native publication bound. The draft serializer has a smaller input cap.
    const canonical=change==="maximum"||change==="over_cap"?JSON.stringify(manifest):canonicalCatalogDraftJson(manifest);
    const digest=createHash("sha256").update(canonical).digest("hex"),publication=randomUUID();
    const insert=()=>db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,
      candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id)
      SELECT $2,product_id,3,id,draft_id,draft_revision,$2::uuid::text,candidate_digest,document_revision_id,$3,$4,actor_id
      FROM public.catalog_publications WHERE id=$1 RETURNING id`,[f.successor.declared.publicationId,publication,canonical,digest]);
    if(change==="exact"||change==="maximum")expect((await insert()).rows).toEqual([{id:publication}]);
    else{
      await db.query("SAVEPOINT invalid_manifest");
      await expect(insert()).rejects.toMatchObject({code:"23514",message:"catalog_publication_state_invalid"});
      await db.query("ROLLBACK TO SAVEPOINT invalid_manifest");
      expect((await db.query("SELECT id FROM public.catalog_publications WHERE id=$1",[publication])).rows).toEqual([]);
    }
  },
);

it("lc10_publication_pair_requires_declared_receipt",async()=>{
  const f=await createSuccessorJourney(pool,{continuation:true}),prior=f.continuation!;
  await db.query("SAVEPOINT false_pair");
  await expect(db.query("INSERT INTO public.catalog_sku_successors(predecessor_sku_id,successor_sku_id,publication_id) VALUES($1,$2,$3)",
    [prior.sku,f.successor.sku,f.successor.declared.publicationId]))
    .rejects.toMatchObject({code:"23514",message:"catalog_successor_publication_binding_changed"});
  await db.query("ROLLBACK TO SAVEPOINT false_pair");
  expect((await db.query("SELECT predecessor_sku_id FROM public.catalog_sku_successors WHERE successor_sku_id=$1",[f.successor.sku])).rows)
    .toEqual([{predecessor_sku_id:f.predecessor.sku}]);
});

it("stock_wait_notice_names_withdrawn_predecessor",async()=>{
  const f=await createSuccessorJourney(pool);
  const invoke=()=>db.query("SELECT public.subscription_successor_notice_v2($1,'legacy',$2) AS result",[f.caseId,f.withdrawalHead.publicationId]);
  const first=(await invoke()).rows[0].result;
  expect(first).toMatchObject({outcome:"handed_off",notices:[{messageKey:`subscription-predecessor-withdrawn:${f.withdrawalHead.publicationId}:${f.caseId}`,
    payload:{reason:"predecessor_withdrawn",operationId:f.operationId,subscriptionId:f.subscription,clientId:f.client,predecessors:[{skuId:f.predecessor.sku,skuCode:f.predecessor.code}]}}]});
  expect((await invoke()).rows[0].result).toEqual(first);
});

it("lc10_publication_notice_refuses_missing_lifecycle",async()=>{
  const f=await createSuccessorJourney(pool);
  const restore=await hook("public.subscription_successor_notice_v2(uuid,text,uuid)",
    " SELECT k.* INTO sku FROM public.catalog_skus k WHERE k.sku=line->>'sku';",
    " sku.publication_facts:=sku.publication_facts-'lifecycleState';");
  try{
    const before=await state();
    await expect(transaction(connection=>connection.query("SELECT public.subscription_successor_notice_v2($1,'legacy',$2)",
      [f.caseId,f.withdrawalHead.publicationId]))).rejects.toMatchObject({code:"55000",message:"catalog_obligation_evidence_unknown"});
    expect(await state()).toEqual(before);
  }finally{await restore();}
});

it("lc10_N2_immutable_operation_generation",async()=>{
  const f=await createSuccessorJourney(pool);
  const notice=()=>transaction(async connection=>(await connection.query("SELECT public.subscription_successor_notice_v2($1,'legacy',$2) AS result",[f.caseId,f.withdrawalHead.publicationId])).rows[0].result);
  const first=await notice();
  const generation=Number((await pool.query("SELECT claim_generation FROM public.subscription_renewal_operations WHERE id=$1",[f.operationId])).rows[0].claim_generation);
  await transaction(async connection=>{
    const at=(await connection.query("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
    const stock=createPostgresFulfillmentStockSyncPort(connection,{sourceKey:f.source,readLocalInventoryStock:async()=>[]});
    await stock.recordProviderStockCurrent({requestKey:`notice-recovery:${f.operationId}`,snapshot:{providerRef:"synthetic",collectedAt:at,sourceRevision:null,revisionSource:"collection",quantityKind:"snapshot",skuRef:f.predecessor.code,totalQuantity:100,forSaleQuantity:100,reservedOrUnavailableQuantity:0,syncRunId:f.subscription},inventoryClass:"sellable",lastSyncedAt:at,staleAfter:(await connection.query("SELECT clock_timestamp()+interval '1 day' AS until")).rows[0].until.toISOString()});
    expect((await connection.query("SELECT public.subscription_stock_wait_recover_refusal($1,$2,'notice-recovery',$3) AS result",[f.operationId,f.codec.fingerprint(f.frozen),at])).rows[0].result).toMatchObject({waiting:false});
  });
  expect(Number((await pool.query("SELECT claim_generation FROM public.subscription_renewal_operations WHERE id=$1",[f.operationId])).rows[0].claim_generation)).toBe(generation+1);
  const changed=structuredClone(f.predecessor.value);changed.product.sharedContent.catalogAction="revise";changed.product.sharedContent.presentation={label:"Synthetic editorial revision"};
  changed.publication.operations=[{op:"set_product_presentation",productSlug:changed.product.slug!,presentation:{label:"Synthetic editorial revision"}}];
  const head=await f.publish(changed,f.predecessor.draft,2,f.withdrawalHead);
  expect(head.revision).toBe(f.withdrawalHead.revision+1);
  expect(await notice()).toEqual(first);
  expect(first).toMatchObject({outcome:"handed_off",notices:[{messageKey:`subscription-predecessor-withdrawn:${f.withdrawalHead.publicationId}:${f.caseId}`,payload:{operationId:f.operationId}}]});
  expect((await pool.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.predecessor_withdrawn.v2'",[f.subscription])).rows).toEqual([{id:first.notices[0].noticeId}]);
});

async function transaction<T>(work:(db:PoolClient)=>Promise<T>,owner=pool):Promise<T> {
  const connection=await owner.connect();
  try {await connection.query("BEGIN");const result=await work(connection);await connection.query("COMMIT");return result;}
  catch(error){await connection.query("ROLLBACK");throw error;}finally{connection.release();}
}
async function sourceEvent(eventType:string,aggregateId:string):Promise<OutboxEventRow> {
  return (await pool.query(`SELECT to_jsonb(e) AS event FROM public.outbox_events e WHERE event_type=$1 AND aggregate_id=$2
    ORDER BY (CASE WHEN event_type='catalog.publication.committed' THEN (payload#>>'{head,revision}')::integer END) DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,[eventType,aggregateId])).rows[0]?.event;
}

it("lc10_handoff_before_ack",async()=>{
  const f=await createSuccessorJourney(pool),sent:string[]=[];
  let recipientAvailable=false,transportAvailable=false;
  const receipts=createPostgresTransactionalDeliveryStore({connectionString});
  const engine=createTransactionalDelivery({store:receipts,delivery:createCapturedTransactionalDelivery({outcome:command=>{
    if(!transportAvailable)return {state:"failed"};sent.push(command.idempotencyKey);return {state:"accepted"};
  }})});
  const notices=createPostgresSuccessorNotices({withTransaction:transaction,impact:createPostgresCatalogWithdrawalImpact(pool),recipient:async clientId=>recipientAvailable?{recipientRef:clientId,locale:"en"}:null,
    delivery:{enqueue:async descriptor=>{
      const prior=await receipts.readReceipt(descriptor.messageKey);
      const receipt=await engine.send({idempotencyKey:descriptor.messageKey,recipientReference:descriptor.recipientRef,templateReference:descriptor.templateSlug});
      if(receipt.state!=="accepted")throw Error("subscription_notice_delivery_unavailable");
      return {notificationId:receipt.deliveryReference,replayed:prior?.state==="accepted"};
    }}});
  try {
    const opened=await sourceEvent("subscription_stock_wait.opened.v1",f.caseId);
    expect(await notices.handle(opened)).toEqual({kind:"processed"});
    const handoff=await sourceEvent("subscription.predecessor_withdrawn.v2",f.subscription);
    expect(handoff).toMatchObject({idempotency_key:`subscription-predecessor-withdrawn:${f.withdrawalHead.publicationId}:${f.caseId}`});
    expect(await receipts.readReceipt(handoff.idempotency_key)).toBeNull();
    expect(await notices.handle(handoff)).toEqual({kind:"retry",reason:"subscription_notice_recipient_unresolved"});
    recipientAvailable=true;expect((await notices.handle(handoff)).kind).toBe("retry");expect(sent).toEqual([]);
    transportAvailable=true;expect(await notices.handle(handoff)).toEqual({kind:"processed"});
    // No source acknowledgement: a restarted worker repeats both routes and the handoff.
    expect(await notices.handle(opened)).toEqual({kind:"processed"});
    expect(await notices.handle(await sourceEvent("catalog.publication.committed",f.predecessor.product))).toEqual({kind:"processed"});
    expect(await notices.handle(handoff)).toEqual({kind:"processed",detail:{dedupe:"email_already_sent"}});expect(sent).toEqual([handoff.idempotency_key]);
    expect(await receipts.readReceipt(handoff.idempotency_key)).toMatchObject({state:"accepted"});
    expect((await pool.query("SELECT id FROM public.outbox_events WHERE event_type='subscription.predecessor_withdrawn.v2' AND aggregate_id=$1",[f.subscription])).rows).toEqual([{id:handoff.id}]);
    const resolved=await transaction(async connection=>(await connection.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result);
    expect(resolved.status).toBe("applied");
    expect(await notices.handle(opened)).toEqual({kind:"processed"});
    expect(await notices.handle(handoff)).toEqual({kind:"processed",detail:{dedupe:"email_already_sent"}});expect(sent).toEqual([handoff.idempotency_key]);
  } finally {await receipts.close();}
});

it.each([
  ["lc10_notice_contract_invalid","contract",{kind:"discard",reason:"stock_wait_notice_contract_invalid"}],
  ["lc10_notice_source_deficits_invalid","deficits",{kind:"discard",reason:"stock_wait_notice_contract_invalid"}],
  ["lc10_parity__LC10_09473__payload__kills_delete_outermost_validation_call_only","sku",{kind:"discard",reason:"stock_wait_notice_contract_invalid"}],
  ["lc10_parity__LC10_09474__payload__kills_delete_outermost_validation_call_only","negative",{kind:"discard",reason:"stock_wait_notice_contract_invalid"}],
  ["lc10_read_notice_required_positive","requiredUnits",{kind:"discard",reason:"stock_wait_notice_contract_invalid"}],
  ["lc10_read_notice_reserved_integral","reservedUnits",{kind:"discard",reason:"stock_wait_notice_contract_invalid"}],
  ["lc10_read_notice_available_nonnegative","availableUnits",{kind:"discard",reason:"stock_wait_notice_contract_invalid"}],
  ["lc10_read_notice_missing_integral","missingUnits",{kind:"discard",reason:"stock_wait_notice_contract_invalid"}],
  ["lc10_read_notice_sku_nonblank","blankSku",{kind:"discard",reason:"stock_wait_notice_contract_invalid"}],
  ["lc10_read_notice_label_nonblank","blankLabel",{kind:"retry",reason:"stock_wait_notice_contract_invalid"}],
  ["lc10_notice_client_binding","clientId",{kind:"retry",reason:"stock_wait_notice_case_mismatch"}],
  ["lc10_notice_subscription_binding","subscriptionId",{kind:"retry",reason:"stock_wait_notice_case_mismatch"}],
  ["lc10_notice_case_binding","caseId",{kind:"retry",reason:"stock_wait_notice_case_mismatch"}],
  ["lc10_notice_aggregate_binding","aggregate",{kind:"retry",reason:"stock_wait_notice_case_mismatch"}],
  ["lc10_notice_resume_milestone","resumed",{kind:"retry",reason:"stock_wait_resume_milestone_missing"}],
  ["lc10_notice_obsolete_state","closed",{kind:"processed",detail:{skipped:"stock_wait_notice_obsolete"}}],
  ["lc10_notice_obsolete_relevance","cancelled",{kind:"processed",detail:{skipped:"stock_wait_notice_obsolete"}}],
  ["lc10_notice_current_deficits_empty","empty",{kind:"discard",reason:"stock_wait_notice_missing_deficits"}],
  ["lc10_notice_recipient_unresolved","recipient",{kind:"retry",reason:"stock_wait_notice_recipient_unresolved"}],
] as const)("%s",async(_name,mode,expected)=>{
  const f=await createSuccessorJourney(pool);
  let row=await sourceEvent("subscription_stock_wait.started",f.caseId);
  const invalidDeficit={requiredUnits:0,reservedUnits:0.5,availableUnits:-1,missingUnits:0.5,blankSku:" "};
  if(["contract","deficits","sku","negative","clientId","subscriptionId","caseId","aggregate",...Object.keys(invalidDeficit)].includes(mode)){
    const payload={...row.payload};
    if(mode==="contract")payload.caseId="invalid";
    else if(mode==="deficits")payload.deficits=null;
    else if(mode==="sku"||mode==="negative")payload.deficits=[{...(row.payload.deficits as Record<string,unknown>[])[0]!,[mode==="sku"?"sku":"missingUnits"]:mode==="sku"?"":-1}];
    else if(Object.hasOwn(invalidDeficit,mode))payload.deficits=[{...(row.payload.deficits as Record<string,unknown>[])[0]!,
      [mode==="blankSku"?"sku":mode]:invalidDeficit[mode as keyof typeof invalidDeficit]}];
    else if(mode!=="aggregate")payload[mode]=randomUUID();
    row=(await pool.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
      VALUES('subscription_stock_wait',$1,'subscription_stock_wait.started',$2,$3::jsonb,'{}') RETURNING to_jsonb(outbox_events) AS event`,
    [mode==="aggregate"?randomUUID():f.caseId,`notice-boundary:${randomUUID()}`,payload])).rows[0].event;
  }
  if(mode==="resumed"){
    await pool.query("SELECT public.subscription_stock_wait_enqueue(c,'resumed') FROM public.subscription_stock_wait_cases c WHERE id=$1",[f.caseId]);
    row=await sourceEvent("subscription_stock_wait.resumed",f.caseId);
  }
  if(mode==="closed")await pool.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]);
  if(mode==="cancelled")await pool.query("SELECT public.subscription_command_apply($1,$2,$3,$4,'cancel','{}'::jsonb,$5)",[f.principal,f.client,randomUUID(),f.subscription,f.at]);
  if(mode==="empty")await pool.query("UPDATE public.subscription_stock_wait_cases SET deficits='[]' WHERE id=$1",[f.caseId]);
  let deliveries=0;
  const notices=createPostgresSuccessorNotices({withTransaction:work=>transaction(connection=>work({query:async(sql,values)=>{
    const result=await connection.query(sql,values?[...values]:undefined);
    if(mode==="blankLabel"&&sql.includes("SELECT id,sku,title FROM public.catalog_skus"))return {rows:result.rows.map(item=>({...item,title:" "}))};
    return result;
  }})),impact:createPostgresCatalogWithdrawalImpact(pool),recipient:async()=>mode==="recipient"?null:{recipientRef:f.client,locale:"en"},
    delivery:{enqueue:async()=>{deliveries++;return {notificationId:randomUUID(),replayed:false};}}});
  expect(await notices.handle(row)).toEqual(expected);expect(deliveries).toBe(0);
});

it.each(["started","resumed","resumed_empty","resumed_omitted","successor_started","successor_resumed"] as const)("lc10_notice_%s_freezes_rendering_and_dedupes_accepted",async mode=>{
  const f=await createSuccessorJourney(pool);
  if(mode==="resumed")await pool.query("SELECT public.subscription_stock_wait_enqueue(c,'resumed') FROM public.subscription_stock_wait_cases c WHERE id=$1",[f.caseId]);
  const successor=mode.startsWith("successor_"), eventKind=mode.endsWith("started")?"started":"resumed";
  let caseId=f.caseId;
  if(successor){
    if(eventKind==="started")await pool.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=0 WHERE source_key=$1 AND sku=$2",[f.source,f.successor.code]);
    const resolved=(await pool.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
      [f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
    caseId=resolved.caseId;
    if(eventKind==="resumed"){
      const g=(await pool.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1",[resolved.operationId])).rows[0];
      const prepared=(await pool.query("SELECT public.commerce_prepare_successor_renewal_v2($1,$2,$3) AS result",[g.id,g.claim_token,f.at])).rows[0].result;
      await pool.query("SELECT public.commerce_settle_successor_renewal_v2($1,$2,$3,$4)",
        [g.id,randomUUID(),{operationFingerprint:g.operation_fingerprint,outcome:"succeeded",externalRef:`synthetic:${g.id}`},f.at]);
      await pool.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('notice-fixture','3pl',true) ON CONFLICT DO NOTHING");
      await pool.query("SELECT public.fulfillment_create_shipment($1,$2,'notice-fixture','{}'::jsonb,$3)",[`notice-shipment:${caseId}`,prepared.orderId,f.at]);
      await pool.query("SELECT public.subscription_stock_wait_mark_resumed_v2($1)",[prepared.orderId]);
    }
  }
  let row=await sourceEvent(`subscription_stock_wait.${eventKind}${successor?".v2":""}`,caseId);
  let available=true,transport=false,copy="first",locale="en",caseReads=0;
  const attempts:unknown[]=[],descriptors:SubscriptionLifecycleMessageDescriptor[]=[];
  const receipts=createPostgresTransactionalDeliveryStore({connectionString});
  let frozen:Record<string,unknown>={};
  const engine=createTransactionalDelivery({store:receipts,delivery:createCapturedTransactionalDelivery({outcome:()=>{
    attempts.push(structuredClone(frozen));return {state:transport?"accepted":"failed"};
  }})});
  const notices=createPostgresSuccessorNotices({withTransaction:work=>transaction(db=>work({query:async(sql,values)=>{
    if(sql.includes("subscription_stock_wait_read_v2"))caseReads++;return db.query(sql,values?[...values]:undefined);
  }})),impact:createPostgresCatalogWithdrawalImpact(pool),recipient:async()=>available?{recipientRef:`recipient:${copy}`,locale}:null,
  delivery:{enqueue:async()=>{throw Error("stock_wait_must_bind_before_egress");}},
  stockWaitDelivery:{
    async render(descriptor){
      descriptors.push(structuredClone(descriptor));
      return {from:"sender@example.invalid",to:descriptor.recipientRef,subject:`Synthetic ${copy}`,html:`<p>${descriptor.locale}:${JSON.stringify(descriptor.fact)}</p>`};
    },
    async send({messageKey,templateSlug,message}){
      const table=successor?"subscription_successor_wait_cases_v2":"subscription_stock_wait_cases";
      expect((await pool.query(`SELECT notice_messages->$2::text AS frozen FROM public.${table} WHERE id=$1`,[caseId,row.id])).rows[0].frozen).toEqual(message);
      frozen=message;
      const result=await engine.send({idempotencyKey:messageKey,recipientReference:message.to,templateReference:templateSlug,
        accessGrantReference:createHash("sha256").update(JSON.stringify(message)).digest("hex")});
      if(result.state!=="accepted")throw Error("stock_wait_notice_delivery_unavailable");
    },
  }});
  try{
    if(!successor&&mode!=="started"){
      if(mode==="resumed")expect(await notices.handle(row)).toEqual({kind:"retry",reason:"stock_wait_resume_milestone_missing"});
      const at=(await pool.query("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
      const stock=createPostgresFulfillmentStockSyncPort(pool,{sourceKey:f.source,readLocalInventoryStock:async()=>[]});
      await stock.recordProviderStockCurrent({requestKey:`notice-resume:${f.caseId}`,snapshot:{providerRef:"synthetic",collectedAt:at,sourceRevision:null,revisionSource:"collection",quantityKind:"snapshot",skuRef:f.predecessor.code,totalQuantity:100,forSaleQuantity:100,reservedOrUnavailableQuantity:0,syncRunId:f.subscription},inventoryClass:"sellable",lastSyncedAt:at,staleAfter:(await pool.query("SELECT clock_timestamp()+interval '1 day' AS until")).rows[0].until.toISOString()});
      await pool.query("SELECT public.subscription_stock_wait_recover_refusal($1,$2,'notice-resume',$3)",[f.operationId,f.codec.fingerprint(f.frozen),at]);
      const token=(await pool.query("SELECT claim_token FROM public.subscription_renewal_operations WHERE id=$1",[f.operationId])).rows[0].claim_token;
      const prepared=(await pool.query("SELECT public.commerce_prepare_subscription_renewal($1,$2,$3) AS result",[f.operationId,token,at])).rows[0].result;
      const external=`notice-paid:${f.caseId}`;
      await pool.query("SELECT public.commerce_acknowledge_subscription_renewal_attempt($1,$2,$3,$4)",[f.operationId,f.codec.fingerprint(f.frozen),external,at]);
      await pool.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'succeeded',$4,NULL,$5)",[f.operationId,randomUUID(),f.codec.fingerprint(f.frozen),external,at]);
      await pool.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('notice-fixture','3pl',true) ON CONFLICT DO NOTHING");
      await pool.query("SELECT public.fulfillment_create_shipment($1,$2,'notice-fixture','{}'::jsonb,$3)",[`notice-shipment:${f.caseId}`,prepared.orderId,at]);
      await pool.query("SELECT public.subscription_stock_wait_mark_resumed($1)",[prepared.orderId]);
      expect((await pool.query("SELECT state,deficits FROM public.subscription_stock_wait_cases WHERE id=$1",[f.caseId])).rows).toEqual([{state:"resumed",deficits:[]}]);
      if(mode!=="resumed"){
        row=await sourceEvent("subscription_stock_wait.resumed",f.caseId);expect(row.payload.deficits).toEqual([]);
        if(mode==="resumed_omitted"){
          const payload={...row.payload};delete payload.deficits;
          row=(await pool.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
            VALUES('subscription_stock_wait',$1,'subscription_stock_wait.resumed',$2,$3::jsonb,'{}') RETURNING to_jsonb(outbox_events) AS event`,[f.caseId,`notice-omitted:${randomUUID()}`,payload])).rows[0].event;
        }
      }
    }
    expect((await notices.handle(row)).kind).toBe("retry");expect(attempts).toHaveLength(1);
    expect(descriptors[0]!.fact).toMatchObject({kind:`stock_wait_${eventKind}`,deficits:["resumed_empty","resumed_omitted","successor_resumed"].includes(mode)
      ?[]:[{sku:successor?f.successor.code:f.predecessor.code,missing:1}]});
    copy="changed";locale="pl";transport=true;
    expect(await notices.handle(row)).toEqual({kind:"processed"});expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
    expect(descriptors).toHaveLength(1);
    available=false;const readBefore=caseReads;
    expect(await notices.handle(row)).toEqual({kind:"processed",detail:{dedupe:"email_already_sent"}});expect(caseReads).toBe(readBefore);expect(attempts).toHaveLength(2);
    expect((await receipts.readReceipt(row.idempotency_key))?.state).toBe("accepted");
  }finally{await receipts.close();}
});

it.each([
  ["source", { kind: "discard", reason: "stock_wait_notice_contract_invalid" }],
  ["operation", { kind: "retry", reason: "stock_wait_notice_case_mismatch" }],
  ["schedule", { kind: "retry", reason: "stock_wait_notice_case_mismatch" }],
  ["missing_transport", { kind: "retry", reason: "stock_wait_notice_binding_unavailable" }],
  ["invalid_rendering", { kind: "retry", reason: "stock_wait_notice_message_invalid" }],
  ["missing_binding", { kind: "retry", reason: "stock_wait_notice_binding_unavailable" }],
  ["complete", { kind: "processed" }],
] as const)("lc10_notice_v2_freeze_boundary_%s", async (change, expected) => {
  const f = await createSuccessorJourney(pool);
  const resolved = await transaction(async connection => {
    await connection.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=0 WHERE source_key=$1 AND sku=$2",
      [f.source, f.successor.code]);
    return (await connection.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",
      [f.caseId, f.proposalId, f.quoteHash, randomUUID(), f.client, f.at])).rows[0].result;
  });
  const row = await sourceEvent("subscription_stock_wait.started.v2", resolved.caseId);
  if (change === "source") row.metadata.source = "other";
  if (change === "operation") row.payload.operationId = f.operationId;
  if (change === "schedule") row.payload.scheduledAt = (await pool.query(`SELECT
    to_char(($1::timestamptz+interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`,
    [row.payload.scheduledAt])).rows[0].value;
  if (change === "operation" || change === "schedule") await pool.query("UPDATE public.outbox_events SET payload=$2 WHERE id=$1", [row.id, row.payload]);
  let sent = 0;
  const notices = createPostgresSuccessorNotices({
    withTransaction: work => transaction(connection => work({ async query(sql, params) {
      if (change === "missing_binding" && sql.includes("SET notice_messages=jsonb_set")) return { rows: [] };
      return connection.query(sql, params ? [...params] : undefined);
    }})),
    impact: createPostgresCatalogWithdrawalImpact(pool),
    recipient: async () => ({ recipientRef: "recipient@example.invalid", locale: "en" }),
    delivery: { async enqueue() { throw Error("unexpected_delivery"); } },
    stockWaitDelivery: change === "missing_transport" ? undefined : {
      async render() { return { from: "sender@example.invalid", to: "recipient@example.invalid",
        subject: change === "invalid_rendering" ? " " : "Synthetic stock notice", html: "<p>Synthetic body</p>" }; },
      async send() { sent++; },
    },
  });
  expect(await notices.handle(row)).toEqual(expected);
  expect(sent).toBe(change === "complete" ? 1 : 0);
  expect((await pool.query("SELECT notice_messages ? $2 AS bound FROM public.subscription_successor_wait_cases_v2 WHERE id=$1",
    [resolved.caseId, row.id])).rows).toEqual([{ bound: change === "complete" }]);
});

it("lc10_stock_wait_catalogue_projection", async () => {
  const f = await createSuccessorJourney(pool);
  const stockWait = createPostgresStockWaitStore({ executor: db, withTransaction: work => work(db), codec: f.codec, workerId: "fixture" });
  const read = () => stockWait.readFrozenCase({ caseId: f.caseId, cycleId: null, orderId: null, paymentId: null,
    engineIdempotencyKey: f.codec.identity(f.frozen) });
  expect((await read())?.deficits).toEqual([{ skuId: f.predecessor.sku, sku: f.predecessor.code, displayName: "Synthetic article",
    size: null, required: 1, reserved: 0, available: 0, missing: 1 }]);
  await db.query(`UPDATE public.subscription_stock_wait_cases
    SET deficits = jsonb_set(deficits, '{0,sku}', '"missing-sku"') WHERE id=$1`, [f.caseId]);
  await expect(read()).rejects.toThrow("stock_wait_catalog_sku_missing");
});

it("lc10_notice_started_uses_current_deficits_not_queued_empty_observation",async()=>{
  const f=await createSuccessorJourney(pool,{creator:"recover",recoveryStock:100});
  await pool.query("SELECT public.subscription_stock_wait_enqueue(c,'started') FROM public.subscription_stock_wait_cases c WHERE id=$1",[f.caseId]);
  const row=await sourceEvent("subscription_stock_wait.started",f.caseId);expect(row.payload.deficits).toEqual([]);
  const recorded=(await pool.query("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
  const at=(await pool.query("SELECT expires_at+interval '1 second' AS at FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1",[f.operationId])).rows[0].at.toISOString();
  const stock=createPostgresFulfillmentStockSyncPort(pool,{sourceKey:f.source,readLocalInventoryStock:async()=>[]});
  await stock.recordProviderStockCurrent({requestKey:`notice-shortage:${f.caseId}`,snapshot:{providerRef:"synthetic",collectedAt:recorded,sourceRevision:null,revisionSource:"collection",quantityKind:"snapshot",skuRef:f.predecessor.code,totalQuantity:0,forSaleQuantity:0,reservedOrUnavailableQuantity:0,syncRunId:f.subscription},inventoryClass:"sellable",lastSyncedAt:recorded,staleAfter:(await pool.query("SELECT clock_timestamp()+interval '1 day' AS until")).rows[0].until.toISOString()});
  expect((await pool.query("SELECT public.subscription_stock_wait_recover_refusal($1,$2,'notice-current',$3) AS result",[f.operationId,f.codec.fingerprint(f.frozen),at])).rows[0].result).toMatchObject({waiting:true,caseId:f.caseId});
  const delivered:SubscriptionLifecycleMessageDescriptor[]=[];
  const notices=createPostgresSuccessorNotices({
    withTransaction:transaction,impact:createPostgresCatalogWithdrawalImpact(pool),recipient:async()=>({recipientRef:f.client,locale:"en"}),
    delivery:{async enqueue(){throw Error("stock_wait_must_bind_before_egress");}},
    stockWaitDelivery:{
      async render(descriptor){
        delivered.push(descriptor);
        return {from:"sender@example.invalid",to:"recipient@example.invalid",subject:"Synthetic stock notice",html:"<p>Synthetic body</p>"};
      },
      async send(){},
    },
  });
  expect(await notices.handle(row)).toEqual({kind:"processed"});
  expect(delivered).toMatchObject([{fact:{kind:"stock_wait_started",deficits:[{sku:f.predecessor.code,missing:1}]}}]);
});

it.each(["opened_first","publication_first"])("lc10_N3_shared_completion",async order=>{
  const f=await createSuccessorJourney(pool),observer=await pool.connect(),pause=await gate(observer),oPid=await pid(observer);
  const notices=createPostgresSuccessorNotices({withTransaction:transaction,impact:createPostgresCatalogWithdrawalImpact(pool),recipient:async()=>null,
    delivery:{enqueue:async()=>{throw Error("source_must_only_handoff");}}});
  const opened=await sourceEvent("subscription_stock_wait.opened.v1",f.caseId),publication=await sourceEvent("catalog.publication.committed",f.predecessor.product);
  const firstSource=order==="opened_first"?opened:publication,secondSource=order==="opened_first"?publication:opened;
  const restore=await hook("public.subscription_successor_notice_v2(uuid,text,uuid)","SELECT * INTO s FROM public.subscriptions WHERE id=sub FOR UPDATE NOWAIT;",pause.sql);
  let first:Promise<unknown>|undefined;
  try {
    first=notices.handle(firstSource);
    await expect.poll(async()=>(await observer.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE '%subscription_successor_notice_v2%'",[oPid])).rows[0].count).toBe(1);
    const before=await state();
    expect(await notices.handle(secondSource)).toEqual({kind:"retry",reason:"lc10_commerce_busy"});expect(await state()).toEqual(before);
    await pause.release();expect(await first).toEqual({kind:"processed"});
    const handoff=await sourceEvent("subscription.predecessor_withdrawn.v2",f.subscription);
    expect(await notices.handle(secondSource)).toEqual({kind:"processed"});
    expect((await sourceEvent("subscription.predecessor_withdrawn.v2",f.subscription)).id).toBe(handoff.id);
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.predecessor_withdrawn.v2'",[f.subscription])).rows).toEqual([{count:1}]);
  } finally {await pause.release();await first;await restore();observer.release();}
});

/** Existing journey resources, with real publication, frozen wait and consent owners. */
async function createSuccessorJourney(pool: Pool, options: { creator?: "admit" | "recover"; recoveryStock?: number;lane?:"classic"|"exact"|"sized";ordinary?:boolean;continuation?:boolean;profile?:"strength"|"shade";retainedExclusions?:unknown;omitPublishedPair?:boolean;
  historicalBinding?:HistoricalSuccessorProtocolBinding;applyLegacyAlias?:boolean;quotedQuantity?:number } = {}) {
  const profile=options.profile;
  const definition:CatalogProductTypeDefinition={ key:profile?`example:article-${profile}`:"example:article",version:1,
    units:[{code:"openlup:g",dimension:"mass",integral:false,...(profile?{factor:{canonicalUnit:"openlup:g",unscaled:"1",scale:0}}:{})}],netContentUnits:["openlup:g"],
    dimensions:profile==="strength"?[{key:profile,kind:"quantity",dimension:"mass",units:["openlup:g"]}]:profile?[{key:profile,kind:"choice",values:["a","b"]}]:[],
    axes:profile?[{key:profile,attributeKey:profile}]:[],
    ...(profile?{attributes:[{key:profile,scope:"variant",required:false,cardinality:{min:0,max:1},filterable:false,facetable:false,public:true,displayOrder:0,labels:{},
      valueType:profile==="strength"?{kind:"quantity",dimension:"mass",units:["openlup:g"]}:{kind:"enum",values:[{id:"a"},{id:"b"}]} }]}:{}),
    validatorRef:`sha256:${"a".repeat(64)}`,validateContent:()=>[] };
  const registry=createCatalogProductTypeRegistry([definition]);
  const rules={canonicalizeDocument:canonicalCatalogDraftJson,deriveSkuFacts:(document:unknown)=>({derived:(document as {derived:number}).derived}),validateProduct:()=>[],classifySkuChange:()=>"compatible" as const};
  const hash = (value: string) => createHash("sha256").update(value).digest("hex"), admin = randomUUID();
  const rpc = async (db: PgQueryExecutor, name: string, args: unknown[]) =>
    (await db.query(`SELECT public.${name}(${args.map((_,index) => `$${index + 1}`).join(",")}) AS result`,args)).rows[0]!.result as Record<string, unknown>;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await installCatalogDefinitions(db,{ id: profile?`example:successor-${profile}`:"example:successor",namespace: "example",version: 1,openlupRange: "0.44.x",capabilities: { publish: false },types: [definition],taxClasses: [] });
    await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)",[admin,`${admin}@example.invalid`]);
    await db.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())",[admin]);
    await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','1') ON CONFLICT(key) DO NOTHING");
    async function publishOn(db:PoolClient,payload:CatalogDraftPayloadV4|CatalogDraftPayloadV5,draftId:string,revision:number,head:CatalogHeadRef|null) {
      const authority = createPostgresCatalogPublication({ registry,rules,authorizeHuman: async () => ({ ok: true as const,userId: admin,role: "admin",isMachineActor: false }),
      readiness: async () => ({ ready: true,reasons: [] }),globalReadiness: async () => ({ ready: true,reasons: [] }),verifyMedia: async () => false,
      transactions: { async run(work) {
        await db.query("SAVEPOINT publisher");
        try {
          const result = await work(options.omitPublishedPair ? { async query(sql, params) {
            const observed = await db.query(sql, params ? [...params] : undefined);
            return sql.includes('SELECT successor_sku_id AS "successorSkuId"') ? { rows: [] } : observed;
          }} : db);
          await db.query("RELEASE SAVEPOINT publisher");
          return result;
        } catch (error) { await db.query("ROLLBACK TO SAVEPOINT publisher"); throw error; }
      } } });
      const actor = (await authority.authorize(null))!;
      const command = { schemaVersion: payload.schemaVersion,action: revision ? "revise" : "create",draftId,commandKey: `draft:${revision}`,expectedRevision: revision,payload }, canonical = canonicalCatalogDraftJson(command);
      expect(await rpc(db,"catalog_draft_apply",[canonical,hash(canonical),"operator:synthetic"])).toMatchObject({ outcome: "committed" });
      const candidateRef = `v1:${draftId}@${revision + 1}/${head ? `${head.publicationId}@${head.revision}` : "unpublished"}`;
      const candidateDigest = hash('["catalog-candidate",1,'+canonicalCatalogDraftJson(payload)+','+canonicalCatalogDraftJson([{ ...payload.product.type,definitionDigest: catalogDefinitionDigest(definition) }])+','+canonicalCatalogDraftJson(head)+']');
      expect(await authority.decision({ schemaVersion: 2,action: "approve",productId: payload.product.id,commandKey: `approve:${revision}`,candidateRef,candidateDigest,reason: "Exact synthetic candidate" },actor)).toMatchObject({ outcome: "committed" });
      const result = await authority.publish({ productId: payload.product.id,commandKey: `publish:${revision}`,candidateRef,candidateDigest,expectedHead: head,changes: [] },actor);
      if (!("receipt" in result)) throw new Error(JSON.stringify(result));
      return result.receipt.head;
    }
    const publish=(payload:CatalogDraftPayloadV4|CatalogDraftPayloadV5,draftId:string,revision:number,head:CatalogHeadRef|null)=>publishOn(db,payload,draftId,revision,head);
    async function article(predecessor?: string) {
      const product = randomUUID(),sku = randomUUID(),draft = randomUUID(),document = randomUUID(),code = `ARTICLE-${sku}`,slug = `article-${product}`;
      const digits=(BigInt(`0x${sku.replaceAll("-","").slice(0,14)}`)%1_000_000_000_000n).toString().padStart(12,"0");
      const gtin=digits+String((10-[...digits].reduce((sum,digit,index)=>sum+Number(digit)*(index%2?3:1),0)%10)%10);
      const content={schemaVersion:1,derived:12},canonicalText=canonicalCatalogDraftJson(content),documentDigest=hash(canonicalText);
      const authoredFacts={skuCode:code,title:"Synthetic article",minQuantity:1,isAddon:false,facts:{derived:12}};
      const optionValues:Record<string,CatalogOptionValue>=profile==="strength"?{strength:{kind:"quantity",value:{dimension:"mass",unit:"openlup:g",unscaled:predecessor?"20":"10",scale:0}}}
        :profile?{shade:{kind:"choice",value:predecessor?"b":"a"}}:{};
      const value:CatalogDraftPayloadV4={schemaVersion:4,product:{id:product,type:{key:definition.key,version:1},dimensions:definition.dimensions.map(d=>d.key),slug,primarySkuId:sku,
        documentRevision:{id:document,productId:product,revisionNo:1,schemaId:"example:document.v1",documentRef:"example:document",sourceRef:"example:source",digest:documentDigest},
        sharedContent:{schemaVersion:1,catalogAction:"create",document:content,presentation:{},publicationSkus:[authoredFacts],requestedModes:[{skuCode:code,modes:[]}],offerMemberships:[]}},
        skus:[{id:sku,productId:product,code,options:optionValues,netContent:{dimension:"mass",unit:"openlup:g",unscaled:"100",scale:0},identifiers:[{scheme:"gs1:gtin",issuer:"example",value:gtin,packagingLevel:"unit"}]}],
        publication:{kind:"release",evidence:{},operations:[{op:"create_product",productId:product,productSlug:slug,name:"Synthetic article"},
          {op:"register_document_revision",productSlug:slug,revisionId:document,revisionNo:1,documentRef:"example:document",sourceRef:"example:source",canonicalText,digest:documentDigest,provenance:{source:"current_draft"}},
          {op:"move_document_pointer",productSlug:slug,documentRevisionNo:1},{op:"create_sku",productSlug:slug,documentRevisionNo:1,skuId:sku,...authoredFacts},
          {op:"create_identifier",skuCode:code,scheme:"gs1:gtin",issuer:"example",value:gtin,packagingLevel:"unit",quantity:1,isPrimary:true,label:null,sourceRef:null},
          {op:"set_primary_sku",productSlug:slug,skuCode:code},{op:"set_product_presentation",productSlug:slug,presentation:{}}]}};
      let authored: typeof value | CatalogDraftPayloadV5 = value;
      if (predecessor) authored={ ...value,schemaVersion: 5,publication: { ...value.publication,operations: value.publication.operations.map(operation => operation.op === "create_sku" ? { ...operation,successorOf: predecessor } : operation) } };
      const declared = await publish(authored,draft,0,null);
      // Standing facts are installed owner fixture data, as in the existing admission journey.
      const old = (await db.query("SELECT * FROM public.catalog_publications WHERE id=$1",[declared.publicationId])).rows[0];
      const manifest = JSON.parse(old.canonical_state), previous = manifest.skus[0];
      const row = (await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1",[previous.revisionId])).rows[0];
      const facts = { ...JSON.parse(row.full_facts),lifecycleState: "active",status: "active",sellableStandalone: true,sellableInSubscription: true,memberships: [{ offerVersion: "classic",admitted: true }] };
      manifest.schemaVersion=3; delete manifest.successors;
      manifest.product={ ...manifest.product,lifecycleState: "active",status: "active" };
      const publication = randomUUID(),revisionId = randomUUID(),fullFacts = canonicalCatalogDraftJson(facts),factDigest = hash(fullFacts);
      manifest.skus=[{ ...previous,revisionId,revision: 2,digest: factDigest }];
      const canonical=canonicalCatalogDraftJson(manifest),digest=hash(canonical);
      await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities VALUES(pg_current_xact_id(),$1,$2)",[product,digest]);
      await db.query("UPDATE public.catalog_products SET status='active',publication_facts=$2::jsonb WHERE id=$1",[product,manifest.product]);
      await db.query("UPDATE public.catalog_skus SET status='active',sellable_standalone=true,sellable_in_subscription=true,publication_facts=$2::jsonb WHERE id=$1",[sku,facts]);
      await db.query("INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id) VALUES($1,$2,2,$3,$4,1,$5,$6,$7,$8,$6,$9)",[publication,product,old.id,draft,`standing:${publication}`,digest,old.document_revision_id,canonical,admin]);
      await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,2,$4,$5,$6)",[revisionId,sku,product,publication,fullFacts,factDigest]);
      await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=2 WHERE product_id=$1",[product,publication]);
      await db.query("DELETE FROM public.catalog_lifecycle_write_capabilities WHERE product_id=$1",[product]);
      const head={ ...declared,publicationId: publication,revision: 2 };
      const reference=catalogAcceptedReferenceV2Schema.parse({ schemaVersion: 2,skuId: sku,skuCode: code,skuRevisionId: revisionId,publicationHead: head,typeRef: manifest.product.type,
        definitionDigest: manifest.product.definitionDigest,optionDigest: facts.optionDigest,netContent: facts.netContent });
      return { product,sku,draft,code,value,head,reference,declared };
    }
    const predecessor=await article(),successor=await article(predecessor.sku),continuation=options.continuation?await article(successor.sku):undefined;
    const client=randomUUID(),principal=randomUUID(),subscription=randomUUID(),activationCycle=randomUUID(),list=randomUUID(),entry=randomUUID(),destination=randomUUID();
    const clock=(await db.query(`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      to_char((CASE WHEN $1::boolean THEN now()+interval '28 days' ELSE now()-interval '1 day' END) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS anchor,
      to_char((now()-interval '56 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS authorized,
      to_char((now()-interval '10 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS claimed`,[options.ordinary??false])).rows[0];
    const at=String(clock.at),anchor=String(clock.anchor),authorized=String(clock.authorized),claimed=String(clock.claimed),source=`successor:${subscription}`;
    await db.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)",[client,`${client}@example.invalid`,principal]);
    await db.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic list','ZZ','XXX',now()-interval '2 days')",[list]);
    await db.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',777,now()-interval '2 days')",[entry,list,successor.sku]);
    if(continuation)await db.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',777,now()-interval '2 days')",[randomUUID(),list,continuation.sku]);
    await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,started_at,currency_code,price_list_id) VALUES($1,$2,28,$3,$4,'XXX',$5)",[subscription,client,anchor,authorized,list]);
    await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,1,0,617,'XXX',$3)",[subscription,predecessor.sku,predecessor.reference.skuRevisionId]);
    await db.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3::timestamptz-interval '28 days','paid')",[activationCycle,subscription,anchor]);
    await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,next_cycle_number,catalog_acceptance) VALUES($1,'XXX',$2,'sandbox',$3,'synthetic',1,$4::jsonb)",[subscription,source,authorized,{ schemaVersion: 2,lines: [predecessor.reference] }]);
    await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,1,617)",[subscription,predecessor.code]);
    await db.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')",[subscription]);
    await db.query("INSERT INTO public.commerce_destinations(id,client_id,address) VALUES($1,$2,$3)",[destination,client,{ recipientName: "Synthetic recipient",line1: "1 Synthetic Lane",city: "Synthetic",postalCode: "00000",country: "ZZ" }]);
    const money=(amountMinor:number)=>({ amountMinor,currency: "XXX" }),oldLine={ lineOrdinal: 1,sku: predecessor.code,quantity: 1,unitAmountMinor: 617 };
    const sizedQuoteLine = (article: typeof successor, amount: number) => ({
      sku: article.code, productSlug: article.value.product.slug!, quantity: 1, unitPriceGross: money(amount), lineSubtotalGross: money(amount),
      tax: { included: true as const, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "synthetic",
        netAmount: money(amount), vatAmount: money(0), grossAmount: money(amount) },
    });
    if (options.lane === "sized") await db.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
      VALUES($1,'subscription.starter_graduated',$2,$3,$4)`, [subscription, randomUUID(), {
      linePricing: [{ ...oldLine, isAddon: false, quoteLine: sizedQuoteLine(predecessor, 617) }],
    }, at]);
    const codec=createNativeCatalogRenewalCodecV2(value=>catalogAcceptedReferenceV2Schema.parse(value));
    const header={ subscription_id: subscription,client_id: client,scheduled_at: anchor,cadence_days: 28,currency_code: "XXX",stock_source_key: source,settlement_channel_key: "sandbox",authorization_ref: "synthetic",payer_account_ref: null,
      unattended_charge_authorized_at: authorized,activation_cycle_id: activationCycle,activation_cycle_paid: true,paid_cycle_count: 1,next_cycle_number: 1,template_version: 1,
      purchase_facts: { templateId: "synthetic",renewalTerms: { version: "native.renewal-terms.v1",shippingTerms: { version: "shipping-threshold.v1",currency: "XXX",flatMinor: 0,freeThresholdMinor: 0 },normalCadenceDays: [28] } },
      catalog_acceptance: { schemaVersion: 2,lines: [predecessor.reference] },lines: [oldLine] };
    const schedule={ subscriptionId: subscription,scheduledAt: anchor,scheduledInstant: Date.parse(anchor) };
    const frozen=codec.withDestination!(codec.freeze(header,schedule),destination),wire=codec.encode(frozen);
    const withdraw=structuredClone(predecessor.value); withdraw.product.sharedContent.catalogAction="revise";
    withdraw.publication.operations=[{ op: "set_product_lifecycle",productSlug: withdraw.product.slug!,expectedState: "active",state: "withdrawn",children: [{ skuCode: predecessor.code,expectedState: "active" }] }];
    const withdrawalHead=await publish(withdraw,predecessor.draft,1,predecessor.head);
    // The withdrawal and empty-scan source are committed before the later wait creator.
    await db.query("COMMIT");await db.query("BEGIN");
    const stock=createPostgresFulfillmentStockSyncPort(db,{ sourceKey: source,readLocalInventoryStock: async()=>[] });
    for (const [sku,quantity] of [[predecessor.code,0],[successor.code,100],...(continuation?[[continuation.code,100] as const]:[])] as const) await stock.recordProviderStockCurrent({ requestKey: `stock:${sku}`,snapshot: { providerRef: "synthetic",collectedAt: at,sourceRevision: null,revisionSource: "collection",quantityKind: "snapshot",skuRef: sku,totalQuantity: quantity,forSaleQuantity: quantity,reservedOrUnavailableQuantity: 0,syncRunId: subscription },inventoryClass: "sellable",lastSyncedAt: at,staleAfter: (await db.query("SELECT now()+interval '1 day' AS until")).rows[0].until.toISOString() });
    const claimedOperation=options.ordinary?{operationId:null,claimToken:null}:await rpc(db,"subscription_claim_due_renewal",[codec.identity(frozen),codec.fingerprint(frozen),wire,"synthetic",300,claimed]);
    let admitted: Record<string,unknown>,preRecovery: Record<string,unknown>|null=null;
    if(options.ordinary){admitted={};}
    else if(options.creator==="recover") {
      expect(await rpc(db,"fulfillment_reserve_subscription_renewal",[claimedOperation.operationId,claimedOperation.claimToken,900,claimed])).toMatchObject({ reserved:false });
      preRecovery=(await db.query("SELECT to_jsonb(op) AS row FROM public.subscription_renewal_operations op WHERE id=$1",[claimedOperation.operationId])).rows[0].row;
      if(options.recoveryStock) {
        const recorded=(await db.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
        await stock.recordProviderStockCurrent({ requestKey:`recovery:${predecessor.code}`,snapshot:{ providerRef:"synthetic",collectedAt:recorded,sourceRevision:null,revisionSource:"collection",quantityKind:"snapshot",skuRef:predecessor.code,totalQuantity:options.recoveryStock,forSaleQuantity:options.recoveryStock,reservedOrUnavailableQuantity:0,syncRunId:subscription },inventoryClass:"sellable",lastSyncedAt:recorded,staleAfter:(await db.query("SELECT now()+interval '1 day' AS until")).rows[0].until.toISOString() });
      }
      admitted=await rpc(db,"subscription_stock_wait_recover_refusal",[claimedOperation.operationId,codec.fingerprint(frozen),"synthetic-recovery",at]);
      expect(admitted.waiting).toBe(!options.recoveryStock);
    } else {
      admitted=await rpc(db,"subscription_stock_wait_admit",[{ operationId: claimedOperation.operationId,claimToken: claimedOperation.claimToken,snapshot: wire,operationFingerprint: codec.fingerprint(frozen),identityKey: codec.identity(frozen),worker: "synthetic" },{},claimed]);
      expect(admitted.waiting).toBe(true);
    }
    const qty=options.quotedQuantity??1,total=777*qty;
    const innerHash=hash(randomUUID()),line={ variantId: successor.sku,qty,isAddon: false,quoteLine: { sku: successor.code,quantity: qty,unitPriceGross: money(777),lineSubtotalGross: money(total) } };
    const lineId=(await db.query("SELECT id FROM public.subscription_lines WHERE subscription_id=$1",[subscription])).rows[0].id;
    const consent:SubscriptionEditConsent={version:1,currency:"XXX",baselineFingerprint:hash(JSON.stringify([1,"XXX",1,[[1,lineId,predecessor.sku,predecessor.code,false,1,617]]])),innerQuoteHash:innerHash,
      lines:[{kind:"removed",variantId:predecessor.sku,sku:predecessor.code,isAddon:false,agreedQuantity:1,newQuantity:null,agreedUnitMinor:617,newUnitMinor:null,deltaMinor:null,subtotalDeltaMinor:-617,reason:"removed"},
        {kind:"added",variantId:successor.sku,sku:successor.code,isAddon:false,agreedQuantity:null,newQuantity:qty,agreedUnitMinor:null,newUnitMinor:777,deltaMinor:null,subtotalDeltaMinor:total,reason:"added"}],agreedTotalMinor:617,newTotalMinor:total,subtotalDeltaMinor:total-617};
    const quoteHash=hash(JSON.stringify([consent.version,consent.innerQuoteHash,consent.currency,consent.baselineFingerprint,consent.lines.map(l=>[l.kind,l.variantId,l.sku,l.isAddon,l.agreedQuantity,l.newQuantity,l.agreedUnitMinor,l.newUnitMinor,l.deltaMinor,l.subtotalDeltaMinor,l.reason]),consent.agreedTotalMinor,consent.newTotalMinor,consent.subtotalDeltaMinor]));
    const admission={ heads: [{ productId: successor.product,head: successor.head }],skuRevisions: [{ reference: successor.reference,quantity: qty }],mode: "subscription",
      offerEvidence: { offerVersion: "classic" },priceContextVersions: [{ skuId: successor.sku,priceListId: list,entryId: entry,entry: (await db.query("SELECT to_jsonb(p) AS row FROM public.price_entries p WHERE id=$1",[entry])).rows[0].row }],purpose: "account" };
    const core=[{ variantId: successor.sku,qty }],totals={ currentRecurringPrice: money(617),newRecurringPrice: money(total),delta: money(total-617) };
    const request={ planDays: 28,base: core,addons: [],expectedTemplateVersion: 1,acceptedQuoteHash: quoteHash };
    const evidence={ baseLines: [line],addonLines: [],compositionConstraint: null,catalogAdmission: admission,editConsent: consent };
    const lane=options.lane??"classic",action=lane==="classic"?"update_package_template":lane==="exact"?"swap_base_line":"resize_bundle";
    const constraint={kind:"unit_count",value:qty,dailyNeed:1};
    const nativeRequest=lane==="classic"?request:lane==="exact"?{action,fromVariantId:predecessor.sku,toVariantId:successor.sku,expectedTemplateVersion:1,acceptedQuoteHash:quoteHash}
      :{action,cadenceDays:28,compositionConstraint:constraint,resizeLever:{kind:"subscription.sized.parcel",value:{coreLines:core,optInToSized:true}},expectedTemplateVersion:1,acceptedQuoteHash:quoteHash};
    const subjectFacts = { clientId: client, subscriptionId: subscription, subjectRef: subscription,
      exclusions: options.retainedExclusions ?? [], snapshot: { revision: 1 }, catalogFacts: [{
        variantId: successor.sku, sku: successor.code, groupId: successor.product, isAddon: false, sellable: true,
        physicalSize: 100, demandPerUnit: 28, documentRevisionId: successor.reference.skuRevisionId,
        documentDigest: successor.reference.optionDigest, verified: true, exclusions: [], sellableNow: 100,
      }] };
    const nativeEvidence=lane==="classic"?evidence:{editConsent:consent,catalogAdmission:admission,lines:[lane==="exact"?{...line,lineId}:line],cadenceDays:28,compositionConstraint:lane==="sized"?constraint:null,...(lane==="sized"?{subjectFacts,optInFacts:{revision:1}}:{})};
    const ledgerRequest=lane==="classic"?{planDays:28,base:core,addons:[]}:Object.fromEntries(Object.entries(nativeRequest).filter(([key])=>!["expectedTemplateVersion","acceptedQuoteHash"].includes(key)));
    const quote=await rpc(db,"subscription_quote_preview_record",[principal,client,subscription,action,quoteHash,1,(await db.query("SELECT now()+interval '1 hour' AS until")).rows[0].until.toISOString(),ledgerRequest,nativeEvidence,totals,at]);
    const newFrozen=codec.withDestination!(codec.freeze({ ...header,template_version: 2,lines: [{ lineOrdinal: 1,sku: successor.code,quantity: qty,unitAmountMinor: 777 }],catalog_acceptance: { schemaVersion: 2,lines: [successor.reference] },graduation_pricing: [{ sku: successor.code,quantity: qty,unitAmountMinor: 777,isAddon: false,quoteLine: line.quoteLine }] },schedule),destination);
    const proposalId=randomUUID(),offer={ proposalId,predecessorSkuId: predecessor.sku,successorSkuId: successor.sku,publicationId: successor.declared.publicationId,
      previewId: quote.id,sourceBinding: options.ordinary?{kind:"ordinary_edit"}:{ kind: "stock_wait",caseKind: "legacy",caseId: admitted.caseId },lane,action,
      ...(options.historicalBinding?{historicalBinding:options.historicalBinding}:{}),
      applyPayload: { ...nativeRequest,request:nativeRequest,...nativeEvidence,...totals,...(options.applyLegacyAlias?{recipeLines:core}:{}) },cycleSnapshot: codec.encode(newFrozen) };
    const proposal=await rpc(db,"subscription_successor_proposal_offer_v2",[subscription,client,offer,at]);
    await db.query("COMMIT");
    return { client,principal,subscription,predecessor,successor,continuation,withdrawalHead,at,anchor,source,codec,frozen,wire,preRecovery,header,destination, sizedQuoteLine: sizedQuoteLine(successor, 777),subjectFacts,registry,rules,
      publish:(payload:CatalogDraftPayloadV4|CatalogDraftPayloadV5,draftId:string,revision:number,head:CatalogHeadRef|null)=>transaction(connection=>publishOn(connection,payload,draftId,revision,head),pool),
      operationId: String(claimedOperation.operationId),claimToken: String(admitted.claimToken??claimedOperation.claimToken),caseId: String(admitted.caseId),proposalId,quoteHash: String(proposal.quote_hash),offer };
  } catch(error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
