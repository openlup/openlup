// Executor companion to the full-chain pgTAP media test: use the selected
// function bodies and explicit ACLs in stock PostgreSQL to prove actual browser
// denial without the Supabase image's reserved-role denial-hint crash.
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectiveFunctionBody } from "../../src/test/effectiveMigration";
import { functionAclStatements } from "../../src/test/historicalBoundarySchema";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const TESTER = "f5100000-0000-0000-0000-000000000001";
const OTHER = "f5100000-0000-0000-0000-000000000002";
const KEY = `${TESTER}/c/photo.jpg`;
const ROUTINES = [
  { name: "feedback_add_photo_url_by_hash", signature: "text,text,integer", args: "$1::text,$2::text,10" },
  { name: "feedback_remove_photo_url_by_hash", signature: "text,text", args: "$1::text,$2::text" },
  { name: "append_feedback_photo_url", signature: "text,text,integer", args: "$1::text,$2::text,10" },
] as const;
let container: PostgresContainer | undefined;
let pool: Pool | undefined;

beforeAll(async () => {
  expect(await dockerAvailable(), "Docker required for actual ACL denial proof").toBe(true);
  container = await runPostgresContainer({ name: `feedback-media-acl-${process.pid}`, password: "feedback-test" });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  const pg = await import("pg");
  const PoolCtor = pg.default?.Pool ?? pg.Pool;
  pool = new PoolCtor({ connectionString: container.connectionString });
  await pool.query(`
    CREATE ROLE anon NOLOGIN INHERIT;
    CREATE ROLE authenticated NOLOGIN INHERIT;
    CREATE ROLE service_role NOLOGIN INHERIT BYPASSRLS;
    CREATE TABLE public.testers (id uuid PRIMARY KEY, delivered_at timestamptz);
    CREATE TABLE public.feedback (
      id uuid PRIMARY KEY, tester_id uuid REFERENCES public.testers(id),
      hash text UNIQUE, photo_urls text[], updated_at timestamptz DEFAULT now()
    );
    INSERT INTO public.testers VALUES ('${TESTER}', now()), ('${OTHER}', NULL);
    INSERT INTO public.feedback VALUES
      ('f5200000-0000-0000-0000-000000000001', '${TESTER}', 'hash-delivered', ARRAY['${KEY}'], now()),
      ('f5200000-0000-0000-0000-000000000002', '${OTHER}', 'hash-undelivered', ARRAY[]::text[], now());
  `);
  for (const { name } of ROUTINES) {
    await pool.query(effectiveFunctionBody(name));
    await pool.query(functionAclStatements(name).join("\n"));
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.remove();
});

async function withRole<T>(role: "anon" | "authenticated" | "service_role", run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function call(role: "anon" | "authenticated" | "service_role", routine: typeof ROUTINES[number], hash = "hash-delivered", key = KEY) {
  return withRole(role, (client) => client.query(`SELECT * FROM public.${routine.name}(${routine.args})`, [hash, key]));
}

describe("selected feedback media executor authority", () => {
  it("denies all six browser calls without writes while service calls really execute", async () => {
    for (const routine of ROUTINES) {
      for (const role of ["anon", "authenticated"] as const) {
        expect((await pool!.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, `public.${routine.name}(${routine.signature})`])).rows)
          .toEqual([{ allowed: false }]);
        const before = (await pool!.query("SELECT * FROM public.feedback ORDER BY id")).rows;
        await expect(call(role, routine)).rejects.toMatchObject({ code: "42501" });
        expect((await pool!.query("SELECT * FROM public.feedback ORDER BY id")).rows).toEqual(before);
      }
      expect((await pool!.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS allowed", [`public.${routine.name}(${routine.signature})`])).rows)
        .toEqual([{ allowed: true }]);
      // A real positive call prevents a broken body/setup from masquerading as
      // permission proof. Each routine starts with an associated media key.
      await pool!.query("UPDATE public.feedback SET photo_urls = ARRAY[$1::text] WHERE hash = 'hash-delivered'", [KEY]);
      expect((await call("service_role", routine)).rows).toHaveLength(1);
    }
  });

  it("preserves delivered-only confirmation, replay, capacity and scoped removal", async () => {
    const append = ROUTINES[2];
    const remove = ROUTINES[1];
    await pool!.query("UPDATE public.feedback SET photo_urls = ARRAY[]::text[] WHERE hash = 'hash-delivered'");
    expect((await call("service_role", append)).rows).toEqual([{ was_appended: true, new_count: 1 }]);
    expect((await call("service_role", append)).rows).toEqual([{ was_appended: false, new_count: 1 }]);
    const before = (await pool!.query("SELECT * FROM public.feedback ORDER BY id")).rows;
    await expect(call("service_role", append, "hash-undelivered", `${OTHER}/c/photo.jpg`)).rejects.toThrow("Feedback media unlocks after delivery");
    await expect(call("service_role", append, "hash-delivered", `${OTHER}/c/photo.jpg`)).rejects.toThrow("storage_key does not match tester");
    expect((await pool!.query("SELECT * FROM public.feedback ORDER BY id")).rows).toEqual(before);

    const fullKeys = Array.from({ length: 10 }, (_, index) => `${TESTER}/c/${index}.jpg`);
    await pool!.query("UPDATE public.feedback SET photo_urls = $1 WHERE hash = 'hash-delivered'", [fullKeys]);
    expect((await call("service_role", append, "hash-delivered", fullKeys[0])).rows).toEqual([{ was_appended: false, new_count: 10 }]);
    await expect(call("service_role", append)).rejects.toThrow("feedback media limit exceeded");
    expect((await pool!.query("SELECT photo_urls FROM public.feedback WHERE hash = 'hash-delivered'")).rows).toEqual([{ photo_urls: fullKeys }]);

    const otherKey = `${TESTER}/c/other.jpg`;
    await pool!.query("UPDATE public.feedback SET photo_urls = $1 WHERE hash = 'hash-delivered'", [[KEY, otherKey]]);
    expect((await call("service_role", remove, "hash-delivered", otherKey)).rows).toEqual([{ photo_urls: [KEY], remaining_count: 1, removed: true }]);
    for (const invalidKey of [`${OTHER}/c/photo.jpg`, `${TESTER}/c/unassociated.jpg`]) {
      await expect(call("service_role", remove, "hash-delivered", invalidKey)).rejects.toMatchObject({ code: "P0001" });
    }
    expect((await pool!.query("SELECT photo_urls FROM public.feedback WHERE hash = 'hash-delivered'")).rows).toEqual([{ photo_urls: [KEY] }]);
  });
});
