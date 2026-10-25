import { describe, expect, it, vi } from "vitest";
import { CONFIGURATOR_INTENT_VERSION, CHECKOUT_COMMAND_V1 } from "../../src/commerce/index.js";
import { createSupabaseConfiguratorIntentPersistencePort, type ConfiguratorIntentSupabaseClient, type CheckoutCommandV1 } from "./storeTestFixtures.js";
import { ConfiguratorIntentPersistenceConflictError } from "../../src/commerce/server/index.js";
const COMMERCE_CURRENCIES = ["XTS"];

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const SUBJECT_ID = "22222222-2222-4222-8222-222222222222";
const ADDRESS_ID = "33333333-3333-4333-8333-333333333333";

/** Narrow a hand-rolled stub to the client shape the port expects. */
function asClient(stub: unknown): ConfiguratorIntentSupabaseClient {
  return stub as ConfiguratorIntentSupabaseClient;
}

/** The port under test. One named construction site for the whole suite. */
function portFor(client: ConfiguratorIntentSupabaseClient) {
  return createSupabaseConfiguratorIntentPersistencePort(client);
}

function completedPayload() {
  return {
    contractVersion: "commerce.configurator_intent_persistence.v1",
    intentVersion: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-1999-06-05-example",
    clientId: CLIENT_ID,
    subjectId: SUBJECT_ID,
    addressId: ADDRESS_ID,
    clientMatchReason: "client_match_exact_email",
    replayed: false,
  };
}

/** Minimal chainable stub for `.from(...).select(...).eq(...).eq(...).eq(...).limit(...)`. */
function selectClient(result: { data: unknown; error: unknown }) {
  const limit = vi.fn(async () => result);
  const builder = { eq: vi.fn(() => builder), limit };
  const select = vi.fn(() => builder);
  const from = vi.fn(() => ({ select }));
  return { client: asClient({ from }), from, select, builder, limit };
}

describe("supabaseConfiguratorIntentPersistencePort — findCompletedIdentity", () => {
  it("returns the parsed identity stored on the completed key", async () => {
    const { client, from, builder, limit } = selectClient({
      data: [{ response_payload: completedPayload() }],
      error: null,
    });
    const port = portFor(client);

    const identity = await port.findCompletedIdentity!("intent-1999-06-05-example");

    expect(from).toHaveBeenCalledWith("commerce_idempotency_keys");
    expect(builder.eq).toHaveBeenCalledWith("scope", "commerce_configurator_intent");
    expect(builder.eq).toHaveBeenCalledWith("idempotency_key", "intent-1999-06-05-example");
    expect(builder.eq).toHaveBeenCalledWith("status", "completed");
    expect(limit).toHaveBeenCalledWith(1);
    expect(identity).toEqual(completedPayload());
  });

  it("returns null when no completed row exists", async () => {
    const { client } = selectClient({ data: [], error: null });
    const port = portFor(client);

    expect(await port.findCompletedIdentity!("missing-key-123")).toBeNull();
  });

  it("returns null when the stored payload is not a valid identity", async () => {
    const { client } = selectClient({
      data: [{ response_payload: { contractVersion: "garbage" } }],
      error: null,
    });
    const port = portFor(client);

    expect(await port.findCompletedIdentity!("intent-1999-06-05-example")).toBeNull();
  });

  it("throws on a transport error so the caller can fail-safe to 409", async () => {
    const { client } = selectClient({ data: null, error: { message: "boom" } });
    const port = portFor(client);

    await expect(port.findCompletedIdentity!("intent-1999-06-05-example")).rejects.toThrow(/boom/);
  });
});

function rpcClient() {
  const rpc = vi.fn(async () => ({ data: completedPayload(), error: null }));
  return { client: asClient({ rpc }), rpc };
}

function intentWithPhone(phone: string) {
  return {
    version: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-1999-06-05-example",
    contact: { firstName: "Buyer", lastName: "Example", email: "buyer@example.test", phone },
    address: { street: "Example 1", postalCode: "00-001", city: "Example", country: "AA" },
  } as never;
}

function commandWithPhone(phone: string, country: string): CheckoutCommandV1 {
  return {
    version: CHECKOUT_COMMAND_V1,
    idempotencyKey: "neutral-command-onetime-1",
    mode: "one_time",
    lines: [{ sku: "REFILL-01", quantity: 2 }],
    customer: { firstName: "Alex", lastName: "Example", email: "alex@example.test", phone },
    shippingAddress: { street: "12 Market Street", postalCode: "10001", city: "Example City", country },
    currency: COMMERCE_CURRENCIES[0],
  };
}

/** The RPC is called as `rpc(name, { p_intent })`, so the payload is arg 2. */
function sentIntent(rpc: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = rpc.mock.calls as Array<[string, { p_intent: Record<string, unknown> }]>;
  return calls[0][1].p_intent;
}

function sentPhone(rpc: ReturnType<typeof vi.fn>, holder: "contact" | "customer") {
  return (sentIntent(rpc)[holder] as { phone?: string }).phone;
}

describe("supabaseConfiguratorIntentPersistencePort — phone canonicalization at the write", () => {
  it("canonicalizes a bare national number on the configurator intent", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistIntent(intentWithPhone("123456789"));

    expect(sentPhone(rpc, "contact")).toBe("+99123456789");
  });

  it("leaves an already-canonical number byte-for-byte", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistIntent(intentWithPhone("+99123456789"));

    expect(sentPhone(rpc, "contact")).toBe("+99123456789");
  });

  // Fail-open is the safety property, not a nicety: `normalizePhoneToE164` parses
  // with `extract: false`, so an annotated number returns null. Storing that null
  // (or a blank) would make the order undispatchable downstream, so the raw value
  // must reach the RPC untouched.
  it("passes an unparsable number through untouched", async () => {
    const { client, rpc } = rpcClient();
    const raw = "123456789 (call after hours)";
    await portFor(client).persistIntent(intentWithPhone(raw));

    expect(sentPhone(rpc, "contact")).toBe(raw);
  });

  it("does not rewrite any other field of the intent", async () => {
    const { client, rpc } = rpcClient();
    const request = intentWithPhone("123456789");
    await portFor(client).persistIntent(request);

    // The stamp below is the one field this port adds on purpose; naming it here
    // keeps the assertion exact, so nothing else can start being rewritten quietly.
    expect(sentIntent(rpc)).toEqual({
      ...(request as unknown as Record<string, unknown>),
      contact: { ...(request as unknown as { contact: object }).contact, phone: "+99123456789" },
      authenticatedUserId: null,
    });
  });

  it("canonicalizes the neutral checkout command against its shipping country", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistCheckoutCommand(commandWithPhone("2025550123", "AA"));

    expect(sentPhone(rpc, "customer")).toBe("+992025550123");
  });

  it("passes an unparsable checkout-command number through untouched", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistCheckoutCommand(commandWithPhone("2025550123 or 555-0199", "AA"));

    expect(sentPhone(rpc, "customer")).toBe("2025550123 or 555-0199");
  });

  // The injected normalizer decides whether an extension is recognized.
  // The store forwards its result and preserves rejected formats verbatim.
  it("forwards the injected normalization of a recognized extension", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistIntent(intentWithPhone("123456789 ext 4"));

    expect(sentPhone(rpc, "contact")).toBe("+99123456789");
  });

  it("preserves an unrecognized extension annotation verbatim", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistIntent(intentWithPhone("123456789 local-ext. 12"));

    expect(sentPhone(rpc, "contact")).toBe("123456789 local-ext. 12");
  });

  it("tolerates a payload with no contact block at all", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistIntent({ version: CONFIGURATOR_INTENT_VERSION, idempotencyKey: "no-contact-1" } as never);

    expect(sentIntent(rpc)).toEqual({
      version: CONFIGURATOR_INTENT_VERSION,
      idempotencyKey: "no-contact-1",
      authenticatedUserId: null,
    });
  });
});

describe("supabaseConfiguratorIntentPersistencePort — the verified subject", () => {
  it("sends null when the route proved nobody, and that is a positive claim", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client).persistIntent(intentWithPhone("+99123456789"));

    expect(sentIntent(rpc)).toMatchObject({ authenticatedUserId: null });
  });

  it("sends the subject the route verified", async () => {
    const { client, rpc } = rpcClient();
    await createSupabaseConfiguratorIntentPersistencePort(client, {
      authenticatedUserId: "7a000000-0000-4000-8000-0000000000a1",
    }).persistIntent(intentWithPhone("+99123456789"));

    expect(sentIntent(rpc)).toMatchObject({
      authenticatedUserId: "7a000000-0000-4000-8000-0000000000a1",
    });
  });

  // ⛔ The whole security property in one assertion. The RPC resolves its client
  // row by the e-mail in this payload, so if a caller could also put the subject
  // in the payload, knowing a mailbox would again be enough to rewrite the record
  // it names. The stamp is written last and unconditionally.
  it("discards a subject the caller put in the body", async () => {
    const { client, rpc } = rpcClient();
    const forged = {
      ...(intentWithPhone("+99123456789") as unknown as Record<string, unknown>),
      authenticatedUserId: "7a000000-0000-4000-8000-0000000000ff",
    };

    await portFor(client).persistIntent(forged as never);

    expect(sentIntent(rpc)).toMatchObject({ authenticatedUserId: null });
  });
});

describe("supabaseConfiguratorIntentPersistencePort — persistIntent error mapping", () => {
  it("maps a nullable legacy subject response into the neutral persistence result", async () => {
    const client = asClient({
      rpc: vi.fn(async () => ({
        data: { ...completedPayload(), intentVersion: CHECKOUT_COMMAND_V1, subjectId: null },
        error: null,
      })),
    });
    const port = portFor(client);

    await expect(port.persistCheckoutCommand({
      version: CHECKOUT_COMMAND_V1,
      idempotencyKey: "neutral-command-subscription-1",
      mode: "subscription",
      lines: [{ sku: "REFILL-01", quantity: 2 }],
      customer: { firstName: "Alex", lastName: "Example", email: "alex@example.test", phone: "+992025550123" },
      shippingAddress: { street: "12 Market Street", postalCode: "10001", city: "Example City", country: "AA" },
      currency: COMMERCE_CURRENCIES[0],
      cadenceDays: 21,
    })).resolves.toEqual({
      idempotencyKey: "intent-1999-06-05-example",
      clientId: CLIENT_ID,
      subjectId: null,
      shippingAddressId: ADDRESS_ID,
      replayed: false,
    });
  });

  it("accepts the deployed v1 RPC response for a new marker-authored request", async () => {
    const persisted = completedPayload();
    const client = asClient({
      rpc: vi.fn(async () => ({ data: persisted, error: null })),
    });
    const port = portFor(client);

    await expect(port.persistIntent({
      version: CONFIGURATOR_INTENT_VERSION,
      cadencePolicyVersion: "synthetic-cadence.v1",
      cadenceDays: 21,
      idempotencyKey: persisted.idempotencyKey,
    } as never)).resolves.toEqual(persisted);
  });

  it("maps a 23505 RPC error to a ConfiguratorIntentPersistenceConflictError", async () => {
    const client = asClient({
      rpc: vi.fn(async () => ({ data: null, error: { code: "23505", message: "conflict" } })),
    });
    const port = portFor(client);

    await expect(
      port.persistIntent({ idempotencyKey: "x" } as never),
    ).rejects.toBeInstanceOf(ConfiguratorIntentPersistenceConflictError);
  });
});

it("stamps verified identity last for commands as well as intents", async () => {
  const { client, rpc } = rpcClient();
  const forged = { ...commandWithPhone("123456789", "AA"), authenticatedUserId: "forged" };
  await createSupabaseConfiguratorIntentPersistencePort(client, { authenticatedUserId: CLIENT_ID }).persistCheckoutCommand(forged);
  expect(sentIntent(rpc).authenticatedUserId).toBe(CLIENT_ID);
  expect(Object.keys(sentIntent(rpc)).at(-1)).toBe("authenticatedUserId");
  expect(sentPhone(rpc, "customer")).toBe("+99123456789");
});

import { createSupabaseConfiguratorIntentPersistencePort as createGenericPersistence } from "../../src/commerce/server/index.js";
import { persistenceBindings } from "./storeTestFixtures.js";
it("injects the host phone/country normalizer before stamping route identity", async () => {
  const { client, rpc } = rpcClient();
  const normalizePhoneToE164 = vi.fn(() => "+99123456789");
  const port = createGenericPersistence(client, { ...persistenceBindings, normalizePhoneToE164 }, { authenticatedUserId: CLIENT_ID });
  const request = { contact: { phone: "123456789", opaque: true }, address: { country: "AA" }, authenticatedUserId: "forged", opaque: { untouched: true } };
  await port.persistIntent(request);
  expect(normalizePhoneToE164).toHaveBeenCalledExactlyOnceWith("123456789", "AA");
  expect(sentIntent(rpc)).toEqual({ ...request, contact: { phone: "+99123456789", opaque: true }, authenticatedUserId: CLIENT_ID });
});
