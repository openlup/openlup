// Plain ESM, executed outside checkout ancestry against actual installed tarball exports.
import assert from "node:assert/strict";
import { buildSchemaObjectProbe, buildGroupedPostgresSchemaProbe, decodeGroupedPostgresSchemaRows } from "@openlup/core/readiness";

export async function proveGroupedSchema(pool, outboxObjects) {
  // All fixture DDL belongs solely to the existing owned disposable database.
  await pool.query(`
    create schema catalog_example;
    create table catalog_example.parent (id integer primary key);
    create table catalog_example.items (
      id integer generated always as identity,
      parent_id integer references catalog_example.parent(id),
      label varchar(40) not null default 'example',
      label_copy text generated always as (label::text) stored,
      removed text,
      constraint z_positive check (id > 0),
      constraint a_primary primary key (id),
      constraint m_unique unique (label)
    );
    alter table catalog_example.items drop column removed;
    create index z_label on catalog_example.items (label);
    create index a_parent on catalog_example.items (parent_id);
    create index "z odd" on catalog_example.items (parent_id, label);
    alter table catalog_example.items enable row level security;
    alter table catalog_example.items force row level security;
    create policy z_write on catalog_example.items as restrictive for insert to postgres with check (id > 0);
    create policy a_read on catalog_example.items for select to public using (id > 0);
    grant select on catalog_example.items to public;
    grant update (label) on catalog_example.items to public;
    create function catalog_example.touch() returns trigger language plpgsql as $$begin return new; end$$;
    create trigger z_touch before update on catalog_example.items for each row execute function catalog_example.touch();
    create trigger a_touch before insert on catalog_example.items for each row execute function catalog_example.touch();
    create function catalog_example.read_value(integer) returns integer language sql stable security definer
      set search_path = pg_catalog as $$select $1$$;
    create function catalog_example.read_value(text) returns text language sql immutable as $$select $1$$;
    revoke execute on function catalog_example.read_value(integer) from public;
    create aggregate catalog_example.total(integer) (sfunc = pg_catalog.int4pl, stype = integer);
    create function catalog_example.zero() returns integer language sql volatile as $$select 0$$;
    create table catalog_example.partitioned (id integer not null) partition by range (id);
    create table catalog_example.partition_one partition of catalog_example.partitioned for values from (0) to (10);
    create view catalog_example.item_view as select label from catalog_example.items;
    create sequence catalog_example.item_sequence;
    create table catalog_example."Quoted Items" ("Mixed" integer);
    create table catalog_example.empty (value text);
  `);
  const objects = [
    { kind: "table", name: "catalog_example.items" },
    ...["id", "label", "label_copy", "removed", "ctid", "missing"].map(name => ({ kind: "column", name: `catalog_example.items.${name}` })),
    { kind: "function", name: "catalog_example.read_value", signature: "integer" },
    { kind: "function", name: "catalog_example.read_value", signature: "text" },
    { kind: "function", name: "catalog_example.read_value", signature: "boolean" },
    { kind: "function", name: "catalog_example.zero" },
    ...["partitioned", "partition_one", "item_view", "item_sequence", "missing", '"Quoted Items"'].map(name => ({ kind: "table", name: `catalog_example.${name}` })),
    { kind: "column", name: 'catalog_example."Quoted Items".Mixed' },
    { kind: "column", name: "catalog_example.item_view.label" },
    { kind: "column", name: "catalog_example.missing.id" },
    { kind: "function", name: "catalog_example.missing", signature: "integer" },
    ...outboxObjects,
    { kind: "table", name: "catalog_example.empty" },
  ];
  objects.push(objects[0], objects[7]); // Independent ordinals for duplicate identities.
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const query = buildGroupedPostgresSchemaProbe(objects);
    const { rows } = await client.query(query.text, query.values);
    assert.deepEqual(rows.map(row => row.ordinal), objects.map((_, index) => index + 1));
    assert.ok(rows.every(row => row.present ? typeof row.shape === "string" && row.shape.length > 0 : row.shape === null));
    const entries = decodeGroupedPostgresSchemaRows(objects, rows);
    const assertShape = async (index, expected) => {
      // Independent PostgreSQL jsonb serialization of the required values is the byte contract.
      // Different construction order deliberately discriminates json_build_object and parsed-driver rows.
      const reference = (await client.query("select $1::jsonb::text as shape", [JSON.stringify(expected)])).rows[0].shape;
      assert.equal(rows[index].shape, reference);
      assert.equal(JSON.stringify(entries[index].shape), JSON.stringify(JSON.parse(reference)));
      assert.ok(!Object.hasOwn(entries[index].shape, "ACL"));
    };
    for (const entry of entries) {
      const scalar = buildSchemaObjectProbe(entry.object);
      const result = await client.query(scalar.text, scalar.values);
      assert.equal(entry.present, result.rows[0].present);
      assert.equal(entry.shape === null, !entry.present);
    }
    assert.deepEqual(entries.slice(-2).map(entry => entry.shape), [entries[0].shape, entries[7].shape]);
    assert.deepEqual(entries.slice(21, 21 + outboxObjects.length).map(entry => entry.present), outboxObjects.map(() => true));
    const shape = entries[0].shape;
    assert.deepEqual(Object.keys(shape), ["acl", "rls", "kind", "owner", "indexes", "forceRls", "policies", "triggers", "constraints"]);
    assert.equal(shape.kind, "r"); assert.equal(shape.owner, "postgres");
    assert.equal(shape.rls, true); assert.equal(shape.forceRls, true); assert.ok(shape.acl.includes("=r/postgres"));
    // Independently read scalar definition values in catalog order; arrays contain strings, never name objects.
    const constraints = (await client.query(`select pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid = 'catalog_example.items'::regclass order by conname`)).rows.map(row => row.definition);
    assert.deepEqual(shape.constraints, constraints); assert.equal(constraints.length, 4);
    assert.match(constraints[0], /^PRIMARY KEY/); assert.match(constraints.at(-1), /^CHECK/);
    const indexes = (await client.query(`select pg_get_indexdef(indexrelid) as definition
      from pg_index where indrelid = 'catalog_example.items'::regclass order by indexrelid::regclass::text`)).rows.map(row => row.definition);
    assert.deepEqual(shape.indexes, indexes); assert.equal(indexes.length, 5);
    assert.ok(indexes.some(definition => definition.includes('"z odd"')));
    const triggers = (await client.query(`select pg_get_triggerdef(oid) as definition
      from pg_trigger where tgrelid = 'catalog_example.items'::regclass and not tgisinternal order by tgname`)).rows.map(row => row.definition);
    assert.deepEqual(shape.triggers, triggers); assert.equal(triggers.length, 2);
    const policies = (await client.query(`select polname as name, to_jsonb(polroles)::text as roles, polcmd as cmd,
      polpermissive as permissive, pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as "check"
      from pg_policy where polrelid = 'catalog_example.items'::regclass order by polname`)).rows.map(row => ({ ...row, roles: JSON.parse(row.roles) }));
    assert.deepEqual(shape.policies, policies); assert.equal(policies.length, 2);
    assert.deepEqual(Object.keys(shape.policies[0]), ["cmd", "name", "qual", "check", "roles", "permissive"]);
    assert.deepEqual(shape.policies[0].roles, ["0"]);
    const postgresOid = (await client.query("select oid::text as oid from pg_roles where rolname = 'postgres'")).rows[0].oid;
    assert.ok(shape.policies[1].roles.includes(postgresOid));
    assert.ok(shape.policies[1].roles.every(oid => typeof oid === "string" && /^\d+$/.test(oid)));
    assert.equal(shape.policies[0].cmd, "r"); assert.equal(shape.policies[1].cmd, "a");
    assert.equal(shape.policies[0].permissive, true); assert.equal(shape.policies[1].permissive, false);
    await assertShape(0, { constraints, triggers, policies, indexes, owner: "postgres", kind: "r", rls: true, forceRls: true,
      acl: (await client.query("select relacl::text[] as acl from pg_class where oid = 'catalog_example.items'::regclass")).rows[0].acl });
    const id = entries[1].shape, label = entries[2].shape, generated = entries[3].shape;
    assert.deepEqual(Object.keys(label), ["acl", "type", "default", "notNull", "identity", "generated"]);
    assert.equal(id.identity, "a"); assert.equal(id.notNull, true); assert.equal(id.default, null);
    assert.equal(label.type, "character varying(40)"); assert.equal(label.notNull, true);
    assert.equal(label.default, "'example'::character varying"); assert.ok(label.acl.includes("=w/postgres"));
    assert.equal(generated.generated, "s"); assert.equal(generated.default, "(label)::text");
    await assertShape(1, { generated: "", identity: "a", notNull: true, type: "integer", default: null, acl: null });
    await assertShape(2, { generated: "", identity: "", notNull: true, type: "character varying(40)", default: "'example'::character varying",
      acl: (await client.query("select attacl::text[] as acl from pg_attribute where attrelid = 'catalog_example.items'::regclass and attname = 'label'")).rows[0].acl });
    await assertShape(3, { generated: "s", identity: "", notNull: false, type: "text", default: "(label)::text", acl: null });
    const fn = entries[7].shape;
    assert.deepEqual(Object.keys(fn), ["acl", "owner", "config", "definition", "volatility", "securityDefiner"]);
    const definition = (await client.query("select pg_get_functiondef('catalog_example.read_value(integer)'::regprocedure) as definition")).rows[0].definition;
    assert.equal(fn.definition, definition);
    assert.equal(fn.owner, "postgres"); assert.deepEqual(fn.acl, ["postgres=X/postgres"]);
    assert.deepEqual(fn.config, ["search_path=pg_catalog"]); assert.equal(fn.securityDefiner, true); assert.equal(fn.volatility, "s");
    await assertShape(7, { volatility: "s", securityDefiner: true, definition, config: ["search_path=pg_catalog"], acl: ["postgres=X/postgres"], owner: "postgres" });
    assert.equal(entries[8].shape.volatility, "i"); assert.equal(entries[8].shape.securityDefiner, false); assert.equal(entries[8].shape.config, null);
    assert.equal(entries[10].shape.volatility, "v"); assert.equal(entries[11].shape.kind, "p"); assert.equal(entries[12].shape.kind, "r");
    for (const index of [11, 12, 16, objects.findIndex(object => object.name === "catalog_example.empty")]) {
      await assertShape(index, { constraints: null, indexes: null, triggers: null, policies: null, rls: false, forceRls: false,
        kind: index === 11 ? "p" : "r", owner: "postgres", acl: null });
    }
    assert.throws(() => decodeGroupedPostgresSchemaRows([objects[0]], [{ ...rows[0], shape: JSON.parse(rows[0].shape) }]),
      { message: "Invalid grouped PostgreSQL schema rows" });
    const empty = buildGroupedPostgresSchemaProbe([]);
    assert.deepEqual(decodeGroupedPostgresSchemaRows([], (await client.query(empty.text, empty.values)).rows), []);
    // An aggregate resolves as a scalar function identity, but pg_get_functiondef refuses it.
    // Catalog errors reach the host without any error-to-absence fallback.
    const invalid = buildGroupedPostgresSchemaProbe([{ kind: "function", name: "catalog_example.total", signature: "integer" }]);
    await assert.rejects(client.query(invalid.text, invalid.values));
  } finally { await client.query("rollback"); client.release(); }
  console.log(`Packed grouped PostgreSQL catalog proof PASS (${objects.length} ordered entries; scalar equivalence, jsonb text bytes/order, strings/null aggregates, raw policy types, empty/duplicates/absence)`);
}
