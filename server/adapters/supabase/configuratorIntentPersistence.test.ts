import { describe, expect, it, vi } from "vitest";
import {
  CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
  CONFIGURATOR_INTENT_VERSION,
} from "../../../src/domains/commerce/configuratorIntentContracts.js";
import {
  CHECKOUT_COMMAND_V1,
  type CheckoutCommandV1,
} from "../../../src/domains/commerce/checkoutCommandContracts.js";
import { COMMERCE_CURRENCIES } from "../../../src/domains/commerce/types.js";
import {
  createSupabaseConfiguratorIntentPersistencePort,
  type ConfiguratorIntentSupabaseClient,
} from "./configuratorIntentPersistence.js";
import { ConfiguratorIntentPersistenceConflictError } from "../../domains/commerce/configuratorIntentPersistenceHandler.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
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
    idempotencyKey: "intent-2026-06-05-rex",
    clientId: CLIENT_ID,
    petId: PET_ID,
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

    const identity = await port.findCompletedIdentity!("intent-2026-06-05-rex");

    expect(from).toHaveBeenCalledWith("commerce_idempotency_keys");
    expect(builder.eq).toHaveBeenCalledWith("scope", "commerce_configurator_intent");
    expect(builder.eq).toHaveBeenCalledWith("idempotency_key", "intent-2026-06-05-rex");
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

    expect(await port.findCompletedIdentity!("intent-2026-06-05-rex")).toBeNull();
  });

  it("throws on a transport error so the caller can fail-safe to 409", async () => {
    const { client } = selectClient({ data: null, error: { message: "boom" } });
    const port = portFor(client);

    await expect(port.findCompletedIdentity!("intent-2026-06-05-rex")).rejects.toThrow(/boom/);
  });
});

function rpcClient() {
  const rpc = vi.fn(async () => ({ data: completedPayload(), error: null }));
  return { client: asClient({ rpc }), rpc };
}

function intentWithPhone(phone: string) {
  return {
    version: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-2026-06-05-rex",
    contact: { firstName: "Anna", lastName: "Nowak", email: "anna@example.test", phone },
    address: { street: "Testowa 1", postalCode: "00-001", city: "Warszawa", country: "PL" },
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
      .persistIntent(intentWithPhone("507231665"));

    expect(sentPhone(rpc, "contact")).toBe("+48507231665");
  });

  it("leaves an already-canonical number byte-for-byte", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistIntent(intentWithPhone("+48507231665"));

    expect(sentPhone(rpc, "contact")).toBe("+48507231665");
  });

  // Fail-open is the safety property, not a nicety: `normalizePhoneToE164` parses
  // with `extract: false`, so an annotated number returns null. Storing that null
  // (or a blank) would make the order undispatchable downstream, so the raw value
  // must reach the RPC untouched.
  it("passes an unparsable number through untouched", async () => {
    const { client, rpc } = rpcClient();
    const raw = "507231665 (dzwonic po 18)";
    await portFor(client).persistIntent(intentWithPhone(raw));

    expect(sentPhone(rpc, "contact")).toBe(raw);
  });

  it("does not rewrite any other field of the intent", async () => {
    const { client, rpc } = rpcClient();
    const request = intentWithPhone("507231665");
    await portFor(client).persistIntent(request);

    // The stamp below is the one field this port adds on purpose; naming it here
    // keeps the assertion exact, so nothing else can start being rewritten quietly.
    expect(sentIntent(rpc)).toEqual({
      ...(request as unknown as Record<string, unknown>),
      contact: { ...(request as unknown as { contact: object }).contact, phone: "+48507231665" },
      authenticatedUserId: null,
    });
  });

  it("canonicalizes the neutral checkout command against its shipping country", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistCheckoutCommand(commandWithPhone("2025550123", "US"));

    expect(sentPhone(rpc, "customer")).toBe("+12025550123");
  });

  it("passes an unparsable checkout-command number through untouched", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistCheckoutCommand(commandWithPhone("2025550123 or 555-0199", "US"));

    expect(sentPhone(rpc, "customer")).toBe("2025550123 or 555-0199");
  });

  // Characterization of an accepted trade-off, not an aspiration. The shared
  // canonical helper recognizes the English `ext` extension syntax and E.164 has
  // no room for an extension, so canonicalizing drops it. Every other form in the
  // app (address step, account profile) has behaved this way for as long as it has
  // used the canonical helper; diverging here would mean a second, contradictory
  // phone semantics. The local-language variant (`wew.`) does not parse at all and
  // is therefore preserved verbatim by the fail-open rule above.
  it("drops a recognized English extension, matching the shared canonical helper", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistIntent(intentWithPhone("507231665 ext 4"));

    expect(sentPhone(rpc, "contact")).toBe("+48507231665");
  });

  it("preserves a local-language extension annotation verbatim", async () => {
    const { client, rpc } = rpcClient();
    await portFor(client)
      .persistIntent(intentWithPhone("507231665 wew. 12"));

    expect(sentPhone(rpc, "contact")).toBe("507231665 wew. 12");
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
    await portFor(client).persistIntent(intentWithPhone("+48507231665"));

    expect(sentIntent(rpc)).toMatchObject({ authenticatedUserId: null });
  });

  it("sends the subject the route verified", async () => {
    const { client, rpc } = rpcClient();
    await createSupabaseConfiguratorIntentPersistencePort(client, {
      authenticatedUserId: "7a000000-0000-4000-8000-0000000000a1",
    }).persistIntent(intentWithPhone("+48507231665"));

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
      ...(intentWithPhone("+48507231665") as unknown as Record<string, unknown>),
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
        data: { ...completedPayload(), intentVersion: CHECKOUT_COMMAND_V1, petId: null },
        error: null,
      })),
    });
    const port = portFor(client);

    await expect(port.persistCheckoutCommand({
      version: CHECKOUT_COMMAND_V1,
      idempotencyKey: "neutral-command-subscription-1",
      mode: "subscription",
      lines: [{ sku: "REFILL-01", quantity: 2 }],
      customer: { firstName: "Alex", lastName: "Example", email: "alex@example.test", phone: "+12025550123" },
      shippingAddress: { street: "12 Market Street", postalCode: "10001", city: "Example City", country: "US" },
      currency: COMMERCE_CURRENCIES[0],
      cadenceDays: 21,
    })).resolves.toEqual({
      idempotencyKey: "intent-2026-06-05-rex",
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
      cadencePolicyVersion: CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
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
