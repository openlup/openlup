// Executor-level companion to full-schema feedback_media_confirm_upload_test.sql.
// Supabase image 17.6.1.106 crashes on reserved-role EXECUTE refusal (upstream
// postgres #2112). Use real bodies + the exact forward in stock PostgreSQL so a
// missing container or refusal assertion is a failure, never a security pass.
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dockerAvailable, runPostgresContainer, waitForPostgresTcpReady,
  type PostgresContainer,
} from "../helpers/postgresContainer.js";

const FORWARD = "supabase/migrations/20260907201500_feedback_media_service_only.sql";
const HISTORY = "supabase/migrations/20260428170000_feedback_rpc_rls_hardening.sql";
const APPEND_THREE = "supabase/migrations/20260711170019_feedback_media_confirm_upload_contract.sql";
const TESTER = "f5100000-0000-0000-0000-000000000001";
const OTHER_TESTER = "f5100000-0000-0000-0000-000000000002";
const KEY = `${TESTER}/c/photo.jpg`;
const OTHER_KEY = `${TESTER}/c/other.jpg`;
const ROUTINES = [
  { name: "feedback_add_photo_url_by_hash", signature: "text,text,integer", args: "$1::text,$2::text,10" },
  { name: "feedback_remove_photo_url_by_hash", signature: "text,text", args: "$1::text,$2::text" },
  { name: "append_feedback_photo_url", signature: "text,text,integer", args: "$1::text,$2::text,10" },
] as const;
const APPENDS = [
  { name: "append_feedback_photo_url", signature: "text,text", args: "$1::text,$2::text" },
  { name: "append_feedback_photo_url", signature: "text,text,integer", args: "$1::text,$2::text,10" },
] as const;

// Observed schema-only artifact implementation (formatting normalized):
// run 34142421217, SHA-256
// 870907fb548a68d615e3f441d4001eda294690286d0d73c5af0cdccda90fd1b0,
// lines 5833-5872. It intentionally models the observed weak deployed overload.
const DEPLOYED_APPEND_TWO = `
CREATE OR REPLACE FUNCTION "public"."append_feedback_photo_url"("p_hash" "text", "p_storage_key" "text") RETURNS TABLE("new_count" integer, "was_appended" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_was_already_present boolean;
  v_new_count int;
BEGIN
  -- Lock the row first, check for key presence, then UPDATE.
  -- SELECT ... FOR UPDATE serializes concurrent transactions on this row.

  SELECT p_storage_key = ANY(COALESCE(photo_urls, ARRAY[]::text[]))
  INTO v_was_already_present
  FROM public.feedback
  WHERE hash = p_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Feedback not found for hash: %', p_hash USING ERRCODE = 'P0002';
  END IF;

  IF v_was_already_present THEN
    -- Idempotent replay — no DB change
    SELECT COALESCE(array_length(photo_urls, 1), 0)
    INTO v_new_count
    FROM public.feedback
    WHERE hash = p_hash;
  ELSE
    -- Append the key
    UPDATE public.feedback
    SET photo_urls = COALESCE(photo_urls, ARRAY[]::text[]) || p_storage_key,
        updated_at = NOW()
    WHERE hash = p_hash
    RETURNING COALESCE(array_length(photo_urls, 1), 0) INTO v_new_count;
  END IF;

  RETURN QUERY SELECT v_new_count, NOT v_was_already_present;
END;
$$;`;

let container: PostgresContainer | undefined;
let pool: Pool;
let forward: string;
let history: string;

function definition(source: string, name: string): string {
  const matches = source.match(new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "g",
  ));
  expect(matches).toHaveLength(1);
  return matches![0];
}

async function withRole<T>(role: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function callAsRole(role: string, sql: string, key = KEY): Promise<QueryResult> {
  return withRole(role, (client) => client.query(sql, ["hash-delivered", key]));
}

async function resetFixture(): Promise<void> {
  await pool.query(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    GRANT USAGE ON SCHEMA public TO PUBLIC;
    CREATE TABLE public.testers (id uuid PRIMARY KEY, delivered_at timestamptz);
    CREATE TABLE public.feedback (
      id uuid PRIMARY KEY, tester_id uuid REFERENCES public.testers(id),
      hash text UNIQUE, photo_urls text[], updated_at timestamptz DEFAULT now()
    );
    INSERT INTO public.testers VALUES ('${TESTER}', now()), ('${OTHER_TESTER}', NULL);
    INSERT INTO public.feedback VALUES
      ('f5200000-0000-0000-0000-000000000001', '${TESTER}', 'hash-delivered', ARRAY['${KEY}'], now()),
      ('f5200000-0000-0000-0000-000000000002', '${OTHER_TESTER}', 'hash-undelivered', ARRAY[]::text[], now());
  `);
}

async function grantAndProvePredecessors(
  routines: readonly { name: string; signature: string; args: string }[],
): Promise<void> {
  for (const { name, signature, args } of routines) {
    await pool.query(`GRANT EXECUTE ON FUNCTION public.${name}(${signature}) TO anon, authenticated, service_role`);
    for (const role of ["anon", "authenticated"]) {
      expect((await pool.query(
        "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
        [role, `public.${name}(${signature})`],
      )).rows).toEqual([{ allowed: true }]);
      expect((await callAsRole(role, `SELECT * FROM public.${name}(${args})`)).rows).toHaveLength(1);
    }
  }
}

async function expectDeniedWithoutWrite(
  role: string,
  routine: { name: string; args: string },
  isolateAppendTwo = false,
): Promise<void> {
  const before = await pool.query("SELECT * FROM public.feedback ORDER BY id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isolateAppendTwo) {
      // PostgreSQL cannot resolve append-2 while append-3 has a default. Drop
      // only inside this transaction, invoke the exact surviving identity, and
      // roll the isolation change back with the expected permission error.
      await client.query("DROP FUNCTION public.append_feedback_photo_url(text,text,integer)");
    }
    await client.query(`SET LOCAL ROLE ${role}`);
    await expect(client.query(
      `SELECT * FROM public.${routine.name}(${routine.args})`, ["hash-delivered", KEY],
    )).rejects.toMatchObject({ code: "42501" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  expect((await pool.query("SELECT * FROM public.feedback ORDER BY id")).rows).toEqual(before.rows);
}

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
  `);
  [forward, history] = await Promise.all([readFile(FORWARD, "utf8"), readFile(HISTORY, "utf8")]);
  expect(definition(forward, "feedback_remove_photo_url_by_hash"))
    .toBe(definition(history, "feedback_remove_photo_url_by_hash"));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.remove();
});

describe("feedback media authority forward", () => {
  it("retains all six clean-history predecessor controls, then closes every browser call", async () => {
    await resetFixture();
    await pool.query(definition(history, "feedback_add_photo_url_by_hash"));
    await pool.query(definition(history, "feedback_remove_photo_url_by_hash"));
    await pool.query(await readFile(APPEND_THREE, "utf8"));
    await grantAndProvePredecessors(ROUTINES);
    await pool.query(forward);

    for (const role of ["anon", "authenticated"]) {
      for (const routine of ROUTINES) await expectDeniedWithoutWrite(role, routine);
    }

    await pool.query("UPDATE public.feedback SET photo_urls = ARRAY[]::text[] WHERE hash = 'hash-delivered'");
    await withRole("service_role", async (client) => {
      const append = "SELECT * FROM public.append_feedback_photo_url($1::text,$2::text,10)";
      expect((await client.query(append, ["hash-delivered", KEY])).rows)
        .toEqual([{ was_appended: true, new_count: 1 }]);
      expect((await client.query(append, ["hash-delivered", KEY])).rows)
        .toEqual([{ was_appended: false, new_count: 1 }]);
      expect((await client.query(
        "SELECT * FROM public.feedback_remove_photo_url_by_hash($1::text,$2::text)", ["hash-delivered", KEY],
      )).rows).toEqual([{ photo_urls: [], remaining_count: 0, removed: true }]);
      await client.query("RESET ROLE");
      expect((await client.query("SELECT photo_urls FROM public.feedback WHERE hash = 'hash-delivered'")).rows)
        .toEqual([{ photo_urls: [] }]);
    });
  });

  it("repairs the production-shaped function set without recreating or rewriting optional identities", async () => {
    await resetFixture();
    await pool.query(DEPLOYED_APPEND_TWO);
    await grantAndProvePredecessors([APPENDS[0]]);
    const appendTwoBefore = (await pool.query(
      "SELECT pg_get_functiondef('public.append_feedback_photo_url(text,text)'::regprocedure) AS source",
    )).rows[0].source;
    await pool.query(await readFile(APPEND_THREE, "utf8"));
    expect((await pool.query(
      "SELECT to_regprocedure('public.feedback_add_photo_url_by_hash(text,text,integer)') AS add, to_regprocedure('public.feedback_remove_photo_url_by_hash(text,text)') AS remove",
    )).rows).toEqual([{ add: null, remove: null }]);
    await grantAndProvePredecessors([APPENDS[1]]);

    await pool.query(forward);

    expect((await pool.query(
      "SELECT to_regprocedure('public.feedback_add_photo_url_by_hash(text,text,integer)') AS add, to_regprocedure('public.feedback_remove_photo_url_by_hash(text,text)') IS NOT NULL AS remove",
    )).rows).toEqual([{ add: null, remove: true }]);
    expect((await pool.query(
      "SELECT pg_get_functiondef('public.append_feedback_photo_url(text,text)'::regprocedure) AS source",
    )).rows[0].source).toBe(appendTwoBefore);
    await expect(callAsRole(
      "anon", "SELECT * FROM public.append_feedback_photo_url($1,$2)",
    )).rejects.toMatchObject({ code: "42725" });

    for (const role of ["anon", "authenticated"]) {
      for (const routine of APPENDS) {
        expect((await pool.query(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [role, `public.${routine.name}(${routine.signature})`],
        )).rows).toEqual([{ allowed: false }]);
      }
      await expectDeniedWithoutWrite(role, APPENDS[0], true);
      await expectDeniedWithoutWrite(role, APPENDS[1]);
      await expectDeniedWithoutWrite(role, ROUTINES[1]);
    }
    for (const routine of APPENDS) {
      expect((await pool.query(
        "SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS allowed",
        [`public.${routine.name}(${routine.signature})`],
      )).rows).toEqual([{ allowed: true }]);
    }
    expect((await pool.query(
      "SELECT pg_get_functiondef('public.append_feedback_photo_url(text,text)'::regprocedure) AS source",
    )).rows[0].source).toBe(appendTwoBefore);

    await pool.query("UPDATE public.feedback SET photo_urls = ARRAY[]::text[] WHERE hash = 'hash-delivered'");
    await withRole("service_role", async (client) => {
      const append = "SELECT * FROM public.append_feedback_photo_url($1::text,$2::text,10)";
      expect((await client.query(append, ["hash-delivered", KEY])).rows)
        .toEqual([{ was_appended: true, new_count: 1 }]);
      expect((await client.query(append, ["hash-delivered", KEY])).rows)
        .toEqual([{ was_appended: false, new_count: 1 }]);
      await expect(client.query(append, ["hash-undelivered", `${OTHER_TESTER}/c/photo.jpg`]))
        .rejects.toThrow("Feedback media unlocks after delivery");
    });

    const fullKeys = Array.from({ length: 10 }, (_, index) => `${TESTER}/c/${index}.jpg`);
    await pool.query("UPDATE public.feedback SET photo_urls = $1 WHERE hash = 'hash-delivered'", [fullKeys]);
    expect((await callAsRole(
      "service_role", "SELECT * FROM public.append_feedback_photo_url($1::text,$2::text,10)", fullKeys[0],
    )).rows).toEqual([{ was_appended: false, new_count: 10 }]);
    await expect(callAsRole("service_role", "SELECT * FROM public.append_feedback_photo_url($1::text,$2::text,10)"))
      .rejects.toThrow("feedback media limit exceeded");
    expect((await pool.query("SELECT photo_urls FROM public.feedback WHERE hash = 'hash-delivered'")).rows)
      .toEqual([{ photo_urls: fullKeys }]);

    await pool.query("UPDATE public.feedback SET photo_urls = $1 WHERE hash = 'hash-delivered'", [[KEY, OTHER_KEY]]);
    await withRole("service_role", async (client) => {
      expect((await client.query(
        "SELECT * FROM public.feedback_remove_photo_url_by_hash($1::text,$2::text)",
        ["hash-delivered", OTHER_KEY],
      )).rows).toEqual([{ photo_urls: [KEY], remaining_count: 1, removed: true }]);
      await client.query("RESET ROLE");
      expect((await client.query("SELECT photo_urls FROM public.feedback WHERE hash = 'hash-delivered'")).rows)
        .toEqual([{ photo_urls: [KEY] }]);
    });
    for (const invalidKey of [`${OTHER_TESTER}/c/photo.jpg`, `${TESTER}/c/unassociated.jpg`]) {
      await expect(callAsRole(
        "service_role", "SELECT * FROM public.feedback_remove_photo_url_by_hash($1::text,$2::text)", invalidKey,
      )).rejects.toMatchObject({ code: "P0001" });
    }
    expect((await pool.query("SELECT photo_urls FROM public.feedback WHERE hash = 'hash-delivered'")).rows)
      .toEqual([{ photo_urls: [KEY, OTHER_KEY] }]);
  });

  it("fails closed and rolls back all changes when required append-3 is missing", async () => {
    await resetFixture();
    await pool.query(DEPLOYED_APPEND_TWO);
    await pool.query(
      "GRANT EXECUTE ON FUNCTION public.append_feedback_photo_url(text,text) TO anon, authenticated, service_role",
    );
    const client = await pool.connect();
    try {
      await expect(client.query(forward)).rejects.toMatchObject({ code: "42883" });
      await client.query("ROLLBACK");
      expect((await client.query(
        "SELECT to_regprocedure('public.feedback_remove_photo_url_by_hash(text,text)') AS remove, has_function_privilege('anon', 'public.append_feedback_photo_url(text,text)', 'EXECUTE') AS append_allowed",
      )).rows).toEqual([{ remove: null, append_allowed: true }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
