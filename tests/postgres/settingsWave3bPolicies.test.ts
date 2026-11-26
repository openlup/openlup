import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  DEFAULT_COMMERCE_RETURN_REASONS,
  installCommerceReturnReasonsPolicy,
  readCommerceReturnReasonsOverride,
  readCommerceReturnReasonsPolicy,
  validateCommerceReturnReasons,
  type CommerceReturnReasonsPolicy,
} from "@openlup/platform/commerce";
import {
  DEFAULT_SHIPPING_PAYMENT_METHOD_PREFERENCES,
  createPostgresCustomerPreferencePort,
  installShippingPaymentMethodPreferencesPolicy,
  readShippingPaymentMethodPreferencesOverride,
  readShippingPaymentMethodPreferencesPolicy,
  validateShippingPaymentMethodPreferences,
  type CustomerPreferencePolicy,
  type ShippingPaymentMethodPreferencesPolicy,
} from "@openlup/platform/shipping";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import {
  assertNativeStoreForward,
  readReviewedForwardRegistry,
} from "../../scripts/reviewed-platform-forward.js";
import {
  closePostgres,
  postgresSetupTimeoutMs,
  postgresTeardownTimeoutMs,
  runPostgresContainer,
  waitForPostgresTcpReady,
  type PostgresContainer,
} from "../helpers/postgresContainer.js";

type ReturnReasonsCorpusCase = {
  name: string;
  input: string;
  accepted: boolean;
  normalized?: CommerceReturnReasonsPolicy;
  code?: string;
};

type PaymentPrefsCorpusCase = {
  name: string;
  input: string;
  accepted: boolean;
  normalized?: ShippingPaymentMethodPreferencesPolicy;
  code?: string;
};

const returnReasonsCorpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/commerce/commerce_return_reasons.json", import.meta.url),
  "utf8",
)) as ReturnReasonsCorpusCase[];

const paymentPrefsCorpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/shipping/shipping_payment_method_preferences.json", import.meta.url),
  "utf8",
)) as PaymentPrefsCorpusCase[];

const wave3bFile = readdirSync("db/platform/migrations").find(
  name => name.endsWith("_settings_wave3b_return_reasons_and_payment_preferences.sql"),
);
if (!wave3bFile) {
  throw new Error("missing *_settings_wave3b_return_reasons_and_payment_preferences.sql migration");
}
const WAVE3B_MIGRATION = `db/platform/migrations/${wave3bFile}`;
const RETURN_REASONS_KEY = "commerce_return_reasons";
const PAYMENT_PREFS_KEY = "shipping_payment_method_preferences";
const RETURN_REASONS_ERROR = "commerce_return_reasons_policy_invalid";
const PAYMENT_PREFS_ERROR = "shipping_payment_method_preferences_policy_invalid";
const PREF_AT = "2029-05-01T12:00:00.000Z";

const installation = {
  generation: "qualified-v2",
  roleMode: "installer-managed",
  migrationLogin: "postgres",
  bootstrapLogin: "postgres",
  runtimeLogin: "starter_runtime",
  restoreLogin: "starter_restore",
} as const;

let container: PostgresContainer | undefined;
let owner: Pool;
let runtime: Pool;

const newHelpers = [
  "public.commerce_return_reasons_validate(jsonb)",
  "public.commerce_return_reasons_read()",
  "public.shipping_payment_method_preferences_validate(jsonb)",
  "public.shipping_payment_method_preferences_read()",
] as const;

const replacedFunctions = [
  "public.commerce_return_request_create_owned(text,uuid,jsonb,text,text,uuid)",
  "public.customer_preference_save(uuid,uuid,text,jsonb,timestamptz)",
] as const;

async function upsertSetting(key: string, value: string | null) {
  await owner.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, value],
  );
}

async function createReturnOrderFixture() {
  const principal = randomUUID();
  const client = randomUUID();
  const order = randomUUID();
  const item = randomUUID();
  await owner.query(
    "INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)",
    [principal, `${principal}@example.invalid`],
  );
  await owner.query(
    "INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)",
    [client, `${client}@example.invalid`, principal],
  );
  await owner.query(
    `WITH o AS (
      INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,metadata)
      VALUES($1,$2,'paid','XTS',200,'{"orderDraftSnapshot":{"lines":[{"sku":"sku-1"}]}}'::jsonb) RETURNING id
    )
    INSERT INTO public.commerce_order_items(id,order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
    SELECT $3::uuid,id,1,2,100,200 FROM o`,
    [order, client, item],
  );
  return { principal, client, order, lines: [{ orderItemId: item, quantity: 1 }] };
}

async function createClientFixture() {
  const principal = randomUUID();
  const client = randomUUID();
  await owner.query(
    "INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)",
    [principal, `${principal}@example.invalid`],
  );
  await owner.query(
    "INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)",
    [client, `${client}@example.invalid`, principal],
  );
  return { principal, client };
}

beforeAll(async () => {
  container = await runPostgresContainer({
    name: `settings-wave3b-policies-${process.pid}`,
    password: "synthetic-conformance",
  });
  if (!await waitForPostgresTcpReady(container.connectionString)) {
    throw new Error("Settings Wave 3B PostgreSQL unavailable");
  }
  const password = randomUUID();
  const login = (name: string) => {
    const url = new URL(container!.connectionString);
    url.username = name;
    if (name !== "postgres") url.password = password;
    return url.toString();
  };
  const bootstrap = new Pool({ connectionString: container.connectionString });
  for (const role of [installation.runtimeLogin, installation.restoreLogin]) {
    await bootstrap.query(
      `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
    );
  }
  await bootstrap.end();
  owner = new Pool({
    connectionString: login("postgres"),
    options: `${qualifiedPostgresStartupOptions(installation)} -c timezone=UTC`,
  });
  const runner = createPostgresMigrationRunner(
    { connectionString: "injected" },
    { root: process.cwd(), installation, poolFactory: () => owner },
  );
  await runner.apply();
  expect(await runner.apply()).toEqual({ applied: [] });
  runtime = new Pool({
    connectionString: login(installation.runtimeLogin),
    options: "-c role=service_role -c timezone=UTC",
  });
}, postgresSetupTimeoutMs);

beforeEach(async () => {
  await owner.query("DELETE FROM public.commerce_settings WHERE key = ANY($1::text[])", [
    [RETURN_REASONS_KEY, PAYMENT_PREFS_KEY],
  ]);
});

afterAll(() => closePostgres(container, [owner, runtime]), postgresTeardownTimeoutMs);

it("matches Wave 3B-1 reviewed native-store forward registry and enforces search_path and grants", async () => {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as {
    baseline: { file: string };
    forward: Array<{ file: string }>;
  };
  const prefix = [manifest.baseline, ...manifest.forward.filter(unit => unit.file < WAVE3B_MIGRATION)]
    .map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
  const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  expect(() => assertNativeStoreForward(registry, WAVE3B_MIGRATION, readFileSync(WAVE3B_MIGRATION), prefix)).not.toThrow();

  for (const signature of [...newHelpers, ...replacedFunctions]) {
    const { rows } = await owner.query(
      `SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure`,
      [signature],
    );
    expect(rows[0]?.proconfig).toContain("search_path=pg_catalog, pg_temp");
  }

  for (const signature of newHelpers) {
    const { rows } = await owner.query(
      `SELECT
        has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS pub,
        has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS svc`,
      [signature],
    );
    expect(rows[0]).toEqual({ pub: false, svc: true });
  }

  await expect(runtime.query(
    "INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)",
    [RETURN_REASONS_KEY, JSON.stringify({ revision: "r1", reasons: ["damaged"] })],
  )).rejects.toMatchObject({ code: "42501" });
});

it("keeps TS and SQL validators in 1:1 parity across shared corpora and length bounds", async () => {
  for (const c of returnReasonsCorpus) {
    if (c.accepted) {
      const sqlResult = (await owner.query(
        "SELECT public.commerce_return_reasons_validate($1::jsonb) AS value",
        [c.input],
      )).rows[0].value;
      expect(sqlResult).toStrictEqual(c.normalized);
      expect(validateCommerceReturnReasons(JSON.parse(c.input))).toStrictEqual(c.normalized);
    } else {
      await expect(owner.query(
        "SELECT public.commerce_return_reasons_validate($1::jsonb)",
        [c.input],
      )).rejects.toMatchObject({ code: "22023", message: c.code });
    }
  }

  const maxReasons = Array.from({ length: 64 }, (_, i) => `r_${i}`);
  const tooManyReasons = Array.from({ length: 65 }, (_, i) => `r_${i}`);
  expect((await owner.query(
    "SELECT public.commerce_return_reasons_validate($1::jsonb) AS value",
    [JSON.stringify({ revision: "r64", reasons: maxReasons })],
  )).rows[0].value.reasons).toHaveLength(64);
  await expect(owner.query(
    "SELECT public.commerce_return_reasons_validate($1::jsonb)",
    [JSON.stringify({ revision: "r65", reasons: tooManyReasons })],
  )).rejects.toMatchObject({ code: "22023", message: RETURN_REASONS_ERROR });

  for (const c of paymentPrefsCorpus) {
    if (c.accepted) {
      const sqlResult = (await owner.query(
        "SELECT public.shipping_payment_method_preferences_validate($1::jsonb) AS value",
        [c.input],
      )).rows[0].value;
      expect(sqlResult).toStrictEqual(c.normalized);
      expect(validateShippingPaymentMethodPreferences(JSON.parse(c.input))).toStrictEqual(c.normalized);
    } else {
      await expect(owner.query(
        "SELECT public.shipping_payment_method_preferences_validate($1::jsonb)",
        [c.input],
      )).rejects.toMatchObject({ code: "22023", message: c.code });
    }
  }

  const maxMethods = Array.from({ length: 32 }, (_, i) => `m_${i}`);
  const tooManyMethods = Array.from({ length: 33 }, (_, i) => `m_${i}`);
  expect((await owner.query(
    "SELECT public.shipping_payment_method_preferences_validate($1::jsonb) AS value",
    [JSON.stringify({ revision: "m32", methodKinds: maxMethods })],
  )).rows[0].value.methodKinds).toHaveLength(32);
  await expect(owner.query(
    "SELECT public.shipping_payment_method_preferences_validate($1::jsonb)",
    [JSON.stringify({ revision: "m33", methodKinds: tooManyMethods })],
  )).rejects.toMatchObject({ code: "22023", message: PAYMENT_PREFS_ERROR });
});

it("E2: preserves default return reasons, allows custom configured codes, rejects disallowed codes, and preserves historical reads and replays", async () => {
  expect(await readCommerceReturnReasonsOverride(owner)).toBeUndefined();
  expect(await readCommerceReturnReasonsPolicy(owner)).toEqual({
    revision: "default",
    reasons: [...DEFAULT_COMMERCE_RETURN_REASONS],
  });
  expect((await runtime.query("SELECT public.commerce_return_reasons_read() AS value")).rows[0].value)
    .toEqual([...DEFAULT_COMMERCE_RETURN_REASONS]);

  const f = await createReturnOrderFixture();
  const historicalKey = randomUUID();
  const historical = (await runtime.query(
    "SELECT public.commerce_return_request_create_owned($1,$2,$3,$4,$5,$6) AS value",
    [historicalKey, f.order, JSON.stringify(f.lines), "pet_refused", "historical note", f.principal],
  )).rows[0].value;
  expect(historical).toMatchObject({ status: "requested", replayed: false });

  await expect(runtime.query(
    "SELECT public.commerce_return_request_create_owned($1,$2,$3,$4,$5,$6)",
    [randomUUID(), f.order, JSON.stringify(f.lines), "box_crushed", null, f.principal],
  )).rejects.toMatchObject({ code: "22023", message: "commerce_return_request_create_invalid_input" });

  // Install custom return reasons removing pet_refused and adding box_crushed.
  await installCommerceReturnReasonsPolicy(owner, {
    revision: "store-custom-1",
    reasons: ["damaged", "box_crushed", "other"],
  });
  expect(await readCommerceReturnReasonsOverride(owner)).toEqual({
    revision: "store-custom-1",
    reasons: ["damaged", "box_crushed", "other"],
  });

  // Historical row still readable and idempotent replay still succeeds!
  const storedHistorical = (await owner.query(
    "SELECT reason_code FROM public.commerce_return_requests WHERE id=$1",
    [historical.returnRequestId],
  )).rows[0];
  expect(storedHistorical.reason_code).toBe("pet_refused");

  const replayed = (await runtime.query(
    "SELECT public.commerce_return_request_create_owned($1,$2,$3,$4,$5,$6) AS value",
    [historicalKey, f.order, JSON.stringify(f.lines), "pet_refused", "historical note", f.principal],
  )).rows[0].value;
  expect(replayed).toEqual({
    returnRequestId: historical.returnRequestId,
    status: "requested",
    replayed: true,
  });

  // New insert with removed pet_refused is rejected.
  await expect(runtime.query(
    "SELECT public.commerce_return_request_create_owned($1,$2,$3,$4,$5,$6)",
    [randomUUID(), f.order, JSON.stringify(f.lines), "pet_refused", null, f.principal],
  )).rejects.toMatchObject({ code: "22023", message: "commerce_return_request_create_invalid_input" });

  // New insert with custom box_crushed succeeds.
  const customCreated = (await runtime.query(
    "SELECT public.commerce_return_request_create_owned($1,$2,$3,$4,$5,$6) AS value",
    [randomUUID(), f.order, JSON.stringify(f.lines), "box_crushed", "crushed corner", f.principal],
  )).rows[0].value;
  expect(customCreated).toMatchObject({ status: "requested", replayed: false });
  expect((await owner.query(
    "SELECT reason_code FROM public.commerce_return_requests WHERE id=$1",
    [customCreated.returnRequestId],
  )).rows[0].reason_code).toBe("box_crushed");

  // Table-level format CHECK rejects invalid raw codes.
  for (const invalidCode of ["BadCode", "bad code", "a", "bad-code"]) {
    await expect(owner.query(
      "INSERT INTO public.commerce_return_requests(order_id,requested_by,reason_code) VALUES($1,$2,$3)",
      [f.order, f.client, invalidCode],
    )).rejects.toMatchObject({ code: "23514" });
  }
});

it("E2: fails closed with 22023 on malformed commerce_return_reasons policy rows", async () => {
  const f = await createReturnOrderFixture();
  for (const bad of [null, "{bad-json", "{}", JSON.stringify({ revision: "r", reasons: [] }), JSON.stringify({ revision: "r", reasons: ["damaged", "damaged"] }), JSON.stringify({ revision: "r", reasons: ["BadCode"] })]) {
    await upsertSetting(RETURN_REASONS_KEY, bad);
    await expect(runtime.query("SELECT public.commerce_return_reasons_read()"))
      .rejects.toMatchObject({ code: "22023", message: RETURN_REASONS_ERROR });
    await expect(runtime.query(
      "SELECT public.commerce_return_request_create_owned($1,$2,$3,$4,$5,$6)",
      [randomUUID(), f.order, JSON.stringify(f.lines), "damaged", null, f.principal],
    )).rejects.toMatchObject({ code: "22023", message: RETURN_REASONS_ERROR });
  }
});

it("E3: preserves default payment preferences, allows custom configured codes, rejects disallowed codes, and preserves historical reads", async () => {
  expect(await readShippingPaymentMethodPreferencesOverride(owner)).toBeUndefined();
  expect(await readShippingPaymentMethodPreferencesPolicy(owner)).toEqual({
    revision: "default",
    methodKinds: [...DEFAULT_SHIPPING_PAYMENT_METHOD_PREFERENCES],
  });
  expect((await runtime.query("SELECT public.shipping_payment_method_preferences_read() AS value")).rows[0].value)
    .toEqual([...DEFAULT_SHIPPING_PAYMENT_METHOD_PREFERENCES]);

  const f = await createClientFixture();
  const savedLegacy = (await runtime.query(
    "SELECT public.customer_preference_save($1,$2,'payment',$3,$4) AS value",
    [f.principal, f.client, JSON.stringify({ scope: "one_time", methodKind: "transfer" }), PREF_AT],
  )).rows[0].value;
  expect(savedLegacy.method_kind).toBe("transfer");

  await expect(runtime.query(
    "SELECT public.customer_preference_save($1,$2,'payment',$3,$4)",
    [f.principal, f.client, JSON.stringify({ scope: "subscription", methodKind: "wallet_express" }), PREF_AT],
  )).rejects.toMatchObject({ code: "22023", message: "customer_preference_invalid_payment_method" });

  // Install custom payment methods removing transfer and adding wallet_express.
  await installShippingPaymentMethodPreferencesPolicy(owner, {
    revision: "store-pay-1",
    methodKinds: ["instant", "card", "wallet_express"],
  });
  expect(await readShippingPaymentMethodPreferencesOverride(owner)).toEqual({
    revision: "store-pay-1",
    methodKinds: ["instant", "card", "wallet_express"],
  });

  // Historical transfer preference remains readable via SQL and TS port.
  const readBack = (await runtime.query(
    "SELECT public.customer_preferences_read($1,$2) AS value",
    [f.principal, f.client],
  )).rows[0].value;
  expect(readBack.payment).toEqual([expect.objectContaining({ scope: "one_time", method_kind: "transfer" })]);

  const customPolicy: CustomerPreferencePolicy = {
    methods: { instant: "instant", card: "card", wallet_express: "wallet-express" },
    providers: { warehouse: "warehouse-a", carrier: "carrier-a", manual: "manual-a", simulator: "simulator-a" },
  };
  const port = createPostgresCustomerPreferencePort(runtime, { principalId: f.principal, clientId: f.client }, customPolicy, {
    now: () => PREF_AT,
    readOrdererHints: async () => [],
  });
  const listed = await port.listPaymentPreferences(f.principal);
  expect(listed).toEqual([expect.objectContaining({ scope: "one_time", methodKind: "transfer" })]);

  // Saving disallowed transfer fails.
  await expect(runtime.query(
    "SELECT public.customer_preference_save($1,$2,'payment',$3,$4)",
    [f.principal, f.client, JSON.stringify({ scope: "any", methodKind: "transfer" }), PREF_AT],
  )).rejects.toMatchObject({ code: "22023", message: "customer_preference_invalid_payment_method" });

  // Saving custom wallet_express succeeds via TS port and SQL.
  const upserted = await port.upsertPaymentPreference(f.principal, {
    scope: "subscription",
    methodKind: "wallet-express",
  });
  expect(upserted).toEqual(expect.objectContaining({ scope: "subscription", methodKind: "wallet-express" }));

  // Table-level format CHECK rejects invalid raw codes.
  for (const invalidCode of ["BadMethod", "bad method", "a", "wallet-express"]) {
    await expect(owner.query(
      "INSERT INTO public.customer_payment_preferences(client_id,scope,method_kind,last_selected_at,updated_at) VALUES($1,'any',$2,$3,$3)",
      [f.client, invalidCode, PREF_AT],
    )).rejects.toMatchObject({ code: "23514" });
  }
});

it("E3: fails closed with 22023 on malformed shipping_payment_method_preferences policy rows", async () => {
  const f = await createClientFixture();
  for (const bad of [null, "{bad-json", "{}", JSON.stringify({ revision: "r", methodKinds: [] }), JSON.stringify({ revision: "r", methodKinds: ["card", "card"] }), JSON.stringify({ revision: "r", methodKinds: ["BadMethod"] })]) {
    await upsertSetting(PAYMENT_PREFS_KEY, bad);
    await expect(runtime.query("SELECT public.shipping_payment_method_preferences_read()"))
      .rejects.toMatchObject({ code: "22023", message: PAYMENT_PREFS_ERROR });
    await expect(runtime.query(
      "SELECT public.customer_preference_save($1,$2,'payment',$3,$4)",
      [f.principal, f.client, JSON.stringify({ scope: "any", methodKind: "card" }), PREF_AT],
    )).rejects.toMatchObject({ code: "22023", message: PAYMENT_PREFS_ERROR });
  }
});
