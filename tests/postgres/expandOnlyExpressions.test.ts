/** PG16 witnesses: refused expressions remain valid SQL with observable effects. */
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isExpandOnlyPlatformForward } from "../../scripts/reviewed-platform-forward.ts";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined;
let pool: Pool | undefined;
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Expand-only expression conformance requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `expand-only-expressions-${process.pid}`, password: "synthetic-conformance", image: "postgres:16" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
}, 120000);
afterAll(async () => { await pool?.end(); await container?.remove(); });

it.each([
  ["INSERT TABLE union before VALUES", "CREATE TABLE public.example (value text); INSERT INTO public.example (value) TABLE public.existing UNION ALL VALUES ('next') ON CONFLICT DO NOTHING;", "SELECT count(*) = 1 AS observed FROM public.example WHERE value = 'prior'"],
  ["INSERT parenthesized TABLE with LIMIT call", "CREATE TABLE public.example (value text); INSERT INTO public.example (value) (TABLE public.existing LIMIT pg_catalog.setval('public.app_sequence', 42)) UNION VALUES ('next') ON CONFLICT DO NOTHING;", "SELECT last_value = 42 AS observed FROM public.app_sequence"],
  ["CREATE SCHEMA GRANT element", "CREATE SCHEMA example GRANT ALL ON public.existing TO PUBLIC;", "SELECT EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.existing'::regclass AND a.grantee = 0 AND a.privilege_type = 'SELECT') AS observed"],
  ["sequence column ownership", "CREATE SEQUENCE public.example OWNED BY public.existing.value;", "SELECT EXISTS (SELECT 1 FROM pg_depend WHERE classid = 'pg_class'::regclass AND objid = 'public.example'::regclass AND refclassid = 'pg_class'::regclass AND refobjid = 'public.existing'::regclass AND refobjsubid = 1 AND deptype = 'a') AS observed"],
  ["OPERATOR reference", "CREATE TABLE public.example (value int CHECK (value OPERATOR(public.+) 1 = 2)); INSERT INTO public.example VALUES (1) ON CONFLICT DO NOTHING;", "SELECT count(*) = 1 AS observed FROM public.app_call_log"],
  ["generated column call", "CREATE TABLE public.example (value text, normalized text GENERATED ALWAYS AS (public.app_index_value(value)) STORED); INSERT INTO public.example (value) VALUES ('prior') ON CONFLICT DO NOTHING;", "SELECT count(*) = 1 AS observed FROM public.app_call_log"],
  ["index WHERE call", "CREATE INDEX example_value ON public.existing (value) WHERE public.app_index_value(value) = 'recordedprior';", "SELECT count(*) = 1 AS observed FROM public.app_call_log"],
  ["DEFAULT call with seed INSERT", "CREATE TABLE public.example (id int, value text DEFAULT public.app_record_call()); INSERT INTO public.example (id) VALUES (1) ON CONFLICT DO NOTHING;", "SELECT count(*) = 1 AS observed FROM public.app_call_log"],
  ["CHECK call with seed INSERT", "CREATE TABLE public.example (value text CHECK (public.app_record_call() = 'recorded')); INSERT INTO public.example (value) VALUES ('recorded') ON CONFLICT DO NOTHING;", "SELECT count(*) = 1 AS observed FROM public.app_call_log"],
  ["CTAS VALUES call", "CREATE TABLE public.example AS VALUES (public.app_record_call());", "SELECT count(*) = 1 AS observed FROM public.app_call_log"],
  ["CTAS VALUES sequence call", "CREATE TABLE public.example AS VALUES (pg_catalog.setval('public.app_sequence', 42));", "SELECT last_value = 42 AS observed FROM public.app_sequence"],
  ["CTAS VALUES setting call", "CREATE TABLE public.example AS VALUES (pg_catalog.set_config('app.admission', 'changed', true));", "SELECT current_setting('app.admission') = 'changed' AS observed"],
  ["CTAS TABLE copy", "CREATE TABLE public.example AS TABLE public.existing;", "SELECT count(*) = 1 AND min(value) = 'prior' AS observed FROM public.example"],
  ["index key expression call", "CREATE INDEX example_value ON public.existing (public.app_index_value(value));", "SELECT count(*) = 1 AS observed FROM public.app_call_log"],
  ["PARTITION OF", "CREATE TABLE public.example PARTITION OF public.existing_parent FOR VALUES IN (1);", "SELECT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = 'public.example'::regclass AND inhparent = 'public.existing_parent'::regclass) AS observed"],
])("refuses %s while PG16 executes it", async (_label, sql, observation) => {
  expect(isExpandOnlyPlatformForward(sql)).toBe(false);
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE public.existing (value text);
      INSERT INTO public.existing VALUES ('prior');
      REVOKE ALL ON public.existing FROM PUBLIC;
      CREATE SEQUENCE public.app_sequence START WITH 1;
      CREATE TABLE public.app_call_log (value text);
      CREATE FUNCTION public.app_record_call() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
      BEGIN
        INSERT INTO public.app_call_log VALUES ('recorded');
        RETURN 'recorded';
      END $$;
      -- Index expressions require an IMMUTABLE declaration; a nested volatile call still executes.
      CREATE FUNCTION public.app_index_value(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
      BEGIN
        RETURN public.app_record_call() || value;
      END $$;
      CREATE FUNCTION public.app_operator(left_value int, right_value int) RETURNS int LANGUAGE plpgsql VOLATILE AS $$
      BEGIN
        PERFORM public.app_record_call();
        RETURN left_value + right_value;
      END $$;
      CREATE OPERATOR public.+ (LEFTARG = int, RIGHTARG = int, FUNCTION = public.app_operator);
      CREATE TABLE public.existing_parent (id int) PARTITION BY LIST (id);
    `);
    expect((await client.query("SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.existing'::regclass AND a.grantee = 0")).rows[0].count).toBe("0");
    expect((await client.query("SELECT last_value FROM public.app_sequence")).rows[0].last_value).toBe("1");
    expect((await client.query("SELECT count(*) FROM public.app_call_log")).rows[0].count).toBe("0");
    await client.query(sql);
    expect((await client.query(observation)).rows).toEqual([{ observed: true }]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
