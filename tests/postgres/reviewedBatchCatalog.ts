import { createHash } from "node:crypto";
import { Client, type Pool, type QueryResultRow } from "pg";
import { expect } from "vitest";
import { batchedFunctionDefinitions, sqlStatements, type BatchedForwardBinding } from "../../scripts/reviewed-platform-forward.js";

// Preserve every structural pg_proc attribute. Normalize only parse locations,
// which PostgreSQL records from the file offset rather than function semantics.
export async function batchSnapshot(db: Pool) {
  const functions = (await db.query(`SELECT p.oid, n.nspname||'.'||p.proname AS name,
    p.prosrc, (to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object(
      'proargdefaults',regexp_replace(p.proargdefaults::text,':location -?[0-9]+',':location -1','g')) AS attributes
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace ORDER BY p.oid`)).rows;
  // Exclude planner statistics and vacuum freeze bookkeeping; no forward can
  // set relfrozenxid or relminmxid.
  const relations = (await db.query(`SELECT c.oid, n.nspname||'.'||c.relname AS name, c.relkind,
    to_jsonb(c)-'relpages'-'reltuples'-'relallvisible'-'relallfrozen'-'relfrozenxid'-'relminmxid' AS attributes,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%' ORDER BY c.oid`)).rows;
  const catalogs: Record<string, unknown[]> = {};
  for (const table of ["pg_namespace", "pg_type", "pg_trigger", "pg_policy", "pg_default_acl", "pg_roles", "pg_auth_members", "pg_constraint", "pg_index", "pg_rewrite", "pg_foreign_server", "pg_event_trigger", "pg_extension", "pg_description"]) {
    catalogs[table] = (await db.query(`SELECT to_jsonb(c) AS value FROM pg_catalog.${table} c ORDER BY to_jsonb(c)::text`)).rows.map(row => row.value);
  }
  const tables = relations.filter(row => row.relkind === "r" && /^(?:public|private)\./u.test(row.name));
  const data: Record<string, unknown[]> = {};
  for (const table of tables) data[table.name] = (await db.query(`SELECT to_jsonb(t) AS value FROM ${table.name} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.value);
  return { functions, relations, catalogs, data };
}
export type BatchSnapshot = Awaited<ReturnType<typeof batchSnapshot>>;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const additions = (before: unknown[], after: unknown[]) => {
  const old = new Set(before.map(row => JSON.stringify(row)));
  return after.filter(row => !old.has(JSON.stringify(row)));
};
const removed = (before: unknown[], after: unknown[]) => additions(after, before);

// Expected backfill is computed from the pre-forward rows, never the candidate
// UPDATEs. Ambiguous/missing evidence cannot acquire an attempt or cached result.
function replayBackfill(before: BatchSnapshot) {
  const data = structuredClone(before.data) as Record<string, QueryResultRow[]>;
  const cases = data["public.subscription_dunning_cases"]!;
  const receipts = data["public.commerce_idempotency_keys"]!;
  const attempts = data["public.commerce_payment_attempts"]!;
  const events = data["public.subscription_events"]!;
  const tokens = data["public.subscription_payment_recovery_tokens"]!;
  const attribution = (d: QueryResultRow, intent: string, rung: string) => [...new Set(events.filter(e =>
    e.subscription_id === d.subscription_id && e.cycle_id === d.cycle_id &&
    ["subscription.retry_scheduled", "subscription.payment_failed"].includes(e.event_type) &&
    e.payload.source === "payment.control.v0" && e.payload.paymentIntentId === intent &&
    String(e.payload.retryAttempt) === rung && attempts.some(a => a.id === e.payload.paymentAttemptId && a.payment_intent_id === intent)
  ).map(e => e.payload.paymentAttemptId))];
  for (const d of cases) {
    d.failed_payment_attempt_id = null; d.failure_observation_result = null;
    if (d.status !== "open") continue;
    const ids = attribution(d, d.payment_intent_id, String(d.retry_attempt));
    if (ids.length !== 1) continue;
    d.failed_payment_attempt_id = ids[0];
    const matching = receipts.filter(k => {
      const r = k.response_payload?.subscriptionDunning;
      return k.scope === "subscription.dunning.failure" && k.status === "completed" && r?.caseId === d.id &&
        String(r.retryAttempt) === String(d.retry_attempt) && r.paymentIntentId === d.payment_intent_id &&
        tokens.some(t => t.case_id === d.id && t.revoked_at === null && typeof r.recoveryUrlPath === "string" &&
          t.token_hash === createHash("sha256").update(r.recoveryUrlPath.split("token=")[1] ?? "").digest("hex"));
    }).sort((a,b) => a.created_at.localeCompare(b.created_at) || a.idempotency_key.localeCompare(b.idempotency_key));
    d.failure_observation_result = matching[0]?.response_payload ?? null;
  }
  for (const k of receipts) {
    if (k.scope !== "subscription.dunning.failure" || k.status !== "completed") continue;
    const r = k.response_payload?.subscriptionDunning;
    const d = cases.find(d => d.id === r?.caseId && d.status === "open");
    if (!d) continue;
    const ids = attribution(d, r.paymentIntentId, String(r.retryAttempt));
    if (ids.length === 1) k.metadata = { ...k.metadata, failedPaymentAttemptId: ids[0] };
  }
  return data;
}

/** Independent catalog observer: expected identities come from reviewed pins,
 * actual statement effects come exclusively from PostgreSQL catalogs and rows. */
export async function assertBatchCatalog(db: Pool, pin: BatchedForwardBinding, source: Buffer, before: BatchSnapshot, after: BatchSnapshot) {
  const statements = sqlStatements(source.toString());
  const replay = pin.path === "supabase/migrations/20261025090000_subscription_dunning_attempt_replay.sql";
  const creates = pin.functions.filter(fn => fn.beforeSha256 === null);
  const replaces = pin.functions.filter(fn => fn.beforeSha256 !== null);
  const ids = new Map<string, number>();
  for (const fn of pin.functions) ids.set(fn.signature, (await db.query("SELECT $1::regprocedure::oid AS oid", [fn.signature])).rows[0].oid);
  const replacedIds = new Set(replaces.map(fn => ids.get(fn.signature)));
  const createdIds = new Set(creates.map(fn => ids.get(fn.signature)));
  const currentFunctions = new Map(after.functions.map(row => [row.oid, row]));
  for (const row of before.functions) {
    const current = currentFunctions.get(row.oid);
    if (replacedIds.has(row.oid)) {
      expect(current?.attributes, `${pin.path}: replacement metadata/ACL ${row.name}`).toEqual(row.attributes);
      expect(current?.prosrc).not.toBe(row.prosrc);
    } else expect(current, `${pin.path}: existing function ${row.name}`).toEqual(row);
  }
  const oldFunctionIds = new Set(before.functions.map(row => row.oid));
  expect(after.functions.filter(row => !oldFunctionIds.has(row.oid)).map(row => row.oid).sort()).toEqual([...createdIds].sort());
  for (const fn of pin.functions) {
    const row = currentFunctions.get(ids.get(fn.signature)!)!;
    const statement = statements.find(sql => batchedFunctionDefinitions(Buffer.from(sql)).has(fn.signature))!;
    const body = /\bAS (\$[a-z_0-9]*\$)([\s\S]*)\1;$/iu.exec(statement);
    expect(body, `${fn.signature} raw body`).not.toBeNull();
    expect(row.prosrc).toBe(body![2]);
    {
      expect(row.attributes.prosecdef).toBe(/\bSECURITY DEFINER\b/u.test(statement.slice(0, body!.index)));
      const config = /SET search_path\s*(?:=|TO)\s*([a-z_, '\n]+)\s+AS/u.exec(statement)?.[1]?.split(",").map(value => value.trim().replaceAll("'", "")).join(", ");
      expect(row.attributes.proconfig).toEqual([`search_path=${config}`]);
    }
  }
  const newTables = statements.flatMap(sql => /^CREATE TABLE (public\.[a-z_][a-z0-9_]*)\s*\(/u.exec(sql)?.[1] ?? []);
  const oldRelations = new Set(before.relations.map(row => row.oid));
  const newRelations = after.relations.filter(row => !oldRelations.has(row.oid));
  expect(newRelations.filter(row => row.relkind === "r").map(row => row.name).sort()).toEqual([...newTables].sort());
  const tableIds = new Set(newRelations.filter(row => row.relkind === "r").map(row => row.oid));
  const toastIds = new Set(newRelations.filter(row => row.relkind === "r").map(row => Number(row.attributes.reltoastrelid)));
  const explicitIndexes = new Set(statements.flatMap(sql => /^CREATE INDEX ([a-z_][a-z0-9_]*)/u.exec(sql)?.[1] ?? []));
  const constraintIndexes = new Set((after.catalogs.pg_constraint! as Record<string, unknown>[]).filter(row => tableIds.has(Number(row.conrelid))).map(row => Number(row.conindid)));
  for (const row of newRelations) {
    expect(["r", "i", "t"]).toContain(row.relkind);
    if (row.relkind === "t") expect(toastIds.has(row.oid)).toBe(true);
    if (row.relkind === "i") {
      const index = (after.catalogs.pg_index! as { indexrelid: number; indrelid: number }[]).find(item => Number(item.indexrelid) === row.oid)!;
      expect(tableIds.has(Number(index.indrelid)) || toastIds.has(Number(index.indrelid))).toBe(true);
      expect(toastIds.has(Number(index.indrelid)) || explicitIndexes.has(row.name.split(".")[1]) || constraintIndexes.has(row.oid)).toBe(true);
    }
  }
  const currentRelations = new Map(after.relations.map(row => [row.oid, row]));
  for (const row of before.relations) {
    const current = structuredClone(currentRelations.get(row.oid));
    if (replay && row.name === "public.subscription_dunning_cases") {
      const added = current.columns.filter((c: { attname: string }) => ["failed_payment_attempt_id", "failure_observation_result"].includes(c.attname));
      expect(added.map((c: { attname: string; atttypid: number }) => [c.attname, Number(c.atttypid)])).toEqual([["failed_payment_attempt_id", 2950], ["failure_observation_result", 3802]]);
      for (const column of added) expect(column).toMatchObject({ attnotnull: false, atthasdef: false, attgenerated: "", attidentity: "", attacl: null, attisdropped: false });
      expect(current.attributes.relnatts).toBe(row.attributes.relnatts + 2);
      current.columns = current.columns.filter((c: { attname: string }) => !added.some((a: { attname: string }) => a.attname === c.attname));
      current.attributes.relnatts = row.attributes.relnatts;
    }
    if (pin.path.endsWith("20261024160000_subscription_dunning_continuity.sql") && row.name === "public.subscription_cycles") {
      for (const column of current.columns) {
        const old = row.columns.find((item: { attnum: number }) => item.attnum === column.attnum);
        if (["id", "retry_attempt"].includes(column.attname)) {
          const delta = (await db.query(`SELECT a.attname,x.privilege_type,x.is_grantable,r.rolname
            FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x JOIN pg_roles r ON r.oid=x.grantee
            WHERE a.attrelid=$1 AND a.attname=$2`, [row.oid, column.attname])).rows;
          expect(delta).toEqual([{ attname: column.attname, privilege_type: "SELECT", is_grantable: false, rolname: "service_role" }]);
          column.attacl = old.attacl;
        }
      }
    }
    expect(current, `${pin.path}: existing relation ${row.name}`).toEqual(row);
  }
  // New ACLs are measured including implicit PUBLIC EXECUTE; grants on existing
  // functions (notably the native allocator) were compared above byte-for-byte.
  for (const fn of creates) {
    const acl = (await db.query(`SELECT x.privilege_type,x.is_grantable,
      CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE r.rolname END AS grantee
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
      LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE p.oid=$1 AND x.grantee<>p.proowner ORDER BY grantee`, [ids.get(fn.signature)])).rows;
    const granted = statements.some(sql => sql.startsWith("GRANT EXECUTE ON FUNCTION ") && batchedFunctionDefinitions(Buffer.from(sql.replace(/^GRANT EXECUTE ON FUNCTION /u, "CREATE FUNCTION ").replace(/ TO service_role;$/u, " RETURNS text LANGUAGE sql AS $$ SELECT ''; $$;"))).has(fn.signature));
    expect(acl).toEqual(granted ? [{ privilege_type: "EXECUTE", is_grantable: false, grantee: "service_role" }] : []);
  }
  for (const table of newTables) {
    const acl = (await db.query(`SELECT x.privilege_type,r.rolname,x.is_grantable FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) x LEFT JOIN pg_roles r ON r.oid=x.grantee
      WHERE c.oid=$1::regclass AND x.grantee<>c.relowner ORDER BY x.privilege_type`, [table])).rows;
    const managed = pin.path.startsWith("supabase/");
    expect(acl).toEqual(managed ? ["DELETE", "INSERT", "SELECT", "UPDATE"].map(privilege_type => ({ privilege_type, rolname: "service_role", is_grantable: false })) : []);
    const row = newRelations.find(item => item.name === table)!;
    expect(row.attributes.relrowsecurity).toBe(managed);
    expect(row.columns.filter((column: { attacl: unknown }) => column.attacl !== null)).toEqual([]);
  }
  if (replay) {
    const expected = replayBackfill(before);
    // Row ordering may change when JSON gains columns/metadata; compare by value.
    for (const [name, rows] of Object.entries(expected)) expect(after.data[name], name).toEqual(expect.arrayContaining(rows));
    for (const [name, rows] of Object.entries(expected)) expect(after.data[name]?.length, name).toBe(rows.length);
  }
  const changedTables = Object.keys(before.data).filter(name => !same(before.data[name], after.data[name]));
  const expectedChanged = pin.path.endsWith("20261024180000_subscription_stock_wait.sql") && pin.path.startsWith("supabase/") ? ["public.client_absorption_policy"] : pin.path.endsWith("20261024182000_subscription_lifecycle_message_scan.sql") ? ["public.comms_notification_controls"] : [];
  if (!replay) expect(changedTables.sort()).toEqual(expectedChanged.sort());
  for (const name of expectedChanged) {
    expect(removed(before.data[name]!, after.data[name]!)).toEqual([]);
    const added = additions(before.data[name]!, after.data[name]!) as Record<string, unknown>[];
    if (name === "public.client_absorption_policy") expect(added).toEqual([{ table_name: "subscription_stock_wait_cases", disposition: "block", note: "A frozen subscription delivery is a commercial obligation bound to its original client; never carry or rebind it when absorbing a lead." }]);
    else expect(added.map(({ slug, enabled }) => ({ slug, enabled })).sort((a,b) => String(a.slug).localeCompare(String(b.slug)))).toEqual([{ slug: "subscription-stock-wait-resumed", enabled: true }, { slug: "subscription-stock-wait-started", enabled: true }]);
  }
  for (const table of newTables) expect(after.data[table]).toEqual([]);
  // Catalogs outside approved new-table dependencies and the one pinned function
  // comment must stay exact. No schema, policy, role, default grant or event hook.
  const replayConstraints = replay ? additions(before.catalogs.pg_constraint!, after.catalogs.pg_constraint!) as Record<string, unknown>[] : [];
  if (replay) {
    expect(replayConstraints).toHaveLength(1);
    const cases = after.relations.find(r => r.name === "public.subscription_dunning_cases")!;
    const attempts = after.relations.find(r => r.name === "public.commerce_payment_attempts")!;
    expect(replayConstraints[0]).toMatchObject({ conname: "subscription_dunning_cases_failed_attempt_fkey", contype: "f", convalidated: false,
      conrelid: String(cases.oid), confrelid: String(attempts.oid), condeferrable: false, condeferred: false, confupdtype: "a", confdeltype: "a", confmatchtype: "s",
      conkey: [cases.columns.find((c: { attname: string }) => c.attname === "failed_payment_attempt_id").attnum],
      confkey: [attempts.columns.find((c: { attname: string }) => c.attname === "id").attnum] });
    const triggers = additions(before.catalogs.pg_trigger!, after.catalogs.pg_trigger!) as Record<string, unknown>[];
    expect(triggers).toHaveLength(4);
    for (const trigger of triggers) {
      expect(trigger).toMatchObject({ tgconstraint: replayConstraints[0]!.oid, tgisinternal: true, tgenabled: "O", tgdeferrable: false, tginitdeferred: false, tgnargs: 0, tgqual: null });
      expect([cases.oid, attempts.oid]).toContain(Number(trigger.tgrelid));
    }
  }
  for (const [name, beforeRows] of Object.entries(before.catalogs)) {
    const afterRows = after.catalogs[name]!;
    if (name === "pg_description") {
      const expectedComment = statements.find(sql => sql.startsWith("COMMENT ON FUNCTION "));
      if (expectedComment) {
        const id = ids.get("public.commerce_emit_order_refunded_outbox()");
        expect(removed(beforeRows, afterRows).filter((row: unknown) => Number((row as { objoid: number }).objoid) !== id)).toEqual([]);
        expect(additions(beforeRows, afterRows).filter((row: unknown) => Number((row as { objoid: number }).objoid) !== id)).toEqual([]);
      } else expect(afterRows).toEqual(beforeRows);
      continue;
    }
    expect(removed(beforeRows, afterRows), `${pin.path}: removed ${name}`).toEqual([]);
    const added = additions(beforeRows, afterRows) as Record<string, unknown>[];
    if (name === "pg_type") for (const row of added) {
      expect(newTables.some(table => row.typname === table.split(".")[1] || row.typname === `_${table.split(".")[1]}`), `unexpected type ${JSON.stringify(row)}`).toBe(true);
      expect(row.typacl).toBeNull();
    }
    else if (name === "pg_constraint") for (const row of added) expect(replayConstraints.some(c => c.oid === row.oid) || tableIds.has(Number(row.conrelid)), `unexpected constraint ${JSON.stringify(row)}`).toBe(true);
    else if (name === "pg_index") for (const row of added) expect(tableIds.has(Number(row.indrelid)) || toastIds.has(Number(row.indrelid))).toBe(true);
    else if (name === "pg_trigger") for (const row of added) expect(row.tgisinternal && (after.catalogs.pg_constraint! as Record<string, unknown>[]).some(item => item.oid === row.tgconstraint && (replayConstraints.some(c => c.oid === item.oid) || tableIds.has(Number(item.conrelid)))), `unexpected trigger ${JSON.stringify(row)}`).toBe(true);
    else expect(added, `${pin.path}: unexpected ${name}`).toEqual([]);
  }
}


export function assertSameSnapshot(before: BatchSnapshot, after: BatchSnapshot): void {
  const deltas: Record<string, unknown> = {};
  for (const kind of ["functions", "relations"] as const) {
    const old = new Map(before[kind].map(row => [row.oid,row]));
    const changed = after[kind].filter(row => !same(old.get(row.oid),row));
    if (changed.length) deltas[kind] = changed.map(row => ({ before:old.get(row.oid), after:row }));
    if (before[kind].length!==after[kind].length) deltas[`${kind}Count`] = [before[kind].length,after[kind].length];
  }
  for (const kind of ["catalogs", "data"] as const) for (const key of new Set([...Object.keys(before[kind]),...Object.keys(after[kind])])) {
    if (!same(before[kind][key],after[kind][key])) deltas[`${kind}:${key}`] = { removed:removed(before[kind][key]??[],after[kind][key]??[]),added:additions(before[kind][key]??[],after[kind][key]??[]) };
  }
  expect(deltas).toEqual({});
}

/** Shared real finalize matrix for catalog and workspace behavior proofs. Caller owns rollback. */
export async function assertManagedAcquisition(db: Pick<Pool, "query">, connectionString: string) {
  // Exercise the real finalize/admission/creation closure with retained
  // snapshots and synthetic rows; no reader or creation function is stubbed.
  await db.query(`INSERT INTO public.commerce_settings(key,value_text)
    VALUES ('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT (key) DO UPDATE SET value_text=excluded.value_text`);
  const clientId = (await db.query("INSERT INTO public.clients(email) VALUES ('m11-check@example.invalid') RETURNING id")).rows[0].id;
  const addressId = (await db.query(`INSERT INTO public.addresses(client_id,kind,line1,city,postal_code,country)
    VALUES ($1,'shipping','Synthetic 1','Synthetic','00000','ZZ') RETURNING id`, [clientId])).rows[0].id;
  const productId = (await db.query(`INSERT INTO public.catalog_products(slug,name,status)
    VALUES ('m11-synthetic','Synthetic','active') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO public.catalog_skus(product_id,sku,title,pet_type,net_weight_g,kcal_per_unit,status)
    VALUES ($1,'M11-SYNTHETIC','Synthetic','other',1,1,'active')`, [productId]);
  const draft = { items: [{ sku: "M11-SYNTHETIC", quantity: 1 }] };
  const quote = (terms?: Record<string, unknown>) => ({ quote: {
    context: { mode: "subscription", cadenceDays: 14, ...(terms ? {
      acquisitionTerms: terms,
      pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" },
    } : {}) }, discounts: [], lines: [],
  } });
  const newOrder = async (snapshot: unknown) => {
    const id = (await db.query(`INSERT INTO public.commerce_orders(client_id,currency,region_code,status,subtotal_cents,total_cents,metadata)
      VALUES ($1,'XXX','ZZ','draft',1000,1000,jsonb_build_object('quoteSnapshot',$2::jsonb,'orderDraftSnapshot',$3::jsonb))
      RETURNING id`, [clientId, snapshot, draft])).rows[0].id;
    await db.query(`INSERT INTO public.commerce_order_items(order_id,quantity,unit_price_cents,total_cents,
      discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps,allocation_ordinal,product_snapshot)
      VALUES ($1,1,1000,1000,0,1000,1000,0,1,'{"sku":"M11-SYNTHETIC"}')`, [id]);
    return id as string;
  };
  const finalize = async (id: string, key: string, snapshot: unknown, mode = "subscription_cycle") =>
    (await db.query(`SELECT public.commerce_finalize_order_for_checkout($1,$2,$3,$4,$5,NULL,$6,$7,
      '{"checkoutCommandVersion":"commerce.checkout_command.v1"}') AS result`,
    [key, id, mode, clientId, addressId, snapshot, draft])).rows[0].result.finalizedOrder;
  const counts = async () => (await db.query(`SELECT
    (SELECT count(*) FROM public.subscriptions)::int AS subscriptions,
    (SELECT count(*) FROM public.subscription_cycles)::int AS cycles,
    (SELECT count(*) FROM public.commerce_idempotency_keys WHERE scope='commerce.checkout_order_finalize')::int AS keys`)).rows[0];
  const acquisitionEffects = async () => {
    const state: Record<string, unknown> = {};
    const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    for (const { tablename } of tables) {
      const name = String(tablename).replaceAll('"', '""');
      // xmin alone cannot see a same-value update inside this transaction;
      // ctid changes even when both columns and the transaction ID stay equal.
      state[tablename] = (await db.query(`SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'columns',to_jsonb(t),'xmin',t.xmin::text,'ctid',t.ctid::text)
        ORDER BY to_jsonb(t)::text,t.ctid),'[]'::jsonb) rows FROM public."${name}" t`)).rows[0];
    }
    return state;
  };
  const refuse = async (work: () => Promise<unknown>, code: string, message: string) => {
    // Snapshots are saved before this boundary. Only the finalize statement
    // is inside the savepoint needed to recover from a PostgreSQL exception.
    const before = await acquisitionEffects();
    await db.query("SAVEPOINT acquisition_refusal");
    await expect(work()).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
    await db.query("ROLLBACK TO acquisition_refusal; RELEASE SAVEPOINT acquisition_refusal");
    // Compare every public row, including order/items, subscriptions, cycles
    // and idempotency rows; counts alone would miss an order mutation.
    expect(await acquisitionEffects()).toEqual(before);
  };
  const created = async (result: { subscriptionId: string; subscriptionCycleId: string; replayed: boolean }, before: Awaited<ReturnType<typeof counts>>) => {
    expect(result).toMatchObject({ subscriptionId: expect.any(String), subscriptionCycleId: expect.any(String), replayed: false });
    expect(await counts()).toEqual({ subscriptions: before.subscriptions + 1, cycles: before.cycles + 1, keys: before.keys + 1 });
    expect((await db.query(`SELECT s.status,c.status AS cycle_status FROM public.subscriptions s
      JOIN public.subscription_cycles c ON c.subscription_id=s.id WHERE s.id=$1 AND c.id=$2`,
    [result.subscriptionId, result.subscriptionCycleId])).rows).toEqual([{ status: "pending_activation", cycle_status: "payment_pending" }]);
  };

  // No configured policy: the reader refuses, while compatibility admission
  // permits exactly one subscription/cycle and retains exact finalize replay.
  expect((await db.query("SELECT count(*)::int AS n FROM public.promotions")).rows[0].n).toBe(0);
  await refuse(() => db.query("SELECT public.commerce_subscription_acquisition_terms(clock_timestamp())"), "55000", "acquisition_terms_not_effective");
  const noPolicyQuote = quote(), noPolicyOrder = await newOrder(noPolicyQuote);
  const observerBefore = await acquisitionEffects();
  await db.query("SAVEPOINT acquisition_observer");
  await db.query("UPDATE public.commerce_orders SET status=status WHERE id=$1", [noPolicyOrder]);
  const firstWrite = await acquisitionEffects();
  expect(firstWrite).not.toEqual(observerBefore);
  await db.query("UPDATE public.commerce_orders SET status=status WHERE id=$1", [noPolicyOrder]);
  expect(await acquisitionEffects()).not.toEqual(firstWrite);
  await db.query("ROLLBACK TO acquisition_observer; RELEASE SAVEPOINT acquisition_observer");
  expect(await acquisitionEffects()).toEqual(observerBefore);
  const writer = new Client({ connectionString: connectionString, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
  await writer.connect();
  try {
    // The independent writer holds the real policy key. lock_timeout bounds
    // the refusal without relying on sleeps or a concurrent query winning a race.
    await writer.query("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('commerce.subscription_acquisition',0))");
    await db.query("SET LOCAL lock_timeout='500ms'");
    await refuse(() => finalize(noPolicyOrder, "m11-no-policy", noPolicyQuote), "55P03", "lock timeout");
    await writer.query("ROLLBACK");
    await db.query("SET LOCAL lock_timeout='0'");
    const before = await counts();
    const original = await finalize(noPolicyOrder, "m11-no-policy", noPolicyQuote);
    await created(original, before);
    const replayBefore = await acquisitionEffects();
    expect(await finalize(noPolicyOrder, "m11-no-policy", noPolicyQuote)).toEqual({ ...original, replayed: true });
    expect(await acquisitionEffects()).toEqual(replayBefore);
    await writer.query("BEGIN");
    expect((await writer.query("SELECT pg_try_advisory_xact_lock_shared(hashtextextended('commerce.subscription_acquisition',0)) AS acquired")).rows[0].acquired).toBe(true);
    expect((await writer.query("SELECT pg_try_advisory_xact_lock(hashtextextended('commerce.subscription_acquisition',0)) AS acquired")).rows[0].acquired).toBe(false);
  } finally {
    await writer.query("ROLLBACK");
    await writer.end();
  }

  // Configure policy under the same exclusive writer protocol. The saved
  // terms come from the actual reader, not a hand-built expected payload.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('commerce.subscription_acquisition',0))");
  await db.query(`INSERT INTO public.promotions(name,trigger_type,discount_type,discount_value,applies_to_kind,
    applies_to_payload,stacking_rule,eligibility,valid_from,redemption_limit_per_customer,region_availability,
    status,promotion_engine_version,benefit_lane,benefit_kind,benefit_value_bps)
    VALUES ('Synthetic acquisition','automatic','percentage',37,'order_total',
      '{"cart_mode":"subscription","acquisitionTerms":{"schemaVersion":"subscription-acquisition.v1","revision":"m11-synthetic","delivery2DiscountBps":1700}}',
      'exclusive','{"first_subscription_purchase":true}','2000-01-01T00:00:00Z',1,ARRAY['ZZ'],
      'active','promotion-engine.v2','product','target_percentage',3700)`);
  const readTerms = async () => {
    const selection = (await db.query("SELECT public.commerce_subscription_acquisition_terms(clock_timestamp()) AS terms")).rows[0].terms;
    expect(selection).toMatchObject({ kind: "v2_standalone", initialDiscountBps: 3700 });
    return Object.fromEntries(Object.entries(selection).filter(([key]) => !["kind", "legacyPairCount", "standaloneCount", "nextBoundaryAt"].includes(key)));
  };
  const terms = await readTerms();
  const wrongEngine = quote(terms);
  // Use a coherent v1 pair so offer-policy validation does not mask the
  // admission-specific engine mismatch.
  wrongEngine.quote.context.pricingPolicy = { offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v1" };
  for (const [name, snapshot] of [
    ["missing", quote()], ["stale", quote({ ...terms, revision: "stale" })], ["engine", wrongEngine],
  ] as const) {
    const id = await newOrder(snapshot);
    await refuse(() => finalize(id, `m11-policy-${name}`, snapshot), "55000", "acquisition_terms_changed");
  }
  // Removing admission must make the same atomic-refusal witness fail.
  const unguardedQuote = quote(), unguardedOrder = await newOrder(unguardedQuote);
  await db.query("SAVEPOINT acquisition_mutant");
  try {
    const definition = (await db.query("SELECT pg_get_functiondef('private.commerce_assert_acquisition_admission(jsonb,uuid)'::regprocedure) definition")).rows[0].definition;
    const mutant = definition.replace(/AS (\$[a-z_0-9]*\$)[\s\S]*\1/u, () => "AS $$ BEGIN RETURN; END; $$");
    expect(mutant).not.toBe(definition);
    await db.query(mutant);
    await expect(refuse(() => finalize(unguardedOrder, "m11-admission-mutant", unguardedQuote), "55000", "acquisition_terms_changed"))
      .rejects.toMatchObject({ name: "AssertionError" });
  } finally { await db.query("ROLLBACK TO acquisition_mutant; RELEASE SAVEPOINT acquisition_mutant"); }
  const retainedQuote = quote(terms), policyOrder = await newOrder(retainedQuote);
  const beforePolicy = await counts();
  const configured = await finalize(policyOrder, "m11-policy-exact", retainedQuote);
  await created(configured, beforePolicy);
  await db.query(`UPDATE public.promotions SET applies_to_payload=jsonb_set(applies_to_payload,'{acquisitionTerms,revision}','"m11-revised"')
    WHERE applies_to_payload #>> '{acquisitionTerms,revision}'='m11-synthetic'`);
  const replayBefore = await acquisitionEffects();
  expect(await finalize(policyOrder, "m11-policy-exact", retainedQuote)).toEqual({ ...configured, replayed: true });
  expect(await acquisitionEffects()).toEqual(replayBefore);
  const changedOrder = await newOrder(retainedQuote);
  await refuse(() => finalize(changedOrder, "m11-policy-changed", retainedQuote), "55000", "acquisition_terms_changed");
  const currentQuote = quote(await readTerms()), currentOrder = await newOrder(currentQuote);
  const beforeCurrent = await counts();
  await created(await finalize(currentOrder, "m11-policy-current", currentQuote), beforeCurrent);

  const oneTimeQuote = { quote: { context: { mode: "one_time" }, lines: [], discounts: [] } };
  const oneTimeOrder = await newOrder(oneTimeQuote), beforeOneTime = await counts();
  expect(await finalize(oneTimeOrder, "m11-one-time", oneTimeQuote, "one_time"))
    .toMatchObject({ orderId: oneTimeOrder, mode: "one_time", subscriptionId: null, subscriptionCycleId: null, replayed: false });
  expect(await counts()).toEqual({ ...beforeOneTime, keys: beforeOneTime.keys + 1 });
  expect((await db.query("SELECT mode,subscription_id,subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [oneTimeOrder])).rows)
    .toEqual([{ mode: "one_time", subscription_id: null, subscription_cycle_id: null }]);
}
